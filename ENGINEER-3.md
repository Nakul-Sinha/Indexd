# ENGINEER 3: Platform Core & Human Surfaces ("the product")

This is your complete work order. It assumes you have read `CONTEXT.md`. It is written so
you can work for the whole project without asking Engineer 1 (AI & Agent Systems) or
Engineer 2 (Cloud & Deployment Infrastructure) what to do, while being exact about what
you consume from them and what you hand over.

Baseline repository for everything lifted: `ACM-VIT/farlands` @ `main`. Both source
repositories are private; the inventory behind this document was verified against the
repository tree and its docs, but statements about what a specific file *contains* are
inferred from names, siblings and documentation. Open the `[CONFIRM]` files named below
before trusting the inferences.

---

## 1. Your remit in one paragraph

You own the shared spine (the type contracts, the database schema, the rule vocabulary,
and the pipeline that turns a rule document into a deployable JAR) and every surface a
human touches: the web dashboard, the review screen, and the phone. You are also the
keeper of the human gate: the approvals module, the single mechanism the entire safety
argument rests on. Two of your deliverables sit on the other engineers' critical path
(Engineer 1 cannot generate MCP tool schemas without `packages/contracts`, and Engineer 2's
deployment controller cannot leave its `building` state without `buildRuleJar()`), so your
build order is not negotiable: contracts and the build pipeline ship before you write a
single line of UI.

---

## 2. What you own

| Path | Responsibility |
|---|---|
| `packages/contracts/` | The locked seam. Shared types for API, CLI, MCP, web, mobile. You are sole scribe; everyone else's types land here by PR to you. |
| `packages/db/` | Drizzle schema and the migration sequence. Five new tables. Sole owner of the sequence; E1 and E2 request tables by PR. |
| `packages/plugin-builder/` | The lifted eight-file pipeline, exposed as `buildRuleJar(ruleJson) -> { jarUrl, contentDigest }`. |
| `plugin-runtime/` | The lift of the Java rule interpreter. E1 adds `telemetry/` inside it. |
| `apps/api/` core | `auth/` extended with machine tokens; `approvals/`; `rules/` registry; `servers/` lifecycle and deployment states; SSE events; logs. |
| `apps/web/` | Dashboard, the lifted plugin-builder UI, the review screen with semantic diffs, deployment progress and queue position. |
| `apps/mobile/` | Expo client. Four screens, read-plus-approve, no authoring. |

This is the **widest scope of the three engineers**, and the way you survive it is by
refusing to treat it as one blob. The priority order in section 15 is part of this work
order, not a suggestion: the spine first, the gate second, the web third, the phone last.
The phone is M6 and it is the first thing cut if time runs short. The contracts package
and the build pipeline are never cut, because two other people stop working the day they
slip.

---

## 3. Critical path first

Three engineers work in parallel and integrate at the end. Two of your deliverables are
load-bearing for the other two from day one:

```
packages/contracts ──────> E1: MCP tool schemas are GENERATED from it.
        │                      CLI request/response types come from it.
        │                  E2: deployment state union, deploy request shape.
        │                  E3 (you): web and mobile API clients.
        │
packages/plugin-builder ─> E2: the controller's `building` state calls
        │                      buildRuleJar() and cannot exist without it.
        │                  E3 (you): the web plugin-builder UI and the
        │                      author route both build through it.
        │
mock API ────────────────> E1: MCP server and CLI develop against it.
                           E3 (you): web and phone develop against it,
                               months before E2's real controller exists.
```

Concretely:

1. **Engineer 1 cannot design a single MCP tool until `types.ts` is lifted and the
   contract shapes exist.** The rule vocabulary in `types.ts` *is* the agent action
   space; the tool schemas are generated from `packages/contracts` so the MCP surface,
   the CLI and the phone cannot drift.
2. **Engineer 2's state machine enters `building` and calls `buildRuleJar()`.** Until
   that function exists with its real signature, the controller can be designed but not
   run. The `contentDigest` it returns is also what approval-token redemption checks
   against, so the function's contract touches the safety model, not just the build.
3. **A mock API unblocks everyone's clients, including your own.** Deliver, early, a
   thin fake of the v1 API that serves contract-shaped fixtures: a canned server list, a
   scripted deployment that walks the state union on a timer, an SSE stream that replays
   a recorded event log, an approvals endpoint that mints and validates fake tokens.
   E1's CLI `--watch` and MCP tools, and your own web and phone screens, are all built
   against this before the real controller exists. Keep the mock in the repo; it is also
   your integration-test harness later.

Everything with a user interface comes after these three things. A beautiful review
screen that two blocked engineers are waiting behind is a net negative.

---

## 4. Component 1: `packages/contracts`, the locked seam

**Lift/extend source:** new package; shapes derived from `backend/src/modules/` DTOs and
the plugin-builder `types.ts` in the baseline.

Four clients consume this API (the web app, the CLI, the MCP server, and the phone), and
a shared type package is what keeps them from drifting apart. That is the entire reason
this package exists, and it is why it is small but load-bearing.

**You are the scribe, not the sole author.** Every other engineer's types land here by PR
to you, reviewed by whoever else the type touches. E2 PRs the deployment state union and
the deploy request shape; E1 PRs the proposal and telemetry-rollup shapes. You merge,
you keep the package coherent, you own the version. The package is **locked at the end of
Phase 0**: after that, changes are deliberate, reviewed events, not drive-by edits.
Never let two people edit it in parallel.

What lives in it:

| Contents | Notes |
|---|---|
| API request/response shapes | Every `/v1/*` endpoint in section 9, plus E2's deploy/abort/rollback/restore endpoints and E1's proposals. |
| The deployment state union | `idle \| building \| staging \| presync \| freezing \| verifying \| cutover \| draining` plus failure/abort. E2 authors it, you host it. Mirrors the `deployments.state` column exactly. |
| The SSE event envelope | One envelope for `GET /v1/servers/:id/events`: id (for `Last-Event-ID`), type, timestamp, payload. Deployment transitions, world events and proposal notifications all ride it. |
| Rule-set version and proposal shapes | The `rule_set_versions` row shape, the rules-registry DTO `{ name, description?, gameType, jsonUrl, version? }`, the proposal row shape. |
| MCP tool schema source | E1 generates tool schemas from these types. If a shape changes here, the agent surface regenerates rather than drifts. |
| Approval token shapes | Mint request/response, redemption result, the structured refusal naming the missing approval. |

Ship it with fixtures: a canned example value for every shape, exported from the package.
E1 works from these fixtures until your API is live; your mock API serves them.

---

## 5. Component 2: `packages/db`, schema and the migration sequence

**Lift source:** `packages/db/` in the baseline (Drizzle schema and migrations,
currently through head `0005`).

You are **sole owner of the migration sequence**. E1 and E2 request tables and columns by
PR to you; nobody else writes a migration file, ever, because two engineers writing
migrations in parallel is how a sequence forks. New migrations continue from `0005`.

Conventions, inherited from the baseline and not optional:

- `gen_random_uuid()` for identifiers.
- Partial unique indexes excluding soft-deleted rows, following the pattern established
  by `game_servers_user_active_name_idx` on `(user_id, name) where current_state <>
  'deleted'`.
- Note the constraint that index already enforces: **active server names are unique per
  user**. A candidate pod provisioned during a deployment must not collide with it:
  agree the candidate naming scheme with E2 before they provision their first pod B.

### The five new tables (P2 §4.1)

| Table | Columns | Purpose |
|---|---|---|
| `rule_set_versions` | `id, rule_set_id, version, json_url, content_digest, built_jar_url, source, source_prompt, created_by, created_at` | One row per rule-set version. `source` is `form \| agent \| director`. Rollback targets a row here. `content_digest` is what approval binds to. |
| `deployments` | `id, server_id, from_version, to_version, state, candidate_pod, snapshot_id, player_visible_ms, approved_by, approval_token_hash, initiated_by, started_at, finished_at, error` | One row per attempt, **including failures**. `state` mirrors the controller state machine. Reconciled against Kubernetes on backend restart, exactly as the backup module reconciles Jobs. **This table is the audit log of record.** |
| `approval_tokens` | `token_hash, server_id, rule_set_version, content_digest, issued_to, issued_by, issued_at, expires_at, consumed_at` | Store the hash, never the token. Single-use enforced by `consumed_at`; redemption checks `issued_to` against the calling principal and `content_digest` against the freshly built artefact. |
| `world_events_rollup` | `server_id, window_start, window_end, metrics jsonb` | Aggregated telemetry. Deliberately not raw events: raw events grow without bound and nothing reads them. E1 writes into it; you own its shape. |
| `proposals` | `id, server_id, suggested_rules jsonb, rationale, confidence, status, reviewed_by, reviewed_at, rejection_reason` | Director output awaiting approval. Rejection reasons are the most useful signal in the system; the schema exists to capture them. |

### Two structural rules: say them loudly, enforce them in code

1. **`rule_set_versions` is append-only, and the S3 objects behind `json_url` are
   write-once.** A changed rule is a new row, and a new version needs a new approval.
   There is no update path, no upsert, no "fix the draft in place". This is not tidiness;
   it is the load-bearing half of the time-of-check/time-of-use defence in section 8.
   If a version row or its S3 object can be rewritten after a human approved its diff,
   the entire safety argument is decorative.
2. **`deployments` stores `approval_token_hash`, never a raw token**, as a foreign key
   onto `approval_tokens`. It is the audit log of record: every rule version records its
   source and the prompt that produced it; every deployment records who approved it and
   who initiated it. Application logs are diagnostics; this table is the history.

---

## 6. Component 3: `packages/plugin-builder`, the lifted pipeline

**Lift sources:** `farlands-app/src/lib/plugin-builder/` (seven files) and
`farlands-app/src/app/api/plugin-builder/` (the assembly entry point).

The build plan originally left this inside the web app. That placement is overridden, and
the decision is final: the deployment controller must build a JAR server-side during its
`building` state, so the pipeline lives in `packages/plugin-builder/` where web, API and
the controller all import it.

**Copy wholesale. Do not restructure.** Rebuilding this pipeline would cost days, and
every restructuring is an opportunity to break behaviour nobody has tests for yet. The
eight-file pipeline:

| File | Role |
|---|---|
| `types.ts` | The rule schema: the vocabulary. `[CONFIRM]` |
| `validation.ts` | Validates a rule document against the schema. The only path in. |
| `jar-builder.ts` | Injects rule JSON into a copy of the template JAR. `[CONFIRM]` |
| `runtime-jar.ts` | Fetches the base template JAR from blob storage. |
| `yaml-generator.ts` | Emits the plugin descriptor. |
| `s3-config.ts` | Bucket/prefix configuration. |
| `s3-storage.ts` | Persists rule JSON and built JARs to S3. |
| `json-builder.ts` + `route.ts` | The assembly entry point: sits under `app/api/plugin-builder/`, **not** in `lib/`. It is the eighth file of the pipeline and easy to miss when copying, because it is not next to the other seven. |

Expose one function:

```ts
buildRuleJar(ruleJson) -> { jarUrl, contentDigest }
```

**The digest is computed here, at build time, from the built artefact.** It is what
approval binds to, so it must be recomputed from what was actually built: never trusted
from the caller, never carried through from input, never cached across builds. E2's
controller compares it against the approval token's `content_digest` and refuses on
mismatch; that comparison is only worth anything if this function is the sole source of
the digest.

### The two `[CONFIRM]` files you open before anything else

The inventory was built by reading the repository tree and docs, not every line of code.
Two of your files carry assumptions that everything downstream depends on:

1. **`types.ts`: the rule vocabulary.** This defines what a rule can express, and
   therefore the entire agent action space. E1 designs every MCP tool against its shape.
   Read it before locking `packages/contracts`, and walk E1 through it in your first
   integration conversation.
2. **`jar-builder.ts`: how the JSON is injected.** Resource entry, manifest attribute,
   or rewritten class? The answer determines whether a rebuild is cheap enough to sit
   inside every deployment's `building` state, or whether builds need caching. Tell E2
   what you find; it shapes their state machine's timing budget.

### One constraint you enforce for Engineer 2

A Velocity backend transfer preserves the player's connection but **not server-side
in-memory plugin state**. Anything a generated plugin holds in RAM rather than on disk is
lost at handover. That makes statelessness a design constraint on the rule vocabulary,
and `validation.ts` is where it is enforced: **rules must be stateless or persist through
the world, and validation rejects anything else**, rather than E2 discovering the
problem in production when a rule's counters silently reset at cutover. If the current
vocabulary can express stateful rules, tightening this is your first real change to the
pipeline, made as a reviewed security change.

---

## 7. Component 4: `plugin-runtime`, the Java interpreter

**Lift source:** the Maven project at `farlands-app/plugin-runtime/` in the baseline
(`PluginMain.java` plus `config/`, `listeners/`, `models/`). This is the single most
valuable asset in the repository: a generic, pre-reviewed interpreter that reads the
injected JSON rule document and registers the Bukkit listeners it describes.

**Copy wholesale into `plugin-runtime/` at the repo root. Do not restructure.** The
template JAR is reviewed once and fixed; each rule set is a payload injected into a copy
of it. That property (the model emits documents, a fixed runtime interprets them) is
the safety design, and refactoring the runtime reopens it.

Two things to settle in week one:

1. **The package boundary with Engineer 1.** E1 adds
   `src/main/java/com/farlands/telemetry/` (the in-world NDJSON event emitter) inside
   your lift. Agree early which classes the emitter may touch (listeners it hooks, the
   config it reads) so their commits and yours do not collide inside one Maven project.
   You own the build (`pom.xml`, the template JAR release); E1 owns the `telemetry/`
   package.
2. **`config/`: how the runtime loads its configuration. `[CONFIRM]`** If it reads from
   the JAR only, every rule change needs a rebuild, and the rebuild sits inside every
   deployment. If it can read an external path, a class of changes becomes a file write
   instead of a build. Open the code and find out; the answer changes the economics of
   `buildRuleJar()` and E2's freeze budget.

**Pin the Paper build in the template, and treat a version bump as a deliberate
migration.** Paper moves under you: 26.1 turned gamerules into a registry and renamed
them camelCase to snake_case; 26.2 removed previously deprecated API. Paper 26.1+
requires Java 25. A bump is a reviewed change with the interpreter re-tested against the
new API, not a dependency update.

---

## 8. Component 5: `approvals`, the mechanism the entire safety argument rests on

This module is why the platform can hand an action space to an agent and still be
defensible. Everything else in the system can be mediocre and recovered later; if this is
wrong, the product's central claim is false. Design it narrowly.

### The token, in full

```
{
  token,                    returned once at mint; only its hash is stored
  server_id,                scoped to exactly one server
  rule_set_version,         the version row the human reviewed
  content_digest,           hash of the exact rule JSON and built JAR the human saw
  issued_to,                the principal allowed to redeem it
  issued_by,                the human who approved
  issued_at,
  expires_at,               minutes, not hours
  single_use: true
}
```

The rules, each of which closes a specific hole:

- **Minted only by a human action**: in the web dashboard or the phone app, after
  seeing a semantic diff. `POST /v1/approvals` accepts a human session only, **never a
  machine token**. An agent can prepare, argue for and queue a deployment; it cannot
  mint its own permission.
- **Bound to content, not to a name.** The token carries `content_digest`: a hash of
  the exact rule JSON, and of the built JAR, that the human saw diffed. E2's controller
  recomputes the digest at `building` (via `buildRuleJar()`) and refuses on mismatch. A
  token that named a version string instead could be approved against a benign draft and
  redeemed against a rewritten one.
- **Redeemable only by the principal in `issued_to`.** Otherwise a leaked token is
  bearer authority over a live world. Redemption checks the calling principal, not just
  the token's validity.
- **Short-lived and single-use.** `consumed_at` enforces single use. A token consumed
  by a deployment that later aborts is spent; the retry needs a fresh approval. An agent
  that sits on a token cannot bank authority for later.

### The two failure modes this design exists to prevent

**Time-of-check / time-of-use.** The human approves a diff rendered from a JSON document
in S3, but the *ungated draft tools* are what write those documents. If a
`rule_set_versions` row or its S3 object can be rewritten, an agent can get approval for
a benign v4 and have a different v4 built at deploy time. The defence has three parts and
needs all three: version rows are **append-only**; the S3 objects behind `json_url` are
**write-once**; and the digest is **recomputed at build time** from the artefact actually
built, with refusal on mismatch. A changed rule is a new version, and a new version needs
a new approval. Without this, the entire safety argument is decorative; this is the one
failure in the risk register that compromises everything.

**Tiering versus injection.** Approval fatigue is real: if every trivial change needs a
tap, owners will look for a way to switch the gate off. The obvious fix is an
auto-approval tier for "safe" rule classes, and it is the wrong fix: the Director reads
telemetry channels that carry player-authored text (chat volume today, more later), so
**an auto-approving rule class is a class a player can reach by writing instructions in
chat**. Tiering and "a successful injection cannot deploy anything" cannot both be true.
So: **no auto-approval tier in v1.** Solve fatigue by **batching** (group a session's
proposals into one review with one tap), not by tiering. If a tier is ever added it must
be opt-in per server, restricted to classes the Director cannot reach from any channel
carrying player-authored text, recorded with `issued_by = system`, and revoked
automatically on any rejected proposal. That is a later project, not a v1 shortcut.

---

## 9. Component 6: the API core

**Extend sources:** `backend/src/modules/auth/`, `backend/src/modules/admin/`,
`backend/src/modules/rules/`, `backend/src/modules/servers/` in the baseline (Bun +
Elysia, Drizzle behind it).

### `auth/`: machine tokens

The existing auth and admin surface works; lift it and extend it with **machine
credentials**: API tokens for the CLI and the MCP server. Machine tokens authenticate E1's
surfaces; they are deliberately less powerful than a human session: a machine token can
never call `POST /v1/approvals`, and act-class operations authenticated by one still
require an approval token minted by a human. The CLI is a client, not a privilege
escalation.

### `rules/`: the registry

Lift `backend/src/modules/rules/` essentially verbatim. The DTO is
`{ name, description?, gameType, jsonUrl, version? }`, **a pointer to a JSON document in
S3, not the document itself**. This indirection is exactly what versioning and rollback
need: versions are rows pointing at immutable objects, diffs are computed by fetching two
objects, and rollback is a pointer move plus a redeploy. Do not "improve" it by inlining
the document.

### `servers/`: lifecycle and deployment states

Extend the lifted lifecycle module with the deployment states from E2's state union so a
server's current deployment status is queryable. E2 owns the controller and the
transitions; you own the module's read surface and the state's presence in the API shapes.

### Your endpoints (from P2 §4.2)

| Endpoint | Purpose |
|---|---|
| `POST /v1/approvals` | Mint an approval token. Human session only, never a machine token. |
| `POST /v1/servers/:id/rule-sets/author` | Plain English in, validated rule version out. Server-scoped, because a server's first rule set has no id yet, so a rule-set-scoped route cannot be the entry point. Deploys nothing. You own the route; the model work behind it is E1's `authorRules()`. |
| `POST /v1/servers/:id/preview` | Dry run: semantic diff, estimated player-visible window, quota impact, rollback target. No live effect. |
| `GET /v1/servers/:id/proposals` | Director proposals for review. |
| `POST /v1/proposals/:id/approve` | Approve mints a token and starts a deployment. |
| `POST /v1/proposals/:id/reject` | Reject records the reason: capture it; it is training signal. |
| `GET /v1/servers/:id/events` | SSE stream with `Last-Event-ID` replay. Consumed by web, CLI and mobile. |
| `GET /v1/servers/:id/logs` | Server console log stream, backing `farlands logs --follow`. |

Not yours, but adjacent: `POST /v1/servers/:id/deploy`, `GET /v1/deployments/:id`,
`POST /v1/deployments/:id/abort`, `POST /v1/servers/:id/rollback`,
`POST /v1/servers/:id/restore` are **Engineer 2's**; `POST /internal/telemetry/:serverId`
is **Engineer 1's**; the `/internal/velocity/*` endpoints are **Engineer 2's**. Their
shapes still live in your contracts package.

### SSE, done properly

`GET /v1/servers/:id/events` is one stream with one envelope (section 4). Requirements:

- **`Last-Event-ID` replay**: a client reconnecting with the header receives everything
  it missed from a bounded replay buffer. This is what lets a phone that loses signal in
  a lift resume rather than restart, and what makes CLI `--watch` reliable.
- **E2 publishes deployment state transitions into it.** Give E2 a publish interface
  early (even an internal endpoint or a shared library call against the mock) so the
  controller emits transitions from day one.
- World events (from E1's ingest) and proposal notifications ride the same stream with
  different event types. One stream per server, not one per feature.

---

## 10. Component 7: the web dashboard

**Extend source:** `farlands-app/src/app/(dashboard)/` and `components/`, the existing
Next.js app with Better Auth and Google OAuth. Also lift `farlands-app/src/lib/modrinth/`;
browsing the existing plugin ecosystem stays useful and is the natural surface for a
rule-set marketplace later (later; see section 14).

Three deliverables, in this order:

### The review screen, the centrepiece

A comparison of two JSON documents fetched from S3 by `jsonUrl`, rendered
**semantically**:

```
hostile spawns near spawn:   0.5x -> 1.4x
skeleton drops:              + emerald (night only)
```

**Never a raw JSON patch.** A diff nobody can read is a gate nobody uses, and if the
gate is unusable, owners will find a way around it, which deletes the safety property.
The semantic renderer walks the rule vocabulary from `types.ts` and produces one plain
line per changed rule; anything it cannot render semantically is a renderer bug to fix,
not a reason to fall back to showing JSON. The Approve button on this screen calls
`POST /v1/approvals` and is one of exactly two places in the system a token can be minted
(the other is the phone). Batch view: a session's pending proposals grouped into one
review with one approval, per section 8.

### Deployment progress

A live view over the SSE stream: current state, states completed, and, because
deployments serialise behind E2's cluster-wide queue, **queue position**, so a
deployment waiting for headroom is visibly queued rather than silently stuck in
`staging`. Show `player_visible_ms` after completion; the honest number, whatever M1
made it.

### The lifted plugin-builder UI

The existing builder form, now submitting through `packages/plugin-builder`. It produces
a `rule_set_versions` row with `source = form`. It does not deploy; deployment always
goes through review and approval like every other source.

---

## 11. Component 8: the phone client

**New:** `apps/mobile/`, Expo / React Native, a proven Expo and Node stack. Push via
Expo notifications. SSE with a `Last-Event-ID` replay buffer rather than long-polling, so
a phone that loses signal in a lift resumes rather than restarts.

Why a phone client at all: the person who owns a Minecraft server is very often a
teenager with a phone, not an engineer at a desk. If approving a change requires a
laptop, the Director's proposals sit unread and the loop never closes. The phone closes
the human-in-the-loop gate in seconds rather than hours, the difference between a
safety mechanism that works and one that gets disabled because it is annoying.

**Four screens, no more** (P2 §3.8):

| Screen | Contents |
|---|---|
| Servers | List with live status, player count, TPS. Start, stop, and the address to share. |
| World feed | Server-sent events from the running world: joins, notable events, deployment progress. The same events the Director's rollups are computed from. |
| Proposals | Director suggestions arriving as push notifications. Semantic diff, rationale, confidence. Approve mints the token; reject records why, which is training signal. |
| Rollback | Deployment history with one-tap rule rollback. The panic button in the pocket of the person standing in the world that went wrong. |

**The app is read-plus-approve. No authoring on the phone, deliberately.** Authoring
happens on the web or through an agent; the phone is where a human decides. The division
is not a resourcing compromise: the phone is the gate, and a gate with an authoring
surface attached is a gate people will use to rubber-stamp their own drafts.

---

## 12. Rollback in the UI

Two different operations get called rollback, and conflating them in the interface loses
player data. Present them as differently as they behave:

| | Rule rollback | Snapshot restore |
|---|---|---|
| What it is | Deploys the previous rule version onto the current world. Mechanically an ordinary deployment with source and target reversed. | Restores the retained world snapshot from before the change. |
| Play since the change | **Preserved.** | **Discarded.** |
| When | Almost always. The default. | Only when the world itself was corrupted or griefed. Disaster recovery. |
| UI | The one-tap button, on the phone and the web. | Buried behind an explicit confirmation that **names the data loss**, "this discards everything players did since <time>". |

The copy on the rule-rollback button must be honest: it stops the rule acting further; it
**does not undo what the rule already did**. Diamonds granted stay granted, mobs cleared
stay cleared. Saying this in the interface is the difference between a safety argument
and a slogan, and the honesty lands better than the overclaim would.

---

## 13. What you consume, and from whom

| You consume | From | Interim substitute until it exists |
|---|---|---|
| `POST /v1/servers/:id/deploy`, `GET /v1/deployments/:id`, abort/rollback/restore, and deployment state transitions published into your SSE stream | Engineer 2 | Your mock API walks the state union on a timer and emits envelope-shaped SSE events. Web progress UI and phone feed are built entirely against this. |
| The measured freeze window (M1) | Engineer 2 | Do not design the deployment-progress UX copy ("about N seconds") until the number exists. Build the screen; leave the number a variable. This is the one genuine serialisation in the plan. |
| A local cluster path (kind or k3d) and a docker-compose Postgres | Engineer 2 | Plain local Postgres for migrations until it lands. You must never need the AWS account; it is E2's. |
| `authorRules(serverId, prompt)` behind your `POST /v1/servers/:id/rule-sets/author` route | Engineer 1 | Stub it to return a fixed, valid `rule_set_versions` row. The route, validation and persistence are yours and testable without the model. |
| Director proposals to render in the Proposals UI (web and phone) | Engineer 1 | Fixture proposal rows in the `proposals` table, hand-written. The review flow does not care who authored the proposal. |
| Telemetry rollups feeding the world feed | Engineer 1 | A recorded telemetry fixture replayed through your SSE stream. |

---

## 14. What you must NOT build

- **A rule marketplace before M4.** The rules registry's
  `{ name, gameType, jsonUrl, version }` shape makes it cheap later; it is worth nothing
  until rules can deploy live. The modrinth lift stays a browsing surface.
- **Authoring on the phone.** Section 11 is the argument. The four screens are a
  ceiling, not a floor.
- **Multi-game support.** The DTO carries a `gameType` enum, so the seam exists. Leave
  it a seam. One game done properly beats two done partially.
- **An auto-approval tier.** Section 8 is the argument. Batching, not tiering.

---

## 15. Priority order and the cut line

In order. Each item assumes the ones above it.

1. `packages/contracts` locked, with fixtures. (Unblocks E1 and E2. Phase 0.)
2. `packages/db`: the five migrations from head `0005`, append-only and write-once
   rules enforced. (Unblocks everyone's persistence; seam 8.)
3. `packages/plugin-builder` lifted, `buildRuleJar()` exposed, digest recomputed.
   (Unblocks E2's `building` state.)
4. `plugin-runtime/` lifted; template JAR pinned; package boundary agreed with E1.
5. The mock API: contract-shaped fixtures, scripted deployment states, replayable SSE,
   fake approvals. (Unblocks all four clients.)
6. `approvals/`: real minting, hashing, redemption checks, expiry, single-use.
7. API core: machine tokens, `rules/`, `servers/` states, real SSE with replay, logs.
8. Web: the review screen with semantic diffs and approve/reject. (This is the M4
   surface.)
9. Web: deployment progress with queue position.
10. Web: the lifted plugin-builder UI.
11. Mobile: Proposals screen with push, then Rollback, then Servers, then World feed.
    (M6.)

**The cut line sits between 9 and 10.** If time runs short:

- **Cut mobile first (11).** It is M6 and it trails the web review screen by design; the
  web gate covers every approval the phone would have handled. The demo loses "approved
  from a phone", which hurts, but the product still exists.
- **Cut the plugin-builder UI second (10).** Rules can still be authored through the
  author endpoint, the CLI and the MCP tools; the form is a convenience.
- If mobile survives in reduced form, the screen order inside item 11 is the cut order
  reversed: Proposals with push approval is the screen that justifies the app's
  existence; the World feed is polish.

**What survives any cut:** items 1 through 8. Contracts, schema, the build pipeline, the
runtime, the mock, approvals, the API core, and the web review screen are the spine and
the gate. Below that line there is no product, only components.

---

## 16. Definition of done, per component

| Component | Done when |
|---|---|
| `packages/contracts` | E1 generates MCP tool schemas from it and E2 type-checks the controller against the state union, with zero locally-redeclared API types in either of their trees. Fixtures exported for every shape. |
| `packages/db` | All five migrations apply cleanly on an empty database and on a baseline-`0005` database. A test proves `rule_set_versions` rejects updates to existing rows, and that inserting a candidate server name colliding with an active name fails via the partial-index pattern. |
| `packages/plugin-builder` | `buildRuleJar()` on a committed sample rule JSON produces a JAR that the lifted `plugin-runtime` loads without startup exceptions, and returns a digest that changes when one byte of the rule JSON changes. Both `[CONFIRM]` files opened, findings recorded and shared with E1 and E2. `validation.ts` rejects a stateful-rule fixture. |
| `plugin-runtime` | Builds under Maven against the pinned Paper version on Java 25; a built rule JAR loads on a local Paper server and registers its listeners. E1 has a `telemetry/` package skeleton merged without conflicts. |
| Mock API | E1's CLI `--watch` renders a full scripted deployment from it; the phone's world feed resumes correctly after a killed connection via `Last-Event-ID`. |
| `approvals/` | A machine token calling `POST /v1/approvals` is refused. A token redeemed twice fails the second time. A token redeemed by a principal other than `issued_to` fails. A token whose `content_digest` mismatches the freshly built artefact is refused. An expired token is refused. Each is a test. |
| API core | Machine token authenticates CLI and MCP calls but cannot mint approvals. `GET /v1/servers/:id/events` replays missed events on reconnect with `Last-Event-ID`. `rules/` round-trips the pointer DTO against S3. |
| Web review screen | A human sees "hostile spawns near spawn: 0.5x -> 1.4x", not JSON, for two real S3-backed versions; approve mints a real token; reject records a reason on the proposal row. |
| Web deployment progress | Live states from SSE, queue position shown while queued, `player_visible_ms` shown after completion. |
| Mobile | The M6 done-condition, below. Push notification received on a physical device; approval from the notification mints a token; rollback triggers E2's rollback endpoint. |

---

## 17. Your integration checklist

### The eight seams, and your role in each

| # | Seam | Provider | Your role |
|---|---|---|---|
| 1 | `packages/contracts` | **You** | Scribe and owner. Locked in Phase 0; changes by PR, reviewed by whoever the type touches. |
| 2 | `buildRuleJar(ruleJson)` | **You** | Provider to E2's `building` state. Returns `{ jarUrl, contentDigest }`; digest recomputed, never trusted from input. |
| 3 | `POST /v1/servers/:id/deploy` | E2 | Consumer: your web and phone approve flows start deployments through it. It validates tokens against your `approvals` module. |
| 4 | `authorRules(serverId, prompt)` | E1 | Consumer: you host it behind `POST /v1/servers/:id/rule-sets/author` and the web form. It returns a validated `rule_set_version` row and deploys nothing. |
| 5 | Approval tokens | **You** | Provider. E1's act tools carry them; E2 redeems them at `building`. Content-digest bound, single-use, short-lived, `issued_to`-scoped. |
| 6 | SSE `/v1/servers/:id/events` | **You** | Provider of the stream and envelope. E2 publishes deployment states into it; E1's CLI `--watch` and your web and phone consume it. |
| 7 | Telemetry pipeline | E1 end-to-end | Consumer: your proposals UI renders what the Director produced; your `world_events_rollup` table holds the aggregates. |
| 8 | DB migration sequence | **You** | Sole owner. One sequence, one writer; E1 and E2 request by PR. |

### You hand to Engineers 1 and 2

- `packages/contracts`, locked, with fixtures (both).
- `buildRuleJar()` with its real signature and digest semantics (E2).
- Approval-token validation: the redemption call E2's controller makes, and the
  structured refusal shape E1's act tools return when no token is present (both).
- The SSE event envelope and E2's publish interface into the stream.
- The migration sequence: five tables live, plus the PR process for theirs.
- Your `[CONFIRM]` findings from `types.ts`, `jar-builder.ts` and `plugin-runtime`
  `config/`. E1 designs tools and E2 budgets the freeze window from what you find.

### You need from them

- **From E2:** the deploy/abort/rollback/restore endpoints; deployment states published
  into your SSE stream; the local cluster path and docker-compose Postgres; the M1
  freeze-window number before you finalise deployment-UX copy.
- **From E1:** `authorRules()` behind your route; Director proposal rows conforming to
  the contracts shape; the telemetry rollups that make the world feed and proposals real.

### Integration tests that only pass when all three parts are wired

1. **The gate holds end-to-end.** An agent (E1's MCP `deploy_rules`) attempts a deploy
   with no token and receives the structured refusal; a human approves the diff on your
   web review screen; the same agent retries with the minted token and E2's controller
   accepts, builds, and the digest check passes. Then: mutate the S3 rule JSON out of
   band and confirm redemption is refused on digest mismatch.
2. **A spent token cannot be reused.** Approve, deploy, abort mid-`staging` (E2's abort
   path); the retry with the same token is refused and requires a fresh approval.
3. **One stream, three clients.** A deployment driven by E2's controller emits state
   transitions that render simultaneously in your web progress UI, E1's `farlands deploy
   --watch` NDJSON output, and the phone world feed, and a client killed mid-deployment
   resumes losslessly via `Last-Event-ID`.
4. **The audit trail is complete.** After test 1, the `deployments` row carries
   `approved_by`, `approval_token_hash`, `initiated_by` and the final state, and the
   `rule_set_versions` row carries `source` and `source_prompt`.

### The milestone conditions you are measured against

- **M4, Authoring + approvals.** Done when: *Someone types a sentence, sees what it
  will do, approves it, and the world changes around them.*
- **M6, Phone client.** Done when: *A proposal arrives as a notification and is
  approved from a phone while standing in the world.*

M4 needs your author route, your approvals module and your review screen sitting on E2's
deployment mechanism and E1's authoring. M6 is yours almost alone, which is exactly why
it is the milestone that can trail: nobody else is blocked behind it.
