# Garmin Connect Workouts MCP

An MCP (Model Context Protocol) server that turns a structured, natural-
language-derived workout description into a real workout in Garmin Connect.
The calling model does the natural-language parsing; this server accepts
only a typed step model and encodes it into Garmin's workout API format.

## What This Project Does

Exposes 8 MCP tools for the full Garmin Connect workout lifecycle:

- `create_garmin_workout` - build a structured workout (steps, targets, repeat blocks)
- `list_garmin_workouts` - list workouts in the account
- `get_garmin_workout` - fetch one workout's full structure
- `update_garmin_workout` - replace an existing workout's contents
- `delete_garmin_workout` - delete a workout
- `schedule_garmin_workout` - put a workout on the Garmin Connect calendar
- `check_garmin_auth` - probe whether the stored session still works
- `authenticate_garmin` - drive a browser login and capture a new session

## Architecture

```
src/
├── mcp-server.ts           # McpServer setup, zod-validated tool registration
├── garmin-auth.ts          # Browser login, session capture, validity probe
├── garmin/
│   └── client.ts           # HTTP layer: create/list/get/update/delete/schedule
└── workout/
    ├── types.ts            # zod schemas for Duration/Target/Step/WorkoutData,
    │                       # with TS types derived via z.infer (or hand-written
    │                       # for the recursive Step type)
    ├── targets.ts           # Target → targetType + targetValueOne/Two
    ├── duration.ts           # Duration → endCondition + endConditionValue
    └── payload.ts            # WorkoutData → Garmin JSON, incl. repeat nesting

test/
├── fixtures/               # Real payloads captured from Garmin's own web client
├── targets.test.ts
├── duration.test.ts
└── payload.test.ts
```

- **MCP server (`src/mcp-server.ts`)**: uses the SDK's high-level `McpServer`
  and `registerTool`, with zod schemas (from `workout/types.ts`) as input
  schemas. Descriptive `.describe()` text on each field is what the calling
  model reads to construct valid steps - keep it accurate when the encoding
  changes. Handlers are wrapped in a `safe()` helper that formats thrown
  errors as `❌ <message>` text results, matching the format used everywhere
  else in this server rather than the SDK's default `isError` envelope.
- **Auth (`src/garmin-auth.ts`)**: drives a real browser login via Puppeteer
  and captures the resulting session; exports `garminHeaders()`, the minimal
  header set Garmin accepts. The login browser launches with a persistent,
  isolated `userDataDir` at
  `~/.config/garmin-connect-workouts-mcp/browser-profile` (mode `0o700`,
  created on demand) so Garmin's own device-trust cookies survive between
  logins - it is never the user's personal browser profile, and `clearAuth()`
  never deletes it (only `auth.json`).
- **Workout encoding (`src/workout/`)**: pure functions, no I/O. `types.ts`
  defines the accepted shape; `targets.ts` and `duration.ts` encode individual
  fields; `payload.ts` assembles the full Garmin payload including repeat-group
  nesting.
- **API client (`src/garmin/client.ts`)**: thin HTTP wrapper - create, list,
  get, update, delete, schedule.

## Domain Invariants

These are reverse-engineered facts about Garmin's API. Do not "fix" them
without a captured payload proving the correction.

- **Auth is session cookies + CSRF, not a bearer token.** Every request needs
  session cookies, a `Connect-Csrf-Token` header, and `Sec-Fetch-Site:
  same-origin`, sent to `https://connect.garmin.com/gc-api/...`. There is no
  local way to compute session expiry (the `JWT_WEB` cookie is not the real
  credential - a capture has succeeded minutes after that JWT's `exp`), so
  validity is always **probed** with a cheap authenticated GET, never
  computed from a timestamp.
- **401 and 403 both mean the session is gone.** Garmin answers 403 for a
  missing/stale CSRF token as often as it answers 401, so both are treated
  identically as "re-authenticate."
- **Pace targets are ordered descending in m/s, not ascending.** Pace is
  stored as metres/second rounded to 7 decimals. `targetValueOne` is the
  *faster* bound (higher m/s), `targetValueTwo` the slower one - because the
  pair follows *display* order (lower displayed pace = faster), which
  inverts once converted to m/s. Cadence, by contrast, displays as rpm and so
  ascends normally (low, then high).
- **Custom bpm rides on `heart.rate.zone` (id 4), not a separate type.** A
  bpm range and a named zone share `workoutTargetTypeId: 4`; the
  distinguishing feature is `targetValueOne`/`targetValueTwo` bounds instead
  of `zoneNumber`. `power.zone` (id 2) is the one target type NOT yet
  confirmed against a real captured payload - it's inferred from FIT SDK
  ordering and carries an `UNVERIFIED` marker comment in `targets.ts`.
- **Repeat groups are `RepeatGroupDTO`, not flattened steps.** stepType is
  `{6, "repeat"}`, endCondition is `{7, "iterations"}`, `smartRepeat: false`,
  `skipLastRestStep: false`. `stepOrder` is a single counter that runs across
  the whole nesting (parent and children share the sequence); children are
  tagged with their group's `childStepId`.
- **A single stated pace is widened, not sent as a point.** Garmin can't
  store a bare pace target - only a range - so a caller giving just `fast`
  gets `slow` computed as 10 seconds/unit slower.

## Development

```bash
pnpm install
pnpm test          # vitest: encoders + golden-file tests against real captured payloads
pnpm run build      # compile TypeScript to dist/
pnpm run dev        # run the server directly with tsx
```

### Testing approach

`test/fixtures/` holds real payloads captured from Garmin's own web client
and from round-tripping this server's own output through create-then-read.
Tests assert against those fixtures directly (golden-file style) rather than
only against hand-written expected values, so a change to field names,
ordering, or encoding that Garmin would actually reject gets caught. When
adding a new target or duration type, capture a real payload before trusting
the encoding - see the `UNVERIFIED` marker on `power.zone` for what an
unconfirmed one looks like.

## File Structure Notes

- Auth session is stored at `~/.config/garmin-connect-workouts-mcp/auth.json`
  with `600` permissions. No plaintext password is ever stored.
- All relative imports in `src/` use explicit `.js` extensions (this is a
  NodeNext/ESM project - TypeScript resolves them against the `.ts` source
  but they must point at the compiled `.js` names).
