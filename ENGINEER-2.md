# ENGINEER 2: Cloud & Deployment Infrastructure ("the mechanism")

This is your complete work order. It assumes you have read `CONTEXT.md`. It repeats detail
from the shared context only where that detail is load-bearing for your work, and for you,
the mechanism detail *is* the work, so this document goes deep where the others summarise.

Baseline repository: `ACM-VIT/farlands @ main`. You will be lifting, extending and
re-pointing code from it constantly; paths below reference it directly.

---

## 1. Your remit in one paragraph

You own the enabling mechanism: applying a new rule set to a running Paper server by
standing up a health-checked replacement, moving the world into it, and moving the players
across the proxy, so nobody is disconnected and any change can be undone. The build plan
is blunt about the priority and so is this document: if deployment works, everything else
in this project is plumbing; if it does not, nothing else is worth building. You also own
the AWS account the project runs in (your credits fund the cluster), and that ownership
carries an obligation: the other two engineers must never need the account. That makes
local-parity tooling (a kind or k3d cluster reproducing the namespaces and quotas, plus a
docker-compose Postgres) part of your deliverable, not a nicety. Deliver it early, because
Engineer 1 and Engineer 3 are blocked on nothing else you produce until integration,
except the M1 measurement, which is due before anyone builds on top of it.

---

## 2. What you own

| Path | Responsibility |
|---|---|
| `infra/tofu/` | OpenTofu re-pointed at your own AWS account: VPC, EKS, Karpenter pool (`t3.small`/`t3.medium`, 8 CPU / 16 Gi ceiling), NLB, S3 buckets and prefixes, EKS Pod Identity service accounts. TFLint and Checkov enforced in CI, as the baseline already does. |
| `infra/k8s/` | Namespace per tenant, `ResourceQuota` and `LimitRange` mirroring the application-layer quota numbers, default-deny `NetworkPolicy` between tenants, Paper workload manifests, the RCON password as a Secret via `RCON_PASSWORD_FILE`, and the always-on lobby workload. |
| `infra/velocity/` | Velocity (confirm or upgrade to 4.1.1, Java 25) and the dynamic-routing plugin extended with player transfer. |
| `apps/api/src/modules/provisioning/` | Second entry point on the lifted module: provision a candidate pod with Paper deliberately NOT started. |
| `apps/api/src/modules/backup/` | Snapshots per deployment, world handover, reconciliation against Kubernetes Job state. |
| `apps/api/src/modules/deploy/` | The deployment controller: the state machine, every abort path, the rollback pointer, reconciliation after a backend restart, and the cluster-wide deployment queue. |
| `apps/api/src/modules/quota/` (extension) | Deployment headroom reservation; snapshot retention limits with scheduled pruning. |
| The world-move mechanism | Strategy B: a sidecar in pod A that tars `world/` and streams over HTTP to a receiver init-container in pod B; RCON as the control channel. |
| The deployment queue | Cluster-wide, small concurrency limit, queue position surfaced. |
| Velocity transfer endpoints | `GET /internal/velocity/transfers`, `POST /internal/velocity/transfers/:id/ack`. |
| Public deployment endpoints | `POST /v1/servers/:id/deploy`, `GET /v1/deployments/:id`, `POST /v1/deployments/:id/abort`, `POST /v1/servers/:id/rollback`, `POST /v1/servers/:id/restore`. |

---

## 3. THE INVARIANT

> **Pod A remains authoritative and recoverable until cutover succeeds.**
>
> No code path may terminate, unmount or modify A before B's health check has passed.
> Every failure before cutover costs a deleted candidate and a return trip from the
> lobby: no player noticed, no world changed.
>
> This single rule is the difference between a deployable system and PlugManX.

Enforce it **in code, not by convention**. Concretely: the controller must have no
function reachable from any pre-cutover state that stops, deletes, scales down, unmounts
or writes to pod A or its PVC. Structure the controller so that the only operations
available before `cutover` completes are operations on B and on routing: make the
destructive operations on A callable only from `draining`, and make that unrepresentable
earlier (a separate client object handed over at the state transition is one way; a
runtime assertion that panics is the minimum).

Test the abort path harder than the happy path. The happy path runs once per deployment;
the abort path is what runs when the JAR is bad, the sync stalls, the health check fails,
Karpenter cannot schedule B, or the backend restarts mid-flight. Every abort test must
assert two things: players are back on A, and the cluster state is exactly what it was
before the deployment started: no orphaned pod, PVC, Service or route.

---

## 4. The load-bearing problem: moving the world

Pod B cannot share pod A's volume, for two independent reasons (one from AWS, one from
Minecraft):

1. **The storage layer forbids it.** The `farlands-gp3` StorageClass is EBS-backed and
   `ReadWriteOnce` (attachable to one node at a time), and gp3 does not support
   Multi-Attach. Two pods on different nodes cannot mount the same volume.
2. **Paper forbids it anyway.** Even if both pods were co-scheduled on one node (RWO is
   per-node, not per-pod), `world/session.lock` forbids two Paper servers sharing a world
   directory. A running server holds the lock, keeps loaded chunks in memory and rewrites
   region files on its next autosave.

The world must be copied. Three strategies were considered:

| Strategy | How | Trade-off |
|---|---|---|
| A. Via S3 | Existing backup Job archives PVC A to S3; existing restore Job unpacks into PVC B. Zero new mechanism. | Two full transfers through S3: the slowest path, and it cannot do a cheap incremental delta. |
| B. Pod-to-pod stream (**PICKED**) | A sidecar in pod A tars `world/` and streams over HTTP to a receiver init-container in pod B. Never touches S3, never needs both volumes on one node. | New code, but small. |
| C. EBS volume snapshot | CSI `VolumeSnapshot` of PVC A, then a new PVC provisioned `dataSource`-from-snapshot. | Cleanest and most Kubernetes-native, but restored gp3 volumes lazily fetch blocks on first access, so early world reads are slow unless Fast Snapshot Restore is enabled, which costs real money per snapshot-hour. |

**Why B is the pick:** it sidesteps every volume-attachment constraint, and it is the only
strategy that supports an incremental pre-sync followed by a short delta, which is the
only way to keep the freeze window down. Strategies A and C are all-or-nothing transfers;
the freeze window would be the full world size every time.

**Strategy A is your fallback and your first test rig.** The backup and restore Jobs
already exist in the baseline (`backend/src/modules/backup/`). Use them for the very
first end-to-end test (a world moves from A to B before you have written a line of
sidecar code), and keep them as the fallback if the sidecar stream proves fiddly.

One `[CONFIRM]` from the build plan lands on your desk: open
`backend/src/modules/backup/service.ts` in the baseline and check whether the backup Job
is co-scheduled with the server pod. RWO means one node, not one pod: a Job can share
the volume if it lands on the same node. This determines exactly which copy paths are
available to you and how the sidecar must mount.

---

## 5. The sequence, and why the order is what it is

```
PRE-SYNC     pod A live, players playing, no freeze
             stream world/  A -> B  while the game runs
             the copy is inconsistent, and that is fine:
             it exists only to shrink the delta

DRAIN        Velocity moves players A -> lobby
             a holding area, not a kick; the proxy session never drops

FREEZE       the only player-visible window
             rcon A: save-off          disable AUTOSAVE first, so no
                                       autosave can fire mid-flush
             rcon A: save-all flush    block until chunks are on disk
             delta-sync A -> B         only what changed during pre-sync
             rcon A: save-on

START B      Paper boots on B against the delivered world
             health check: up, rules loaded, no startup
             exceptions, TPS sane over a sampled window
             any failure -> abort, delete B, players return to A

CUTOVER      Velocity moves players lobby -> B
             backend-to-backend, no client reconnect, no kick

DRAIN A      A stops accepting, snapshot retained, A terminates
```

The RCON calls, in exact order: `save-off` -> `save-all flush` -> delta-sync -> `save-on`.

### The three things that are easy to get wrong

1. **`save-off` must precede `save-all flush`.** If the order is reversed, an automatic
   save can fire in the gap between the flush completing and saving being disabled, and
   the delta you then copy is inconsistent with what is on A's disk. Every canonical
   Minecraft backup script does it in this order. Yours must too.

2. **`save-off` is not a full write barrier.** It disables *automatic* world saves.
   Player-triggered writes still happen: a player disconnecting during the freeze writes
   their playerdata. This is why the drain to the lobby happens **before** the freeze,
   not after: with no players on A, there are no player-triggered writes to race the
   delta. The alternative (accepting that a player who quits mid-freeze may lose their
   last few seconds) is a data-loss window the design does not need to have.

3. **Paper cannot start on B until the world has landed.** A running server holds
   `session.lock`, keeps chunks in memory, and files written underneath it are ignored or
   overwritten; replacing `session.lock` triggers a hard shutdown. So Paper's cold boot
   on B sits **inside** the freeze window. Budget for it, and quote it honestly: the
   player-visible window is the delta sync *plus* a Paper cold boot: tens of seconds,
   not an instant. This is exactly what M1 measures (§12).

---

## 6. RCON as the control channel

The `itzg/minecraft-server` image the baseline already runs supports RCON on port 25575,
and `ENABLE_RCON` is on by default. **The work item is therefore not enabling RCON; it
is supplying a known, stable password.** The image generates a random password per
startup otherwise, which would silently break the control channel on every restart: the
first pod restart after M0 and every deployment thereafter would leave the controller
unable to issue `save-off`, failing in a way that looks like a network problem.

Delivery rules:

- The password is a Kubernetes **Secret**, mounted via `RCON_PASSWORD_FILE`. Never a
  ConfigMap: in the baseline's shared-namespace model a ConfigMap is readable by every
  other contributor, and in your per-tenant model a ConfigMap is still the wrong
  primitive for a credential.
- Scope it **per tenant** (§9). It is the first secret that must not live anywhere
  another tenant can read.
- Keep 25575 inside the existing per-server `NetworkPolicy` so only the backend can reach
  it. RCON is unauthenticated beyond the password; the network boundary is doing real
  work here.

---

## 7. The deployment controller state machine

`apps/api/src/modules/deploy/`. This is the product. Everything else depends on it.

```
idle
  │  POST /v1/servers/:id/deploy { ruleSetVersion, approvalToken }
  ▼
building     build JAR from template + rule JSON; validate;
  │          redeem approval token against recomputed content digest
  │          fail -> abort, nothing happened
  ▼
staging      provision candidate pod B + PVC.
  │          Paper is NOT started. Register route B with Velocity.
  │          fail -> abort, delete B, A untouched
  ▼
presync      stream world A -> B while A serves
  │          fail -> abort, delete B, A untouched
  ▼
freezing     drain players to lobby; save-off; save-all flush;
  │          delta sync; save-on
  │          fail -> abort, delete B, return players to A
  ▼
verifying    start Paper on B; health check: up, rules loaded,
  │          no startup exceptions, TPS sane over a sampled window
  │          fail -> abort, delete B, return players
  │          from lobby to A. Nothing lost.
  ▼
cutover      Velocity moves players lobby -> B
  │          fail -> return players to A, delete B,
  │          mark deployment failed
  ▼
draining     A stops accepting, snapshot retained, A terminates
  ▼
idle         B is the server of record; rollback pointer updated
```

| State | What happens | What an abort here costs | Must be true to advance |
|---|---|---|---|
| `building` | `buildRuleJar()` produces the JAR; approval token redeemed; content digest recomputed and checked against the token | Nothing. No cluster resource exists yet. The token is spent; a retry needs a fresh approval. | JAR built, validation passed, digest matches the token's `content_digest`, `issued_to` matches the caller. |
| `staging` | Candidate pod B and its PVC provisioned, Paper not started; route B registered with Velocity | Delete B and its PVC. A untouched, players untouched. | B's pod is scheduled and its receiver init-container is ready; route B registered. |
| `presync` | Sidecar on A streams `world/` to B's receiver while A serves | Delete B. A untouched, players untouched. | Pre-sync stream completed without error. Consistency is not required, only completeness of the bulk copy. |
| `freezing` | Drain to lobby; `save-off`; `save-all flush`; delta sync; `save-on` | Delete B; `save-on` on A; return players from lobby to A. A's disk is consistent: the flush completed or the abort ran before it. | All players in lobby; flush returned; delta transferred; `save-on` issued. |
| `verifying` | Paper starts on B against the delivered world; health check runs | Delete B; return players from lobby to A. Nothing lost: this is the abort the whole design exists to make cheap. | B up, rules loaded, no startup exceptions, TPS sane over the sampled window. |
| `cutover` | Velocity transfers every player lobby -> B | The expensive one: return players to A, delete B, mark the deployment failed. A partial cutover (some players on B, some in lobby) must resolve to everyone on exactly one server: pick A, because A is still authoritative. | Every player acked onto B. Only now does the invariant release. |
| `draining` | A stops accepting connections; snapshot retained; A terminates | No abort from here. Cutover succeeded; B is the world of record. A failure in draining is an operational cleanup problem, not a player-facing one. | A terminated; snapshot recorded; rollback pointer updated. |

**The rollback pointer.** On every successful deployment, record `from_version` as the
rollback target and retain A's snapshot (the `snapshot_id` on the `deployments` row).
Rule rollback (`POST /v1/servers/:id/rollback`) is mechanically an ordinary deployment
with source and target reversed: it goes through this same state machine, same lobby,
same health check. It preserves play since the change. It stops the rule acting further;
it does not undo what the rule already did. Snapshot restore
(`POST /v1/servers/:id/restore`) is the separate disaster-recovery path and must require
an explicit confirmation naming the data loss.

**Reconciliation after a backend restart.** One row per attempt lands in the
`deployments` table (schema owned by Engineer 3; see §13), including failures. On
startup, the controller must read every row in a non-terminal state and reconcile it
against actual Kubernetes state: does the candidate pod exist, is Paper running on it,
where are the players. The model to copy is the baseline's backup module:
`backend/src/modules/backup/` and `backend/src/backup-sync.ts` reconcile backup records
against labelled Job state after a restart, and that pattern (label the resources with
the deployment id, treat Kubernetes as the source of truth, converge the row) is exactly
what the controller needs. A deployment that was pre-cutover reconciles to an abort:
delete B, return players to A. A deployment that had passed cutover reconciles forward
to `draining`. This is M8's done-condition and you should build with it in mind from the
start rather than retrofit it.

**One collision to avoid:** the baseline enforces active-server-name uniqueness per user
via `game_servers_user_active_name_idx` on `(user_id, name)` where
`current_state <> 'deleted'`. Your candidate must not collide with it: name candidates
distinctly (for example a deployment-scoped suffix) rather than weakening the index.

**The queue.** Deployments serialise behind a cluster-wide queue with a small concurrency
limit (§10). `POST /v1/servers/:id/deploy` returns immediately with the deployment id and
queue position; the state machine starts when the queue admits it.

---

## 8. Velocity: the lobby and the transfer

`infra/velocity/`. First, confirm the deployed Velocity version: current upstream is
4.1.1 (Java 25). If the baseline cluster runs 3.x, upgrading is part of M0, not a later
chore.

**The lobby** is a small always-on server: a minimal Paper instance with a void world and
a status message. It is the waiting room during the freeze, and it is what makes "no
disconnect" true even when the handover takes thirty seconds. It lives in `infra/k8s/`
as a first-class workload, sized minimally, and it is shared: one lobby for the
cluster, not one per tenant.

**Why drain before the freeze, not after.** If players stayed on A while B booted,
everything they did in those tens of seconds would be written to A's disk and thrown away
when A drains. Moving players to the lobby before the freeze is what makes the handover
lossless: it is not a UX flourish, it is the correctness argument. The honest product
claim this buys is "nobody gets disconnected", not "nobody notices". Players see a
holding area with a progress message (standard practice on every large Minecraft
network) instead of a kick to the server list.

**The transfer channel.** Extend the existing routing poll rather than inventing a new
channel. The baseline plugin already polls:

```
GET /internal/velocity/routes                      (exists today)
    -> [{ hostname, serviceHost, port }]

GET /internal/velocity/transfers                   NEW
    -> [{ transferId, fromRoute, toRoute, message }]

POST /internal/velocity/transfers/:id/ack          NEW
    -> { movedPlayers, failures }
```

On seeing a transfer, the plugin resolves the target route and issues a connection
request per connected player. Players stay connected to the proxy throughout: the TCP
session to Velocity never drops, only the backend behind it changes. The `message` field
is what the lobby shows; the ack tells the controller when the transfer is complete and
which players, if any, failed to move.

**Register route B during `staging`.** The baseline's own documentation warns a new route
can take up to one polling interval to become visible to the plugin. If you register B at
cutover time, the cutover stalls for a polling interval with everyone sitting in the
lobby. Registering during `staging` makes the route old news by the time it is needed.

**State that does not survive: raise this with Engineer 3.** A backend transfer
preserves the connection but not server-side in-memory state. Anything the generated
plugin holds in RAM rather than on disk is lost at handover. The consequence is a design
constraint on the rule vocabulary: rules must be stateless or persist through the world.
The enforcement point is `validation.ts`, which is Engineer 3's file, in
`packages/plugin-builder/`. You own the mechanism that creates the constraint; they own
the file that enforces it. Raise it with them explicitly and early, because the failure
mode is a rule class that works in testing (no handover happened) and silently loses
state in production (the first deployment after it ships). That conversation is part of
your deliverable; discovering it in production is not an acceptable substitute.

---

## 9. Tenancy

The baseline runs every contributor inside one shared `infra-team` namespace with quotas
sized for a student project and an explicit warning that other contributors can read your
Secrets. Correct for a club learning environment; wrong for a product with tenants.
Changing it is not a patch; it is a different topology, and it is yours.

- **Namespace per tenant, not per team.** Every tenant's servers, candidates and PVCs
  live in that tenant's namespace.
- **`ResourceQuota` and `LimitRange` per namespace**, mirroring the numbers QuotaService
  enforces at the application layer, so the cluster is a backstop rather than a
  duplicate. The application layer decides; the cluster enforces the same ceiling in case
  the application layer has a bug. Do not maintain two independent sets of numbers; the
  manifests should be generated from or checked against the application-layer values.
- **Default-deny `NetworkPolicy` between tenant namespaces.** Provisioning already
  creates a NetworkPolicy per server; make the default restrictive so a tenant's pod
  cannot reach another tenant's pod, RCON port included.
- **Secrets per tenant.** The system already holds OAuth secrets, database credentials,
  machine tokens and approval tokens. The RCON password (§6) is the first that must be
  scoped per tenant, because it cannot live where other tenants can read it: a tenant
  who can read another tenant's RCON password owns their world.
- **Keep EKS Pod Identity.** Service accounts scoped to single bucket prefixes with no
  AWS keys in containers is already correct in the baseline. Extend it (new prefixes for
  snapshots per tenant); do not replace it.

---

## 10. Capacity and concurrency

Karpenter's autoscaling pool is capped at 8 CPU and 16 Gi across `t3.small` and
`t3.medium` nodes: an explicit spend guard, not just a scaling policy. A deployment
doubles a server's footprint for its duration (A and B both exist from `staging` through
`cutover`) and adds the lobby on top. One Minecraft server plus a candidate plus the
lobby consumes a meaningful fraction of the whole pool.

So: either raise the ceiling (your account, your credits, your call, and say so in
`infra/tofu/` with a comment explaining the number) or serialise deployments behind a
cluster-wide queue with a small concurrency limit. Do the queue regardless, because any
ceiling has the same failure mode past some concurrency: a deployment that cannot
schedule pod B sits silently in `staging` while the pod stays Pending, and nobody can
tell a queued deployment from a stuck one.

**Surface queue position.** The deployment row carries it, `GET /v1/deployments/:id`
returns it, and it goes out on the SSE stream (§16) so the CLI, web and phone can show
"queued, position 2" instead of an indefinite `staging`.

---

## 11. Quota extension

`apps/api/src/modules/quota/`. The baseline's QuotaService answers "can this user have
another server?" via `getResourceUsage()` and `getBackupUsage()`. It now has to answer
two more questions, and both are yours:

- **Deployment headroom.** Reserve a candidate's CPU, memory and storage for the
  deployment's duration and release on completion or abort. Without this, a user at their
  ceiling can never deploy a change, a failure mode that looks like a bug and gets
  reported as one. The check runs before anything is provisioned
  (`POST /v1/servers/:id/deploy` is quota-checked for headroom before `staging`), and the
  release must be in the abort path as well as the happy path: a leaked reservation is a
  user who can never deploy again.
- **Snapshot retention.** Every deployment retains its predecessor's snapshot. That is a
  persistent storage cost per deployment that no current quota dimension covers, and it
  accumulates: a user who deploys daily grows a snapshot a day forever. Add count and age
  limits, and prune on a schedule. Pruning must never delete the current rollback
  target's snapshot.

---

## 12. M1 is yours, and it is the falsification test

M1: measure delta sync plus Paper cold boot on B for a **realistic world**: not a fresh
void, a world with real region files and real playtime. A script, not a controller. The
build plan is explicit: find this number before you build anything on top of it.

Whatever number comes back **is the freeze window the whole team designs around**:

- It is a hard input to **Engineer 3's lobby UX**: the progress message, the review
  screen's "estimated player-visible window", and whether the lobby needs anything more
  than a status line depends on whether the answer is eight seconds or eighty.
- It is a hard input to **Engineer 1's deployment event stream**: the CLI `--watch`
  timings, the stall-detection threshold an agent uses to decide a deployment is stuck,
  and the estimated window `preview_deploy` reports.

It is due **early**: it is the one genuine serialisation point in the whole parallel
plan. Nobody designs the lobby experience or the deployment UX until you report it.

The falsification conditions, stated plainly because they are the reason M1 exists:

1. **If the freeze window cannot be brought to a tolerable length**, the pitch does not
   hold. Delta sync plus cold boot is the load-bearing assumption of the entire product.
2. **If Velocity's backend transfer proves visibly disruptive** in ways players reject,
   the pitch does not hold either. It rests on "nobody gets disconnected" being literally
   true.

If either fails, the team needs to know in week one, not at integration. Measure
pessimistically: a bigger world than you expect users to have, a delta representing
minutes of active play, cold boot with the rule plugin loaded. Report the number with its
conditions, not just the number.

---

## 13. What you consume, and from whom

| You consume | From | Contract |
|---|---|---|
| `buildRuleJar(ruleJson)` | Engineer 3, `packages/plugin-builder/` | Returns `{ jarUrl, contentDigest }`. The digest is recomputed at build time, never trusted from input. You call it in `building`. |
| Approval-token validation | Engineer 3, `approvals` module in `apps/api` | You redeem the token at `building`: single-use, short-lived, `issued_to` checked against the calling principal, `content_digest` checked against the freshly built artefact. You do not implement token minting or validation; you call it and refuse on failure. |
| `deployments` and `approval_tokens` schema | Engineer 3, `packages/db/` | Engineer 3 is sole owner of the migration sequence (baseline head is 0005). You request tables and columns **by PR to Engineer 3**; you never write migrations yourself. Two engineers writing migrations in parallel is how a sequence breaks. |
| `packages/contracts` | Engineer 3 | Locked in Phase 0. Your deployment-state event types and endpoint shapes land there by PR, reviewed by whoever the type touches. |

**What you build against before those exist:**

- A **hand-written rule JSON committed to the repository**, and a pre-built JAR from it.
  The build plan says the controller should be driven by a static file first, and it is
  right: M2 and M3 do not need authoring, approvals or a model. A stub
  `buildRuleJar()` that returns the committed JAR's URL and digest unblocks `building`
  on day one.
- A **stub approval validator** that accepts a fixed token in development. Swap in the
  real `approvals` module at integration; the call site is one function.
- **Contract fixtures** for the event envelope, agreed with Engineer 3 in Phase 0, so
  the events you publish at integration are the events they built the UI against.

---

## 14. What you must NOT build

- **No in-JVM class hot-swapping.** Java cannot safely unload loaded code; Paper has
  carried this as an open design problem for years (issues #4317 and #9731). The entire
  value of this architecture is that it does not need to solve that problem. If you find
  yourself reaching for classloader tricks, you are rebuilding PlugManX.
- **No live VM or JVM memory snapshotting.** Enormous effort. `save-off` plus
  `save-all flush` already gives a consistent world on disk. What it does not give is
  in-memory plugin state, which is why rules must be stateless (§8), not why you need
  CRIU.
- **No path that touches pod A before cutover.** Restated from §3 because it belongs in
  this list too: any optimisation, cleanup or convenience that stops, modifies or
  unmounts A before B's health check has passed is not an optimisation, it is the bug
  this whole design exists to prevent.

---

## 15. Definition of done, per component

- [ ] **`infra/tofu/`**: `tofu plan` runs clean against your account; TFLint and Checkov
      pass in CI; the Karpenter pool, NLB, buckets and Pod Identity service accounts
      exist; no account identifiers or bucket names from the baseline remain.
- [ ] **`infra/k8s/` tenancy**: creating a tenant creates a namespace with
      `ResourceQuota`, `LimitRange` and default-deny `NetworkPolicy`; a pod in tenant X's
      namespace cannot reach tenant Y's pods on any port, verified by a test that
      actually tries.
- [ ] **RCON**: a server pod restarted five times answers RCON with the same password
      every time; the password is a per-tenant Secret delivered via
      `RCON_PASSWORD_FILE`; port 25575 is unreachable from outside the backend,
      verified by a test that actually tries.
- [ ] **Lobby**: the lobby workload is always-on, joinable through the proxy, shows its
      status message, and survives a node replacement.
- [ ] **Velocity transfer**: with two backends registered, a transfer instruction moves
      every connected player from one to the other with no client disconnect, and the ack
      reports `movedPlayers` and `failures` accurately (verified by killing a player's
      route mid-transfer and seeing them in `failures`).
- [ ] **Provisioning (candidate entry point)**: a candidate pod provisions with its PVC
      and receiver init-container, Paper not started, name not colliding with
      `game_servers_user_active_name_idx`; deleting the candidate leaves no orphaned
      resource.
- [ ] **World move (strategy B)**: pre-sync runs while A serves without affecting A's
      TPS beyond an agreed budget; the freeze sequence issues `save-off`,
      `save-all flush`, delta, `save-on` in that order (assert the order in the test);
      B's world boots and matches A's flushed state.
- [ ] **M1 measurement**: delta sync + Paper cold boot measured on a realistic world,
      reported with world size, delta size and conditions, and circulated to Engineers 1
      and 3. Due before M2 work begins.
- [ ] **Deployment controller**: every state transition writes the `deployments` row;
      abort at each of `building`, `staging`, `presync`, `freezing`, `verifying` returns
      the system to its pre-deployment state (players on A, no candidate resources, quota
      reservation released) with a test per state; cutover failure resolves all players
      onto A; `POST /v1/deployments/:id/abort` is safe at any state before `cutover` and
      a no-op after.
- [ ] **Rollback**: `POST /v1/servers/:id/rollback` deploys the previous version through
      the full state machine and preserves play since the change;
      `POST /v1/servers/:id/restore` refuses without the explicit data-loss confirmation.
- [ ] **Reconciliation**: kill the backend in each non-terminal state; on restart the
      controller converges every in-flight deployment to a correct terminal state from
      Kubernetes state alone, with players ending on exactly one authoritative server.
- [ ] **Queue**: two simultaneous deploys serialise; the second reports its queue
      position via `GET /v1/deployments/:id` and the event stream; no deployment sits in
      `staging` with Pending pods and no explanation.
- [ ] **Quota extension**: a user at their resource ceiling can still deploy (headroom
      reserved and released, including on abort); snapshot count and age limits enforced;
      the pruner never deletes the current rollback target's snapshot.
- [ ] **Local parity**: a documented one-command path (kind or k3d) that brings up
      namespaces, quotas, a Paper pod, the lobby and Velocity locally, plus
      docker-compose Postgres; verified by Engineer 1 or 3 running it on a machine with
      no AWS credentials.

---

## 16. Your integration checklist

### You hand over

| Deliverable | To | Notes |
|---|---|---|
| `POST /v1/servers/:id/deploy` (+ `GET /v1/deployments/:id`, abort, rollback, restore) | Engineer 1 (MCP `deploy_rules`/`rollback`, CLI), Engineer 3 (web and phone approve-then-deploy) | Seam 3. Requires an approval token, validated against Engineer 3's `approvals` module. |
| Deployment state events on the SSE stream | Engineer 1 (CLI `--watch`), Engineer 3 (web progress UI, phone feed) | Seam 6. Engineer 3 owns `GET /v1/servers/:id/events` and the envelope; you publish one event per state transition (and queue-position changes) into it. Envelope types land in `packages/contracts` by PR. |
| The measured freeze window (M1) | Both | The number everyone designs around. Due before anyone builds on top of it. |
| The local-parity cluster path | Both | kind/k3d + docker-compose Postgres. They must never need the AWS account. |

### You need

- `packages/contracts` locked (Engineer 3, Phase 0).
- `buildRuleJar()` returning `{ jarUrl, contentDigest }` (Engineer 3).
- The `approvals` module for token redemption (Engineer 3).
- `deployments` and `approval_tokens` tables (requested by PR, migrations written by
  Engineer 3).
- The `validation.ts` statelessness constraint on rules (Engineer 3, prompted by you;
  §8).
- Engineer 1's telemetry emitter runs inside pods you run; nothing to build, but your
  NetworkPolicy must allow the pod-to-backend path for
  `POST /internal/telemetry/:serverId` (seam 7).

### Integration tests that only pass when all three parts are wired

1. A rule set authored through Engineer 1's `author_rules`, approved through Engineer 3's
   review screen, deploys through your controller, and the CLI `--watch` stream shows
   every state transition of that deployment as it happens.
2. Your controller refuses a deploy whose approval token digest does not match the
   freshly built JAR: the time-of-check/time-of-use case, exercised end-to-end.
3. An abort mid-deployment shows up correctly on all three surfaces: structured NDJSON
   event on the CLI, progress UI on the web, and players back on A in the world.
4. The rollback issued from the phone runs your full state machine and the world returns
   with play preserved.

### The milestone done-conditions you are on the hook for

**M2: Manual deployment.** Done when:

> With the world pre-synced, players drain to the lobby, the freeze runs, a candidate
> boots against the copied world and passes health checks. Abort at any point returns
> players from the lobby to the original and leaves no trace. This exercises the whole
> freeze-and-return cycle without a cutover.

**M3: Cutover.** Done when:

> The product exists. You change a rule, players pass through the lobby and land in the
> new world without disconnecting, and you can put it back. Everything after this is
> leverage on a capability you already have.

M0 through M3 is the entire product. Your work is the reason the other two engineers'
work is worth demonstrating: build the mechanism first, prove it with a static rule
file, and let the surfaces catch up to it.
