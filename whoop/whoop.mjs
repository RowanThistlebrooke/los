#!/usr/bin/env node
// Whoop MCP server. Standalone, stdio, talks to the Whoop API directly.
//
//   node whoop.mjs login   -> browser OAuth, saves refresh token to .whoop_refresh
//   node whoop.mjs push    -> copy the last 14 days of readings into the Supabase events table
//   node whoop.mjs         -> MCP server (tools: today, history)
//
// Env: WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET.
// push also needs: WIRE_URL, WIRE_KEY, WIRE_EMAIL, WIRE_PASSWORD.
// No token or password is ever printed.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const AUTH_URL = "https://api.prod.whoop.com/oauth/oauth2/auth";
const TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
const API_URL = "https://api.prod.whoop.com/developer/v2";
const REDIRECT_URI = "http://localhost:8765/callback";
const SCOPE =
  "read:recovery read:cycles read:sleep read:workout read:profile read:body_measurement offline";
const HERE = dirname(fileURLToPath(import.meta.url));
const REFRESH_FILE = join(HERE, ".whoop_refresh");
const LOCK_FILE = join(HERE, ".whoop_refresh.lock");
const ACCESS_MAX_AGE_MS = 50 * 60 * 1000;
const LOCK_STALE_MS = 30 * 1000;
const LOCK_WAIT_MS = 15 * 1000;
const PAGE_LIMIT = 25;
const PUSH_DAYS = 14;

const CLIENT_ID = process.env.WHOOP_CLIENT_ID;
const CLIENT_SECRET = process.env.WHOOP_CLIENT_SECRET;

const METRICS = {
  recovery_score: { source: "recovery" },
  hrv_rmssd_milli: { source: "recovery" },
  resting_heart_rate: { source: "recovery" },
  sleep_performance_percentage: { source: "sleep" },
  need_from_sleep_debt_milli: { source: "sleep", unit: "minutes" },
  strain: { source: "cycle" },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- token handling ----------

function requireCreds() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET must be set in the environment");
  }
}

async function readRefreshToken() {
  try {
    const t = (await readFile(REFRESH_FILE, "utf8")).trim();
    if (!t) throw new Error("empty");
    return t;
  } catch {
    throw new Error(`No refresh token found. Run: node whoop.mjs login`);
  }
}

async function saveRefreshToken(token) {
  await writeFile(REFRESH_FILE, token + "\n", { mode: 0o600 });
}

// Cross-process lock so two copies of the server never refresh at the same moment.
// A lock older than LOCK_STALE_MS is treated as left behind by a dead process.
async function withRefreshLock(fn) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fh = await open(LOCK_FILE, "wx");
      await fh.writeFile(String(process.pid));
      await fh.close();
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        const st = await stat(LOCK_FILE);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await unlink(LOCK_FILE).catch(() => {});
          continue;
        }
      } catch {}
      if (Date.now() > deadline) {
        throw new Error("timed out waiting for another whoop process to finish refreshing");
      }
      await sleep(100 + Math.random() * 150);
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(LOCK_FILE).catch(() => {});
  }
}

// Only surface the OAuth error code, never the response body wholesale.
async function tokenRequest(params) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
  });
  let body = {};
  try {
    body = await res.json();
  } catch {}
  if (!res.ok || !body.access_token) {
    const code = body.error || `http_${res.status}`;
    const desc = body.error_description ? `: ${body.error_description}` : "";
    const err = new Error(`Whoop token request failed (${code}${desc})`);
    err.status = res.status;
    err.code = body.error;
    throw err;
  }
  return body;
}

const isRejectedRefresh = (e) => e.status === 401 || e.code === "invalid_grant";

let accessToken = null;
let accessObtainedAt = 0;
let refreshing = null;

async function refreshAccessToken() {
  return withRefreshLock(async () => {
    const refresh = async () =>
      tokenRequest({
        grant_type: "refresh_token",
        refresh_token: await readRefreshToken(),
        scope: "offline",
      });
    let body;
    try {
      body = await refresh();
    } catch (e) {
      if (!isRejectedRefresh(e)) throw e;
      // Another process may have rotated the token since we read it.
      // Re-read the file from disk and retry exactly once.
      body = await refresh();
    }
    if (body.refresh_token) await saveRefreshToken(body.refresh_token);
    accessToken = body.access_token;
    accessObtainedAt = Date.now();
    return accessToken;
  });
}

async function getAccessToken() {
  requireCreds();
  if (accessToken && Date.now() - accessObtainedAt < ACCESS_MAX_AGE_MS) return accessToken;
  // Refresh tokens are single use, so serialise concurrent refreshes within this process too.
  if (!refreshing) {
    refreshing = refreshAccessToken().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

// ---------- Whoop API ----------

async function apiGet(path, query) {
  const token = await getAccessToken();
  const url = new URL(`${API_URL}/${path}`);
  for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Whoop API ${path} returned HTTP ${res.status}`);
  return res.json();
}

// Fetch every record since `start` (newest first, as Whoop returns them).
async function fetchAll(path, start) {
  const records = [];
  let nextToken;
  do {
    const page = await apiGet(path, { start, limit: PAGE_LIMIT, nextToken });
    records.push(...(page.records || []));
    nextToken = page.next_token || undefined;
  } while (nextToken);
  return records;
}

async function fetchLatest(path) {
  const page = await apiGet(path, { limit: PAGE_LIMIT });
  return page.records || [];
}

const scored = (r) => r.score_state === "SCORED" && r.score;
const notNap = (r) => !r.nap;
const pathFor = (source) => (source === "sleep" ? "activity/sleep" : source);

// Normalise a Whoop record into flat readings keyed by metric name, plus a time and id.
function readingsFrom(source, r) {
  if (source === "recovery") {
    return {
      id: r.cycle_id,
      time: r.created_at,
      recovery_score: r.score.recovery_score,
      hrv_rmssd_milli: r.score.hrv_rmssd_milli,
      resting_heart_rate: r.score.resting_heart_rate,
    };
  }
  if (source === "sleep") {
    const debt = r.score.sleep_needed?.need_from_sleep_debt_milli;
    return {
      id: r.id,
      time: r.end,
      sleep_performance_percentage: r.score.sleep_performance_percentage,
      need_from_sleep_debt_milli: debt == null ? null : Math.round(debt / 60000),
    };
  }
  return { id: r.id, time: r.start, strain: r.score.strain };
}

function latestOf(source, records) {
  const pool = source === "sleep" ? records.filter(notNap) : records;
  const r = pool.find(scored);
  return r ? readingsFrom(source, r) : null;
}

async function fetchReadings(source, days) {
  const start = new Date(Date.now() - days * 86400000).toISOString();
  let records = await fetchAll(pathFor(source), start);
  if (source === "sleep") records = records.filter(notNap);
  return records.filter(scored).map((r) => readingsFrom(source, r));
}

// ---------- tools ----------

async function today() {
  const [recovery, sleepRecs, cycle] = await Promise.all([
    fetchLatest("recovery"),
    fetchLatest("activity/sleep"),
    fetchLatest("cycle"),
  ]);
  const rec = latestOf("recovery", recovery);
  const slp = latestOf("sleep", sleepRecs);
  const cyc = latestOf("cycle", cycle);
  const pick = (obj, key, extra = {}) =>
    obj ? { value: obj[key], time: obj.time, ...extra } : null;
  return {
    recovery_score: pick(rec, "recovery_score"),
    hrv_rmssd_milli: pick(rec, "hrv_rmssd_milli"),
    resting_heart_rate: pick(rec, "resting_heart_rate"),
    sleep_performance_percentage: pick(slp, "sleep_performance_percentage"),
    need_from_sleep_debt_milli: pick(slp, "need_from_sleep_debt_milli", { unit: "minutes" }),
    strain: pick(cyc, "strain"),
  };
}

async function history(metric, days) {
  const { source, unit } = METRICS[metric];
  const readings = (await fetchReadings(source, days))
    .map((x) => ({ time: x.time, value: x[metric] }))
    .filter((x) => x.value != null)
    .sort((a, b) => new Date(a.time) - new Date(b.time));
  return { metric, days, ...(unit ? { unit } : {}), readings };
}

const asText = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
const asError = (err) => ({ content: [{ type: "text", text: String(err.message || err) }], isError: true });

async function runServer() {
  const server = new McpServer({ name: "whoop", version: "1.0.0" });

  server.registerTool(
    "today",
    {
      description:
        "Latest Whoop readings: recovery_score, hrv_rmssd_milli, resting_heart_rate, " +
        "sleep_performance_percentage, need_from_sleep_debt_milli (in minutes) and strain, each with its time.",
      inputSchema: {},
    },
    async () => {
      try {
        return asText(await today());
      } catch (e) {
        return asError(e);
      }
    },
  );

  server.registerTool(
    "history",
    {
      description: "Day by day readings of one Whoop metric over the last N days, oldest first.",
      inputSchema: {
        metric: z.enum(Object.keys(METRICS)).describe("Which metric to return"),
        days: z.number().int().min(1).max(365).describe("How many days back to look"),
      },
    },
    async ({ metric, days }) => {
      try {
        return asText(await history(metric, days));
      } catch (e) {
        return asError(e);
      }
    },
  );

  await server.connect(new StdioServerTransport());
}

// ---------- push (Whoop -> Supabase events table) ----------

// How each Whoop reading maps onto an events row.
const PUSH_ROWS = {
  recovery: [
    { key: "recovery_score", metric: "whoop_recovery", unit: "%" },
    { key: "hrv_rmssd_milli", metric: "whoop_hrv", unit: "ms" },
    { key: "resting_heart_rate", metric: "whoop_rhr", unit: "bpm" },
  ],
  sleep: [
    { key: "sleep_performance_percentage", metric: "whoop_sleep_perf", unit: "%" },
    { key: "need_from_sleep_debt_milli", metric: "whoop_sleep_debt", unit: "minutes" },
  ],
  cycle: [{ key: "strain", metric: "whoop_strain", unit: "" }],
};

export function buildEventRows(readingsBySource) {
  const rows = [];
  for (const [source, readings] of Object.entries(readingsBySource)) {
    for (const r of readings) {
      for (const m of PUSH_ROWS[source]) {
        if (r[m.key] == null) continue;
        rows.push({
          event_type: "measurement",
          metric: m.metric,
          value: r[m.key],
          unit: m.unit,
          source: "whoop",
          source_id: `${source}:${r.id}`,
          occurred_at: r.time,
        });
      }
    }
  }
  return rows;
}

function wireConfig() {
  const url = (process.env.WIRE_URL || "").replace(/\/+$/, "");
  const key = process.env.WIRE_KEY;
  const email = process.env.WIRE_EMAIL;
  const password = process.env.WIRE_PASSWORD;
  if (!url || !key || !email || !password) {
    throw new Error("WIRE_URL, WIRE_KEY, WIRE_EMAIL and WIRE_PASSWORD must be set in the environment");
  }
  return { url, key, email, password };
}

// Surface only Supabase's error code/message fields, never the whole body.
async function wireError(what, res) {
  let body = {};
  try {
    body = await res.json();
  } catch {}
  const detail = body.error_code || body.code || body.error || body.msg || body.message || `http_${res.status}`;
  return new Error(`${what} failed (${detail})`);
}

// Sign in the way a browser page would: publishable key + email/password.
export async function wireSignIn({ url, key, email, password }) {
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw await wireError("Supabase sign-in", res);
  const body = await res.json();
  if (!body.access_token) throw new Error("Supabase sign-in failed (no access token returned)");
  return {
    apikey: key,
    Authorization: `Bearer ${body.access_token}`,
    "Content-Type": "application/json",
  };
}

// Which of these source_ids already exist for source=whoop (only this user's rows are visible).
export async function wireExistingSourceIds(url, headers, sourceIds) {
  const existing = new Set();
  for (let i = 0; i < sourceIds.length; i += 50) {
    const chunk = sourceIds.slice(i, i + 50);
    const q = new URL(`${url}/rest/v1/events`);
    q.searchParams.set("select", "source_id");
    q.searchParams.set("source", "eq.whoop");
    q.searchParams.set("source_id", `in.(${chunk.map((s) => `"${s}"`).join(",")})`);
    const res = await fetch(q, { headers });
    if (!res.ok) throw await wireError("Supabase read", res);
    for (const row of await res.json()) existing.add(row.source_id);
  }
  return existing;
}

// Insert only. Never updates or deletes. Returns how many rows landed.
export async function wireInsert(url, headers, rows) {
  if (rows.length === 0) return 0;
  const res = await fetch(`${url}/rest/v1/events?select=id`, {
    method: "POST",
    headers: { ...headers, Prefer: "return=representation" },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw await wireError("Supabase insert", res);
  return (await res.json()).length;
}

export async function pushRows(rows) {
  const cfg = wireConfig();
  const headers = await wireSignIn(cfg);
  const ids = [...new Set(rows.map((r) => r.source_id))];
  const existing = await wireExistingSourceIds(cfg.url, headers, ids);
  const fresh = rows.filter((r) => !existing.has(r.source_id));
  return wireInsert(cfg.url, headers, fresh);
}

async function push() {
  wireConfig();
  requireCreds();
  const [recovery, sleepRecs, cycle] = await Promise.all([
    fetchReadings("recovery", PUSH_DAYS),
    fetchReadings("sleep", PUSH_DAYS),
    fetchReadings("cycle", PUSH_DAYS),
  ]);
  const rows = buildEventRows({ recovery, sleep: sleepRecs, cycle });
  const n = await pushRows(rows);
  console.log(`${n} rows landed`);
}

// ---------- login ----------

function openBrowser(url) {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {}
}

async function login() {
  requireCreds();
  const state = randomBytes(16).toString("hex");
  const authUrl = new URL(AUTH_URL);
  authUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    state,
  }).toString();

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://localhost:8765");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const err = url.searchParams.get("error");
      const gotState = url.searchParams.get("state");
      const gotCode = url.searchParams.get("code");
      const finish = (status, msg, result) => {
        res.writeHead(status, { "Content-Type": "text/plain" }).end(msg);
        server.close();
        result instanceof Error ? reject(result) : resolve(result);
      };
      if (err) return finish(400, `Whoop returned: ${err}`, new Error(`authorization failed: ${err}`));
      if (gotState !== state) return finish(400, "State mismatch.", new Error("state mismatch"));
      if (!gotCode) return finish(400, "Missing code.", new Error("missing code"));
      finish(200, "Logged in to Whoop. You can close this tab.", gotCode);
    });
    server.on("error", reject);
    server.listen(8765, "localhost", () => {
      console.log("Opening browser for Whoop login. If it does not open, visit:\n" + authUrl);
      openBrowser(authUrl.toString());
    });
  });

  const body = await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
  });
  if (!body.refresh_token) {
    throw new Error("Whoop did not return a refresh token. Make sure the app has the offline scope.");
  }
  await saveRefreshToken(body.refresh_token);
  console.log("logged in");
}

// ---------- main ----------

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const fail = (e) => {
    console.error(e.message || e);
    process.exit(1);
  };
  const cmd = process.argv[2];
  if (cmd === "login") login().then(() => process.exit(0), fail);
  else if (cmd === "push") push().then(() => process.exit(0), fail);
  else if (cmd) fail(new Error(`unknown command: ${cmd} (use login, push, or no command for the MCP server)`));
  else runServer().catch(fail);
}
