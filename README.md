# Garmin Connect Workouts MCP

[![garmin-connect-workouts-mcp MCP server](https://glama.ai/mcp/servers/slaat/garmin-connect-workouts-mcp/badges/score.svg)](https://glama.ai/mcp/servers/slaat/garmin-connect-workouts-mcp)

[![garmin-connect-workouts-mcp MCP server](https://glama.ai/mcp/servers/slaat/garmin-connect-workouts-mcp/badges/card.svg)](https://glama.ai/mcp/servers/slaat/garmin-connect-workouts-mcp)

An MCP (Model Context Protocol) server that turns natural-language workout
descriptions into structured workouts in Garmin Connect. Describe a session
in plain English and the calling model builds a typed step-by-step workout
that this server encodes into Garmin's workout API format and creates
directly in your account.

## Features

- **Pace, heart-rate, power and cadence targets** - pace ranges, HR zones 1-5,
  explicit bpm ranges, cycling power, and cadence, all encoded against
  Garmin's real `workoutTargetType` table.
- **Real repeat blocks** - `5x1km` becomes a single repeat group, not five
  duplicated steps, so the watch shows an actual rep counter.
- **Swim workouts** - per-step strokes (freestyle, backstroke, breaststroke,
  fly, drill, individual medley, or any stroke) and equipment (fins,
  kickboard, paddles, pull buoy, snorkel), plus a workout-level pool length
  in meters or yards.
- **Full workout lifecycle** - create, list, get, update, delete, and
  schedule workouts onto the Garmin Connect calendar.
- **Structured input, not text parsing** - the server never parses free text
  itself; every duration and target is an explicit, unit-tagged field, so
  there's nothing for a string like "10 min" to be silently misread as.

## Quick Start

### Claude Code

```bash
claude mcp add garmin-workouts npx garmin-connect-workouts-mcp
```

### Claude Desktop

Add to your configuration file:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "garmin-workouts": {
      "command": "npx",
      "args": ["-y", "garmin-connect-workouts-mcp"]
    }
  }
}
```

Then restart Claude Desktop.

## Authentication

Garmin Connect's web client authenticates with session cookies plus a CSRF
token, not a password grant this server could hold on to. So the first time
you create a workout (or whenever the session has expired):

1. The server checks the stored session with a cheap authenticated request.
2. If it's missing or rejected, run the `authenticate_garmin` tool. It opens
   a real browser window at `connect.garmin.com` for you to log in normally.
3. Once login completes, the session is captured and stored at
   `~/.config/garmin-connect-workouts-mcp/auth.json` with `600` permissions
   (owner read/write only).

No password is ever stored - only the resulting session cookies and CSRF
token. Garmin sessions expire, so you may be prompted to re-authenticate
between sessions; the server detects this automatically and tells you when
to run `authenticate_garmin` again. The login browser uses a persistent,
isolated profile under `~/.config/garmin-connect-workouts-mcp/browser-profile/`
so Garmin can remember the device across logins - it never touches your
personal browser profile.

## Tools

| Tool | Description |
|---|---|
| `create_garmin_workout` | Create a structured workout with steps, targets, and repeat blocks. |
| `list_garmin_workouts` | List workouts in the Garmin Connect account. |
| `get_garmin_workout` | Fetch the full structure of one workout. |
| `update_garmin_workout` | Replace an existing workout's contents, keeping its id. |
| `delete_garmin_workout` | Delete a workout. |
| `schedule_garmin_workout` | Put a workout on the Garmin Connect calendar for a date. |
| `check_garmin_auth` | Check whether the stored Garmin session still works. |
| `authenticate_garmin` | Authenticate with Garmin Connect (opens a browser). |

## Usage Examples

- "Create a 30 minute easy run in zone 2"
- "10 min warmup zone 3, then 5x1km threshold intervals at 4:00/km with 2 min
  rest between, then 10 min cooldown zone 2"
- "8x400m at 5k pace with 60 second recovery, then check what workouts I
  already have scheduled this week"
- "Update workout 123456 to add a 5 minute cooldown, then schedule it for
  next Monday"
- "Create a 25m pool swim: 200m warmup any stroke, 4x100m freestyle with 30s
  rest using a kickboard, 100m breaststroke cooldown"

## How targets work

A stated pace is treated as the **fast edge** of a range: Garmin stores pace
as a range, not a single point, so `4:00/km` on its own becomes a
`4:00-4:10/km` range, widened by 10 seconds. Give both `fast` and `slow`
explicitly for a narrower or different range.

## Development

```bash
pnpm install
pnpm test          # vitest: encoders + golden-file tests against real captured payloads
pnpm run build      # compile TypeScript to dist/
pnpm run dev        # run the server directly with tsx
```

Tests validate the workout encoders (targets, durations, repeat nesting)
against fixtures captured from Garmin's own web client, so payload shape
regressions get caught before they reach a real account.

## Disclaimer

This is an unofficial, third-party project. It is not affiliated with,
endorsed by, or sponsored by Garmin Ltd. or any of its affiliates, and it
talks to Garmin Connect's web API by reverse-engineering the same requests
the official web client makes. It may stop working if Garmin changes that
API. Use at your own risk, and at your own responsibility for the workouts
and data you send to your account.

## Acknowledgements

Thanks to [garmin-workouts-mcp](https://github.com/charlesfrisbee/garmin-workouts-mcp)
by Charles Frisbee for the original idea of driving Garmin Connect workouts
through MCP.

## License

MIT
