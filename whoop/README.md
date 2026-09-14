# Whoop MCP server

A single-file MCP server that reads your Whoop data straight from the Whoop API. No database, nothing stored except a refresh token in `.whoop_refresh` next to the script.

Tools:

- `today` — latest recovery score, HRV, resting heart rate, sleep performance, sleep debt (minutes) and strain, each with its time.
- `history` — one of those metrics, day by day for the last N days, oldest first.

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

Refresh tokens are single use, so the server rotates the file every time it refreshes. Do not copy `.whoop_refresh` between machines; run `login` on each one instead.

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
