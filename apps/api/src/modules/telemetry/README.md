# telemetry

Owned by Engineer 1. Ingest at `POST /internal/telemetry/:serverId`, then rolling window
aggregation into `world_events_rollup`.

Raw events are not stored. Everything downstream reads rollups.

## Shape

| File | Responsibility |
|---|---|
| `plugin.ts` | The Elysia plugin. Mount with `app.use(telemetryPlugin({ store }))`. |
| `guard.ts` | Refuses requests carrying edge-proxy forwarding headers. |
| `events.ts` | NDJSON parsing and validation compiled from the `WorldEvent` contract. |
| `window.ts` | One open window's counters. No event is ever held. |
| `sessions.ts` | Join/leave pairing and the two window-boundary decisions. |
| `aggregator.ts` | Window rotation and handoff to the store. |
| `store.ts` | `RollupStore` plus the in-memory implementation. |

## The rules this module is built to keep

**No raw events, anywhere.** `WindowAccumulator` holds counters, a set of distinct player
names and a per-region total. Nothing in the module has an array of events, and the store
interface has no method that takes or returns one. Memory is a function of distinct players
and elapsed windows, never of event volume.

**Cluster-internal is enforced in two halves.** The NetworkPolicy is Engineer 2's; this
module refuses requests carrying `x-forwarded-for` and its relatives, which is what an
accidental public route leaves behind. The refusal is a `not_found`, so a scanner that
reaches it does not learn that `/internal/*` exists.

**Session pairing at a window boundary.** A session still open when a window closes is
carried forward, not truncated, and the full duration is credited to the window in which the
session actually closed. A leave with no join counts toward `leaves` and contributes nothing
to `mean_session_seconds`. `mean_session_seconds` is `null`, never `0`, when nothing closed.
`sessions.ts` states the reasoning; `test/telemetry-rollup.test.ts` asserts both cases.

**Player names are opaque.** They are Set keys and Map keys. Nothing parses them, matches
them, or interpolates them, and the rejection path reports schema paths rather than values so
player-authored text never reaches a log line.

## Not written here

- `world_events_rollup` and its Drizzle migration. Migrations are one sequence with one owner
  (Engineer 3); this module requests the table by pull request rather than forking the
  sequence. Swap `InMemoryRollupStore` for the Drizzle implementation of `RollupStore` when it
  lands; nothing else changes.
- The Java emitter. It lives in `krishang/plugin-runtime/src/main/java/com/farlands/telemetry/`
  and is the other side of this seam: it produces the NDJSON that `events.ts` validates. Its
  tests assert byte equality against `fixtures/telemetry/session-01.ndjson`, the same recorded
  batch the tests here read, so the two halves are pinned to one artefact rather than to each
  other.
