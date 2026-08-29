# PHASES.md: Farlands Live

Four sections. **Section 1** is the whole project, phase by phase: when every phase in it is
done, the product is built. **Sections 2, 3 and 4** are the same phases seen from inside each
engineer's work order: [ENGINEER-1.md](ENGINEER-1.md), [ENGINEER-2.md](ENGINEER-2.md),
[ENGINEER-3.md](ENGINEER-3.md).

The phase numbers are shared across all four sections. Phase 4 means the same thing to everyone,
which is what makes three parallel tracks integrate instead of collide.

Read [CONTEXT.md](CONTEXT.md) before any of this.

## Phase index

| Phase | Name | Stage | Gate |
|---|---|---|---|
| 0 | Foundation and lock | - | Contracts frozen, four `[CONFIRM]` files read |
| 1 | Baseline running | M0 | A server is created through the API and joined from the game |
| 2 | Prove the world moves | M1 | **GO/NO-GO.** The freeze window is measured |
| 3 | Manual deployment, no cutover | M2 | Freeze runs, candidate verifies, abort returns players cleanly |
| 4 | Cutover | M3 | **The product exists.** Rules change with nobody disconnected |
| 5 | Authoring and approvals | M4 | A sentence becomes a reviewed, approved, deployed change |
| 6 | Agent surfaces | M5 | An agent is correctly refused, then correctly permitted |
| 7 | Phone client | M6 | A proposal is approved from a phone, standing in the world |
| 8 | Director and evaluation | M7 | The world proposes its own change and the result is measured |
| 9 | Hardening | M8 | A deployment survives the backend being killed mid-flight |
| 10 | Integration and demo | - | The seven-step demonstration runs end to end |

**Phases 0–4 are the product.** Everything after Phase 4 is leverage on a capability that already
exists. Nothing after Phase 4 is worth starting before Phase 4 is finished.

## The three rules that govern every phase

1. **Pod A stays authoritative until cutover succeeds.** No code path may stop, unmount or modify
   the live server before the candidate has passed its health check. This is enforced in code,
   not by convention.
2. **One migration sequence, one owner.** Engineer 3 writes every migration. Engineers 1 and 2
   request tables by PR. Two people writing Drizzle migrations in parallel is the one failure
   that guarantees a broken integration.
3. **The freeze window measured in Phase 2 is an input, not a detail.** Engineer 3's lobby copy
   and Engineer 1's `preview_deploy` estimate both derive from that number. Until it exists, they
   report `"unmeasured"` rather than a guess.

---
---

# Section 1. The project, phase by phase

## Phase 0: Foundation and lock

**Goal:** a repository three people can work in simultaneously without blocking each other, and a
type surface nobody can drift from.

| Engineer 1 | Engineer 2 | Engineer 3 |
|---|---|---|
| Read `types.ts`: the rule vocabulary is your entire action space. Draft the MCP tool table against it. | Re-point OpenTofu at your AWS account. Stand up the cluster. Confirm or upgrade Velocity. | Scaffold the monorepo. Lift the eight-file plugin-builder and the Java runtime. Lock `packages/contracts`. |

**Joint work, done together in one sitting:**

1. Open the four `[CONFIRM]` files in the baseline `ACM-VIT/farlands` and check every assumption
   against actual code: `plugin-builder/types.ts` (the rule vocabulary), `jar-builder.ts` (how
   the JSON is injected, and therefore whether a rebuild is cheap enough to sit inside a
   deployment), `plugin-runtime/config/` (whether the runtime can read an external path),
   `backup/service.ts` (whether a backup Job co-schedules with the running pod).
2. Freeze `packages/contracts` v1: the deployment state union, the SSE event envelope, the
   rule-set version and proposal shapes, the API request/response types. Every later change is a
   PR reviewed by whoever the type touches.
3. Agree the rule vocabulary is frozen for v1. Expanding it is a security change, reviewed one
   primitive at a time.
4. Agree the `plugin-runtime` package boundary so Engineer 1's `telemetry/` and Engineer 3's lift
   never touch the same files.

**Exit criteria:** contracts published and importable · migrations at head `0005` reproduced ·
local-parity dev path (kind or k3d plus docker-compose Postgres) works on all three machines ·
the four `[CONFIRM]` findings written down and circulated.

**Gate:** no one starts Phase 1 with an unread `[CONFIRM]` file. Every downstream design assumes
what those four files actually do.

---

## Phase 1: Baseline running (M0)

**Goal:** the baseline capability, reproduced in the new repository and the new account. No new
features. This is the thing you must not break.

| Engineer 1 | Engineer 2 | Engineer 3 |
|---|---|---|
| Build the telemetry emitter against a local Paper server. Record the fixture everything else develops against. | Per-tenant namespaces, quotas, policies. RCON password as a Secret. Provisioning creates a server that boots. | The five migrations. `buildRuleJar()` exposed. The mock API, contract-shaped and replayable. |

**Exit criteria:** a server is created through the API, appears at its stable hostname, and is
joined from an unmodified game client · `buildRuleJar()` returns a JAR and a recomputed digest ·
the mock API serves scripted deployment states and replayable SSE, so all four clients have a
development target.

**Gate:** if the baseline does not run, nothing above it can be trusted. Do not proceed on a
partially working M0.

---

## Phase 2: Prove the world moves (M1)

**Goal:** answer the question the entire project rests on, before building anything on top of it.

This phase is deliberately narrow and deliberately early. It is a script, not a controller.

1. Engineer 2 builds the pod-to-pod world stream: a sidecar in pod A that tars `world/` and
   streams over HTTP to a receiver init-container in pod B.
2. Pre-sync a realistic world while A is live and serving.
3. Run the freeze sequence by hand (`save-off`, `save-all flush`, delta sync, `save-on`, in that
   order) and start Paper on B against the delivered world.
4. **Measure delta sync plus Paper cold boot.** Record world size, delta size, and conditions.
5. Circulate the number to Engineers 1 and 3 the day it exists.

Engineers 1 and 3 continue on Phase 1 and early Phase 5 work that does not depend on the number.

**Exit criteria:** a measured freeze window on a realistic world, with its conditions recorded.

**Gate: this is the falsification test.** If the window cannot be brought to a length the lobby
experience can absorb, the pitch does not hold and the plan changes here rather than at Phase 10.
Fallback if the sidecar stream proves fiddly: strategy A through S3 already exists and is enough
for a first end-to-end test, at the cost of losing incremental delta.

---

## Phase 3: Manual deployment, no cutover (M2)

**Goal:** the whole freeze-and-return cycle, exercised without ever moving a player into the new
world. Driven by a hand-written rule JSON committed to the repository.

| Engineer 1 | Engineer 2 | Engineer 3 |
|---|---|---|
| Telemetry ingest and rolling-window aggregation. CLI skeleton against the mock. | The controller through `verifying`. The lobby workload. Every abort path. | `approvals/` module: minting, hashing, redemption, expiry, single-use. |

The lobby is one shared cluster workload, not one per tenant: the capacity ceiling makes a lobby
per tenant unaffordable, and the lobby holds no tenant state.

**Exit criteria:** with the world pre-synced, players drain to the lobby, the freeze runs, a
candidate boots against the copied world and passes health checks · **abort at any state returns
players from the lobby to the original and leaves no trace**: no orphaned pod, PVC, Service or
route · every state transition writes its `deployments` row.

**Gate:** the abort path is tested harder than the happy path. Abort at `building`, `staging`,
`presync`, `freezing` and `verifying` must each leave the cluster exactly as it was.

---

## Phase 4: Cutover (M3)

**Goal:** the product.

1. Engineer 2 ships the Velocity transfer endpoints and the routing-plugin change; route B is
   registered during `staging`, well before cutover, because a new route can take a full polling
   interval to become visible.
2. The controller completes: `cutover` moves every player lobby to B, `draining` retires A and
   retains its snapshot.
3. Rule rollback works: mechanically an ordinary deployment with source and target reversed.
4. Engineer 3 renders deployment progress from the real event stream, with queue position.
5. Engineer 1's CLI follows a real deployment as NDJSON, one object per state transition.

**Exit criteria:** you change a rule, players pass through the lobby and land in the new world
**without disconnecting**, and you can put it back.

**Gate:** this is the phase the pitch depends on. If backend transfer proves visibly disruptive
in ways players reject, that is the second falsification condition and it surfaces here.

---

## Phase 5: Authoring and approvals (M4)

**Goal:** make it demonstrable to someone who does not read YAML.

| Engineer 1 | Engineer 2 | Engineer 3 |
|---|---|---|
| `packages/authoring/`: plain English to a validated rule document, with the validation-repair loop. | Wire approval-token redemption into `building`; refuse on digest mismatch. | The review screen with semantic diffs. Approve mints the token. |

**Exit criteria:** someone types a sentence, sees a readable diff of what it will do
("hostile spawns near spawn: 0.5x -> 1.4x", never a JSON patch), approves it, and the world
changes around them.

**Gate:** the append-only and write-once rules are verified by test, not by intention. A rewritten
rule version must be impossible; a changed rule is a new version and needs a new approval. Without
this the safety argument is decorative.

---

## Phase 6: Agent surfaces (M5)

**Goal:** the phase that makes this an AI systems project rather than an infrastructure one. It is
cheap once the API exists: the MCP server is a thin wrapper over endpoints that already work.

1. Engineer 1 ships `apps/mcp/` with the three tool classes, schemas generated from
   `packages/contracts`.
2. READ tools scoped to the caller's own servers. DRAFT tools rate-limited. ACT tools fail closed
   without an approval token, with a structured refusal that names the missing approval so the
   agent's correct next move is to ask a human rather than retry.
3. The CLI reaches parity with the MCP surface, machine-token authenticated.
4. Every tool call logged with caller, arguments and outcome.

**Exit criteria:** an agent in a terminal inspects a world, drafts a rule change, argues for it,
and **is correctly refused** until a human approves, then succeeds once approved.

**Gate:** the refusal is as important a demo as the success. It is what proves the agent is
bounded by design rather than by prompt.

---

## Phase 7: Phone client (M6)

**Goal:** close the human-in-the-loop gate in seconds rather than hours. The person who owns a
server is very often a teenager with a phone, not an engineer at a desk. If approving needs a
laptop, proposals sit unread and the loop never closes.

Engineer 3 ships four screens and no more: Proposals (push notification, semantic diff, approve or
reject), Rollback (one thumb), Servers, World feed. SSE with `Last-Event-ID` replay, so a phone
that loses signal resumes rather than restarts.

The app is read-plus-approve. Authoring stays on the web or through an agent: a gate with an
authoring surface attached is a gate people use to rubber-stamp their own drafts.

**Exit criteria:** a proposal arrives as a notification and is approved from a phone while
standing in the world.

---

## Phase 8: Director and evaluation (M7)

**Goal:** the loop closes, and the environment grades the agent rather than the agent grading
itself.

1. Engineer 1 ships the Director: observe aggregates, propose a rule-set diff with rationale and
   confidence, queue it. Never deploys. One proposal per server per hour.
2. Rejection reasons are captured: the most useful signal in the system.
3. The evaluation harness records `pre_post` around each deployment, with a third arm of randomly
   sampled valid rule changes as the baseline.
4. Engineer 1 requests the experiments table by PR to Engineer 3; the record shape is in
   CONTEXT.md and it is the one table the source documents leave unnamed.
5. Engineer 3 renders proposals on web and phone.

**Exit criteria:** the server proposes a change from observed play, an owner approves it from a
phone, and the harness reports whether it helped.

**Gate:** report delta and n with the confounds named. Do not claim a controlled A/B: pre/post on
one server is an interrupted time series, uncontrolled for order, time of day, novelty and player
memory. A reported negative result is worth more than a clean claim nobody believes.

---

## Phase 9: Hardening (M8)

**Goal:** make it real rather than demonstrable.

| Engineer 1 | Engineer 2 | Engineer 3 |
|---|---|---|
| Rate limits enforced end to end. Injection-resistance test suite. | Deployment queue, quota headroom, snapshot pruning, reconciliation from Kubernetes state. | Token expiry and single-use under concurrency. Audit trail completeness. |

**Exit criteria:** a deployment survives the backend being killed mid-flight and is reconciled
from Kubernetes state, exactly as the backup module already reconciles Jobs · a user at their
quota ceiling can still deploy, because headroom was reserved · snapshots are pruned on a
schedule · injection attempts through chat, signs, item names and player names reach the Director
as data and cannot produce a deployment.

---

## Phase 10: Integration and demo

**Goal:** the three tracks become one product, and it survives being shown to people.

1. Run every cross-engineer integration test from all three work orders' final sections.
2. Verify the eight seams end to end with no mocks anywhere in the path.
3. Rehearse the demonstration, in order, with the game on screen throughout:
   be in the world · an agent drafts a change and is refused · approve on the phone · watch the
   deployment while still playing · the handover through the lobby · **deliberately break it and
   roll back from the phone**, saying out loud what rollback does not undo · the Director's
   proposal with a before/after result.
4. Steps 2 and 6 (the refused change and the reversible one) are what convince engineers.
   Rehearse those two hardest.

**The project is complete when:** every phase above is closed, every engineer's definition-of-done
checklist is green, and the demonstration runs end to end with no mock in the path.

---
---

# Section 2. Engineer 1: AI & Agent Systems

Work order: [ENGINEER-1.md](ENGINEER-1.md). You own the action space, and the action space is the
security boundary.

## Phase 0: Foundation and lock

1. Read `farlands-app/src/lib/plugin-builder/types.ts` in the baseline repository, end to end,
   before designing a single tool. It defines what a rule can express and therefore the entire
   capability ceiling.
2. Read `validation.ts`. Confirm it has no bypass path for "trusted" output, and if it has one,
   raise it as a Phase 0 blocker.
3. Draft the MCP tool table: every tool, its class, its arguments, its return shape. Submit the
   types to Engineer 3 as the first `packages/contracts` PR.
4. Agree the `plugin-runtime/telemetry/` package boundary with Engineer 3.
5. Confirm with Engineer 2 that rules must be stateless or persist through the world, because a
   backend transfer does not preserve in-memory plugin state, and that this is enforced in
   `validation.ts`, which means raising it with Engineer 3 now rather than discovering it in
   production.

## Phase 1: Baseline running

6. Write the Java telemetry emitter: the fixed small event set (join, leave, death, block placed
   or broken in a region, time in region, chat volume), NDJSON over the in-cluster Service the
   routing plugin already uses.
7. Run it against a local Paper server and **record a telemetry fixture**. Everything you build
   for the next three phases develops against this file, not against a cluster.
8. Stand up `apps/cli/` skeleton against Engineer 3's mock API. Establish the two output modes
   now, before there are commands worth streaming.

## Phase 2: Prove the world moves

9. No dependency on Phase 2. Keep building.
10. When Engineer 2 reports the M1 number, wire it into `preview_deploy`'s estimated
    player-visible window. Until then that field returns `"unmeasured"`, never a guess.

## Phase 3: Manual deployment

11. Build `apps/api/src/modules/telemetry/`: ingest at `POST /internal/telemetry/:serverId`,
    cluster-internal only.
12. Build the rolling-window aggregation into `world_events_rollup`. Request the table by PR to
    Engineer 3.
13. **Do not store raw events.** They grow without bound and nothing reads them.
14. Extend the CLI: `servers list`, `telemetry`, `logs --follow` against real endpoints as they
    land.

## Phase 4: Cutover

15. Wire `farlands deploy --watch` to the real SSE stream. One NDJSON object per state
    transition, using Engineer 2's canonical state names verbatim. Do not invent friendlier
    ones.
16. Verify the CLI can detect a stall and abort, which is the whole reason the event stream is
    discrete and named.

## Phase 5: Authoring and approvals

17. Build `packages/authoring/`: plain English in, a rule document out.
18. Implement the validation-repair loop: generate, validate against `validation.ts`, feed
    failures back, retry with a bounded attempt count, then fail with a legible error rather than
    emit an invalid document.
19. Confirm the loop emits JSON and only JSON. The model never writes Java. That constraint is
    what makes the product shippable and what keeps you off AuraFlow's ground.
20. Hand `authorRules(serverId, prompt)` to Engineer 3 for their author route. The boundary is the
    function call; their route body is one call into your function.

## Phase 6: Agent surfaces

21. Ship `apps/mcp/` with schemas generated from `packages/contracts`.
22. READ tools: scope every response to the caller's own servers. `get_world_telemetry` is a
    behavioural record of named players; treat it as personal data, not public inventory.
23. DRAFT tools: rate-limit them. They have no live effect but they invoke a model and create
    durable rows, so the cost is real.
24. ACT tools: carry the approval token, never validate it yourself; Engineer 3's module does
    that. On absence, return a structured refusal that names the missing approval.
25. Log every tool call with caller, arguments and outcome.
26. Bring the CLI to parity. `deploy` and `rollback` fail without an approval token exactly as the
    MCP act tools do. The CLI is a client, not a privilege escalation.

## Phase 7: Phone client

27. No work of yours in this phase. Support Engineer 3 on the proposal payload shape if the diff
    rendering needs more than the rollup provides.

## Phase 8: Director and evaluation

28. Build `apps/api/src/modules/director/`: read aggregates, emit a proposal row with suggested
    rules, rationale and confidence, status `pending`.
29. Enforce one proposal per server per hour. A world that changes constantly is not alive, it is
    unstable.
30. The Director never deploys. It queues a row a human must approve. There is no code path from
    the Director to a live world.
31. Capture rejection reasons. They are the most useful signal in the system.
32. Build the evaluation harness. `pre_post` is the realistic default; `parallel` means two
    servers and a split population and costs double.
33. Add the random-valid-rule baseline arm. Without it, "better than nothing" is untested.
34. Request the experiments table by PR to Engineer 3.
35. Report delta and n. Never report a winner.

## Phase 9: Hardening

36. Build the injection test suite: instructions planted in chat, on signs, in item names and in
    player names. Every one must reach the Director as data and produce, at most, a proposal a
    human sees.
37. Verify draft-tool rate limits hold under concurrent agents.
38. If you find yourself proposing an auto-approval tier to solve approval fatigue, stop: you are
    proposing to delete the strongest property in the system. Batching is the answer.

## Phase 10: Integration

39. Run your integration checklist against the real API with no mocks.
40. Rehearse demo step 2 (the refused deployment) until the structured refusal is legible on a
    projector in five seconds.

---
---

# Section 3. Engineer 2: Cloud & Deployment Infrastructure

Work order: [ENGINEER-2.md](ENGINEER-2.md). You own the mechanism, the AWS account, and the
invariant.

## Phase 0: Foundation and lock

1. Re-point `infra/tofu/` at your own AWS account. Strip every account identifier and bucket name
   from the baseline. `tofu plan` clean, TFLint and Checkov passing in CI.
2. Stand up the cluster: VPC, EKS, the Karpenter pool on `t3.small`/`t3.medium` within the
   8 CPU / 16 Gi ceiling, NLB, buckets, EKS Pod Identity service accounts with no AWS keys in
   containers.
3. Check the deployed Velocity version. Upstream is 4.1.1 on Java 25. If the cluster runs 3.x,
   upgrading is Phase 0 work, not a later chore.
4. Open `backup/service.ts` in the baseline and confirm whether the backup Job co-schedules with
   the running server pod. ReadWriteOnce means one node, not one pod; this determines which
   world-copy strategies are available to you.
5. **Deliver the local-parity path**: kind or k3d reproducing namespaces and quotas, plus
   docker-compose Postgres. You own the AWS account, so the other two must never need it. This is
   a deliverable, not a nicety.

## Phase 1: Baseline running (M0)

6. Namespace per tenant, not per team. `ResourceQuota` and `LimitRange` mirroring the numbers
   `QuotaService` enforces at the application layer, so the cluster is a backstop rather than a
   duplicate.
7. Default-deny `NetworkPolicy` between tenant namespaces. Verify with a test that actually tries
   to cross.
8. RCON: the image already enables it on 25575. Your work item is a **stable password**, delivered
   as a per-tenant Secret via `RCON_PASSWORD_FILE`, because the image generates a random one per
   startup that would silently break the control channel on every restart. Never a ConfigMap.
   Keep 25575 inside the NetworkPolicy.
9. Provisioning creates a server that boots and is joinable at its stable hostname. This is the
   M0 baseline you must not break.

## Phase 2: Prove the world moves (M1), your phase

10. Build the pod-to-pod stream (strategy B): a sidecar in pod A that tars `world/` and streams
    over HTTP to a receiver init-container in pod B. Never touches S3, never needs both volumes
    on one node, and (the reason it is the pick) supports incremental pre-sync followed by a
    short delta.
11. Pre-sync a realistic world while A is live, and confirm A's TPS stays within an agreed budget.
12. Run the freeze by hand in exact order: `save-off`, then `save-all flush`, then delta, then
    `save-on`. Assert the order in a test: `save-off` must precede the flush so no autosave fires
    between the flush completing and saving being disabled.
13. Start Paper on B against the delivered world. It cannot start earlier: a running Paper server
    holds `world/session.lock`, keeps chunks in memory, and rewrites region files on its next
    autosave.
14. **Measure delta sync plus Paper cold boot.** Record world size, delta size and conditions.
15. Circulate the number to Engineers 1 and 3 the day it exists. It is a hard input to their
    designs, and it is the falsification test for the whole project.

## Phase 3: Manual deployment (M2)

16. Deploy the lobby: one shared always-on minimal Paper instance with a void world and a status
    message. One per cluster, not one per tenant: the capacity ceiling forbids it and the lobby
    holds no tenant state.
17. Second provisioning entry point: a candidate pod with its PVC and receiver init-container,
    **Paper deliberately not started**. Its name must not collide with
    `game_servers_user_active_name_idx`.
18. Build the controller through `verifying`: `building`, `staging`, `presync`, `freezing`,
    `verifying`. Every transition writes its `deployments` row.
19. Drain players to the lobby **before** the freeze, not after. `save-off` is not a full write
    barrier: player-triggered writes still happen, and anything a player does on A during the
    freeze is thrown away when A drains.
20. **Enforce the invariant structurally.** Make the destructive operations on A unreachable from
    any pre-cutover state: a separate client object handed over at the state transition, or at
    minimum a runtime assertion that panics.
21. Build every abort path. Abort at each of `building`, `staging`, `presync`, `freezing`,
    `verifying` must return players to A and leave the cluster exactly as it was: no orphaned pod,
    PVC, Service or route.
22. Test the abort path harder than the happy path. The happy path runs once per deployment; the
    abort path runs whenever anything goes wrong.

## Phase 4: Cutover (M3)

23. Add `GET /internal/velocity/transfers` and `POST /internal/velocity/transfers/:id/ack` to the
    existing routing poll rather than inventing a new channel.
24. Extend the routing plugin: on seeing a transfer, resolve the target and issue a connection
    request per connected player. The TCP session to the proxy never drops; only the backend
    behind it changes.
25. **Register route B during `staging`**, well before cutover: a new route can take up to a full
    polling interval to become visible.
26. Complete the state machine: `cutover` moves every player lobby to B, `draining` retires A and
    retains its snapshot, B becomes the server of record.
27. Implement rule rollback: mechanically an ordinary deployment with source and target reversed.
28. Publish deployment state events into Engineer 3's SSE envelope, using the canonical state
    names typed in `packages/contracts`.

## Phase 5: Authoring and approvals (M4)

29. Wire approval-token redemption into `building`: call Engineer 3's approvals module, never
    implement validation yourself.
30. Recompute the content digest from the freshly built artefact and **refuse on mismatch**. This
    is the check that closes time-of-check/time-of-use, and it lives in your state machine.

## Phase 6: Agent surfaces (M5)

31. No new work. Confirm `POST /v1/servers/:id/deploy` returns the structured refusal shape
    Engineer 1's act tools expect when the approval token is missing or spent.

## Phase 7: Phone client (M6)

32. No work of yours. Confirm deployment progress events carry enough for the phone's feed.

## Phase 8: Director and evaluation (M7)

33. If the harness runs a `parallel` arm, provision the second server. Two arms means two servers
    and double the infrastructure; say so when it is proposed.

## Phase 9: Hardening (M8)

34. Build the cluster-wide deployment queue with a small concurrency limit. One server plus a
    candidate plus the lobby consumes a meaningful fraction of an 8 CPU / 16 Gi pool.
35. Surface queue position rather than letting a deployment sit silently in `staging` while pods
    stay Pending.
36. Extend quota with **deployment headroom**: reserve the candidate's CPU, memory and storage for
    the deployment's duration and release on completion or abort. Without it, a user at their
    ceiling can never deploy: a failure mode that looks like a bug and gets reported as one.
37. Add snapshot retention: count and age limits, pruned on a schedule. Every deployment retains
    its predecessor's snapshot and that cost accumulates.
38. Reconcile in-flight deployments from Kubernetes state after a backend restart, copying the
    pattern the backup module already uses for Jobs.

## Phase 10: Integration

39. Kill the backend mid-deployment, in each state, and confirm reconciliation.
40. Rehearse demo steps 4 and 5: the deployment watched while still playing, and the handover.

---
---

# Section 4. Engineer 3: Platform Core & Human Surfaces

Work order: [ENGINEER-3.md](ENGINEER-3.md). Yours is the widest scope, and two of your
deliverables unblock the other two engineers, so your build order is not negotiable: contracts
and the build pipeline ship before anything with a user interface.

## Phase 0: Foundation and lock

1. Scaffold the monorepo to the target layout, including the three decided deviations:
   `packages/plugin-builder`, `packages/authoring`, and `packages/contracts` owned here.
2. Open your two `[CONFIRM]` files first: `types.ts` (the rule vocabulary, which is the entire
   agent action space) and `jar-builder.ts` (how the JSON is injected: resource entry, manifest
   attribute or rewritten class, which determines whether a rebuild is cheap enough to sit inside
   a deployment).
3. Lift `packages/plugin-builder` wholesale: all nine files. The eighth and ninth sit under
   `app/api/plugin-builder/` (`route.ts`, `json-builder.ts`), not in `lib/`, and are easy to miss
   when copying. Do not restructure.
4. Lift `plugin-runtime/`: `PluginMain.java`, `config/`, `listeners/`, `models/`. Do not
   restructure. Agree the `telemetry/` package boundary with Engineer 1.
5. Confirm how the runtime loads its config: if it reads from the JAR only, every change needs a
   rebuild; if it can read an external path, a class of changes becomes a file write instead.
6. Pin the Paper build in the template. Treat a version bump as a deliberate migration: 26.1
   turned gamerules into a registry and renamed them, 26.2 removed deprecated API.
7. **Lock `packages/contracts` v1** and publish it. You are the scribe from here on.

## Phase 1: Baseline running (M0)

8. Write the five migrations from head `0005`: `rule_set_versions`, `deployments`,
   `approval_tokens`, `world_events_rollup`, `proposals`. Follow the existing conventions:
   `gen_random_uuid()`, partial unique indexes excluding soft-deleted rows.
9. Enforce the two structural rules in the schema, not in a comment: `rule_set_versions` is
   **append-only** with **write-once** S3 objects behind `json_url`; `deployments` stores
   `approval_token_hash` and never a raw token.
10. Expose `buildRuleJar(ruleJson) -> { jarUrl, contentDigest }`. Compute the digest from the
    built artefact; never trust one from input. This unblocks Engineer 2's `building` state.
11. Ship the **mock API**: contract-shaped fixtures, scripted deployment states, replayable SSE,
    fake approvals. This unblocks all four clients, including your own.

## Phase 2: Prove the world moves

12. No dependency. Keep building.
13. When Engineer 2 reports the M1 number, it becomes the input to your lobby copy and your
    deployment progress UI. Until then, the UI says "measuring", not a guess.

## Phase 3: Manual deployment (M2)

14. Build `approvals/`: minting, hashing, redemption checks, expiry, single-use.
15. The token is bound to `content_digest` (a hash of the exact rule JSON and built JAR the human
    saw), not to a version name.
16. Redeemable only by the principal in `issued_to`. Otherwise a leaked token is bearer authority
    over a live world.
17. Single-use, enforced by `consumed_at`. A token spent by a deployment that later aborts is
    spent; a retry needs fresh approval, so an agent cannot bank authority.
18. `POST /v1/approvals` accepts a human session only. Never a machine token.
19. Write the test that proves a rule version cannot be rewritten. Without it, the entire safety
    argument is decorative.

## Phase 4: Cutover (M3)

20. Build `servers/` deployment states as the read surface, hosting the state union Engineer 2
    authors in contracts.
21. Ship real SSE at `GET /v1/servers/:id/events` with `Last-Event-ID` replay, consumed by web,
    CLI and phone. Engineer 2 publishes deployment states into your envelope.
22. Ship `GET /v1/servers/:id/logs`.
23. Web: deployment progress with queue position, rendered from the real stream.

## Phase 5: Authoring and approvals (M4)

24. Extend `auth/` with machine tokens for the CLI and MCP server.
25. Build `rules/` registry. The DTO is a pointer (`{ name, description?, gameType, jsonUrl,
    version? }`) to a JSON document in S3, not the document itself. That indirection is exactly
    what versioning and rollback need.
26. Ship `POST /v1/servers/:id/rule-sets/author`. The route body is one call into Engineer 1's
    `authorRules()`. Server-scoped, because a server's first rule set has no id yet and a
    rule-set-scoped route cannot be the entry point.
27. Ship `POST /v1/servers/:id/preview`: semantic diff, estimated freeze, quota impact, rollback
    target.
28. **Build the review screen.** Fetch both rule documents from S3 by `jsonUrl` and render the
    difference **semantically**: "hostile spawns near spawn: 0.5x -> 1.4x". Never a raw JSON
    patch. A diff nobody can read is a gate nobody uses.
29. Approve mints the token. Reject records the reason.
30. Rollback in the UI: rule rollback is the default one-tap action, and the copy says honestly
    that it stops the rule acting further but does not undo what the rule already did. Snapshot
    restore is disaster recovery only, behind an explicit confirmation that names the data loss.

## Phase 6: Agent surfaces (M5)

31. No new work. Confirm your contracts export cleanly as MCP tool schemas so Engineer 1's surface
    cannot drift from yours.

## Phase 7: Phone client (M6), your phase

32. Build the Expo client. Four screens, in this order: **Proposals** (push notification, semantic
    diff, rationale, confidence, approve or reject), **Rollback** (deployment history, one-tap
    rule rollback), **Servers** (live status, player count, TPS, the address to share), **World
    feed** (SSE).
33. SSE with a `Last-Event-ID` replay buffer, never long-polling: a phone that loses signal in a
    lift must resume, not restart.
34. Push via Expo notifications.
35. Keep it read-plus-approve. No authoring on the phone, deliberately.

## Phase 8: Director and evaluation (M7)

36. Ship `GET /v1/servers/:id/proposals`, `POST /v1/proposals/:id/approve`,
    `POST /v1/proposals/:id/reject`. Approve mints a token and calls Engineer 2's deploy endpoint:
    you mint and call, you do not own deployment initiation.
37. Render proposals on web and phone with the rationale and confidence visible.
38. Add Engineer 1's experiments table to the migration sequence by PR.

## Phase 9: Hardening (M8)

39. Test token expiry and single-use under concurrency: two redemptions of one token must not
    both succeed.
40. Verify the audit trail: every rule version records its source (`form`, `agent` or `director`),
    the prompt that produced it, and the human who approved it. The `deployments` table is the
    audit log of record.

## Phase 10: Integration

41. Run every integration test with no mock in the path.
42. Rehearse demo steps 3 and 6: the phone approval, and the deliberate break followed by
    rollback.

## Your cut line, if time runs short

Cut **mobile** first: it is Phase 7, it trails the web review screen by design, and the web gate
covers every approval the phone would have handled. The demo loses "approved from a phone", which
hurts, but the product still exists. Cut the **plugin-builder UI** second: rules can still be
authored through the author endpoint, the CLI and the MCP tools.

What survives any cut: contracts, schema, the build pipeline, the runtime, the mock, approvals,
the API core, and the web review screen. Below that line there is no product, only components.
