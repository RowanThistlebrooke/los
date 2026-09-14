# Whoop MCP server

A single-file MCP server that reads your Whoop data straight from the Whoop API. No database, nothing stored except a refresh token in `.whoop_refresh` next to the script.

Tools:

- `today` — latest recovery score, HRV, resting heart rate, sleep performance, sleep debt (minutes) and strain, each with its time.
- `history` — one of those metrics, day by day for the last N days, oldest first.

Commands:

- `node whoop.mjs login` — one-time browser login.
- `node whoop.mjs push` — copy the last 14 days of readings into your Supabase `events` table (see [Push](#push-to-supabase)).
- `node whoop.mjs` — the MCP server.

## 1. The app

1. Go to <https://developer.whoop.com/> and open the developer dashboard.
2. Create an app. Set the redirect URL to exactly `http://localhost:8765/callback`.
3. Enable these scopes: `read:recovery`, `read:cycles`, `read:sleep`, `read:workout`, `read:profile`, `read:body_measurement`, `offline`.
4. Copy the Client ID and Client Secret.

## 2. The file

Put this `whoop` folder somewhere permanent and install its two dependencies:

```sh
cd whoop
npm install
```

Give the server your app credentials as environment variables:

```sh
export WHOOP_CLIENT_ID=your_client_id
export WHOOP_CLIENT_SECRET=your_client_secret
```

## 3. The login

```sh
node whoop.mjs login
```

A browser tab opens on Whoop. Approve the app. The script receives the callback, exchanges the code, writes the refresh token to `.whoop_refresh` and prints `logged in`. It never prints a token.

Refresh tokens are single use, so the server rotates the file every time it refreshes. Refreshes are serialised through `.whoop_refresh.lock`, so several copies of the server can share one login. Do not copy `.whoop_refresh` between machines; run `login` on each one instead.

## 4. The config

Claude Code:

```sh
claude mcp add whoop -e WHOOP_CLIENT_ID=your_client_id -e WHOOP_CLIENT_SECRET=your_client_secret -- node /absolute/path/to/whoop/whoop.mjs
```

Claude Desktop (`claude_desktop_config.json`) or any other MCP client:

```json
{
  "mcpServers": {
    "whoop": {
      "command": "node",
      "args": ["/absolute/path/to/whoop/whoop.mjs"],
      "env": {
        "WHOOP_CLIENT_ID": "your_client_id",
        "WHOOP_CLIENT_SECRET": "your_client_secret"
      }
    }
  }
}
```

## 5. Ask

Restart the client and ask:

- "What's my Whoop recovery today?"
- "Show my HRV for the last 14 days."
- "How has my strain trended over the past month?"

`history` accepts `metric` (one of `recovery_score`, `hrv_rmssd_milli`, `resting_heart_rate`, `sleep_performance_percentage`, `need_from_sleep_debt_milli`, `strain`) and `days` (1 to 365). Sleep debt is returned in minutes.

## Push to Supabase

`push` reads the last 14 days of recovery, sleep and cycles from Whoop and inserts one row per reading into the `events` table. It signs in the way a browser page would, with the publishable key plus your email and password, so row-level security applies and rows land under your user.

```sh
export WIRE_URL=https://your-project.supabase.co
export WIRE_KEY=your_publishable_key
export WIRE_EMAIL=you@example.com
export WIRE_PASSWORD=your_password
node whoop.mjs push
```

It prints one line, for example `12 rows landed`. Never a token or password.

Rows it writes:

| metric             | unit    | source_id             | occurred_at      |
| ------------------ | ------- | --------------------- | ---------------- |
| `whoop_recovery`   | %       | `recovery:<cycle id>` | recovery created |
| `whoop_hrv`        | ms      | `recovery:<cycle id>` | recovery created |
| `whoop_rhr`        | bpm     | `recovery:<cycle id>` | recovery created |
| `whoop_sleep_perf` | %       | `sleep:<sleep id>`    | sleep end        |
| `whoop_sleep_debt` | minutes | `sleep:<sleep id>`    | sleep end        |
| `whoop_strain`     | (blank) | `cycle:<cycle id>`    | cycle start      |

`event_type` is always `measurement` and `source` is always `whoop`. Naps are skipped, and so is any `source_id` already present for source `whoop`, so running it every day only adds what is new. It is insert only and never updates or deletes.
