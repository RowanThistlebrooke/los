#!/usr/bin/env node
// Whoop MCP server. Standalone, stdio, talks to the Whoop API directly.
//
//   node whoop.mjs login   -> browser OAuth, saves refresh token to .whoop_refresh
//   node whoop.mjs         -> MCP server (tools: today, history)
//
// Env: WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET. No token is ever printed.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const AUTH_URL = "https://api.prod.whoop.com/oauth/oauth2/auth";
const TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
const API_URL = "https://api.prod.whoop.com/developer/v2";
const REDIRECT_URI = "http://localhost:8765/callback";
const SCOPE =
  "read:recovery read:cycles read:sleep read:workout read:profile read:body_measurement offline";
const REFRESH_FILE = join(dirname(fileURLToPath(import.meta.url)), ".whoop_refresh");
const ACCESS_MAX_AGE_MS = 50 * 60 * 1000;
const PAGE_LIMIT = 25;

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
    throw new Error(`Whoop token request failed (${code}${desc})`);
  }
  return body;
}

let accessToken = null;
let accessObtainedAt = 0;
let refreshing = null;

async function getAccessToken() {
  requireCreds();
  if (accessToken && Date.now() - accessObtainedAt < ACCESS_MAX_AGE_MS) return accessToken;
  // Refresh tokens are single use, so serialise concurrent refreshes.
  if (!refreshing) {
    refreshing = (async () => {
      const refreshToken = await readRefreshToken();
      const body = await tokenRequest({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        scope: "offline",
      });
      if (body.refresh_token) await saveRefreshToken(body.refresh_token);
      accessToken = body.access_token;
      accessObtainedAt = Date.now();
      return accessToken;
    })().finally(() => {
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

// Normalise a Whoop record into flat readings keyed by metric name, plus a time.
function readingsFrom(source, r) {
  if (source === "recovery") {
    return {
      time: r.created_at,
      recovery_score: r.score.recovery_score,
      hrv_rmssd_milli: r.score.hrv_rmssd_milli,
      resting_heart_rate: r.score.resting_heart_rate,
    };
  }
  if (source === "sleep") {
    const debt = r.score.sleep_needed?.need_from_sleep_debt_milli;
    return {
      time: r.end,
      sleep_performance_percentage: r.score.sleep_performance_percentage,
      need_from_sleep_debt_milli: debt == null ? null : Math.round(debt / 60000),
    };
  }
  return { time: r.start, strain: r.score.strain };
}

function latestOf(source, records) {
  const pool = source === "sleep" ? records.filter(notNap) : records;
  const r = pool.find(scored);
  return r ? readingsFrom(source, r) : null;
}

// ---------- tools ----------

async function today() {
  const [recovery, sleep, cycle] = await Promise.all([
    fetchLatest("recovery"),
    fetchLatest("activity/sleep"),
    fetchLatest("cycle"),
  ]);
  const rec = latestOf("recovery", recovery);
  const slp = latestOf("sleep", sleep);
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
  const path = source === "sleep" ? "activity/sleep" : source;
  const start = new Date(Date.now() - days * 86400000).toISOString();
  let records = await fetchAll(path, start);
  if (source === "sleep") records = records.filter(notNap);
  const readings = records
    .filter(scored)
    .map((r) => readingsFrom(source, r))
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

if (process.argv[2] === "login") {
  login().then(
    () => process.exit(0),
    (e) => {
      console.error(e.message || e);
      process.exit(1);
    },
  );
} else {
  runServer().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
