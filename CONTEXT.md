# CONTEXT.md: Farlands Live

This is the single onboarding document for anyone (engineer or agent) joining this project
cold. If you read only one file before touching the repo, read this one. It condenses two source
documents (Product & Positioning; Scaffold & Build Plan) and the authoritative work-split spec.
Everything here is binding unless a linked working doc (`ENGINEER-1.md`, `ENGINEER-2.md`,
`ENGINEER-3.md`, `PHASES.md`) refines it further.

Baseline repository: `ACM-VIT/farlands` @ `main`. You will lift code from it; the inventory in
section 3 tells you exactly what.

---

## 1. What this project is

**A game-server control plane whose entire surface (provisioning, rule authoring, live
deployment, rollback and telemetry) is exposed as an agent action space, with irreversibility
engineered out.**

The enabling mechanism underneath it: applying a new rule set to a running Minecraft server by
standing up a health-checked replacement and moving players across the proxy, so nobody is
disconnected and any change can be undone.

This is an AI systems project, not a cloud project with a chatbot on it. The distinction that
matters is where the intelligence sits. In most "AI + X" projects the model produces text that a
human then acts on. Here **the model's output is the action**, and the engineering problem is
making that safe:

- **The action space is a fixed set of typed operations**: a validated rule document, or a
  scoped server lifecycle call. Never code, never a shell, never raw cluster access. The rule
  schema is simultaneously the capability ceiling and the security boundary.
- **Every rule change is reversible, and the reversal is one operation.** A snapshot precedes
  every change. But be precise about the limit: rollback restores the rules. Effects a bad rule
  already had on the world (diamonds granted, mobs cleared, an economy drained) persist unless
  the owner accepts a snapshot restore and its data loss (section 8). Saying this out loud is the
  difference between a safety argument and a slogan.
- **Blast radius is gated by health checks, not by hope.** The candidate server must boot, load
  the rules and pass checks before a single player is moved to it. A rule that crashes the server
  never reaches anyone.
- **The environment answers back.** Every change carries a before/after telemetry window, so the
  Director is measured against observed player behaviour rather than its own assessment of its
  work, with honest limits on what that measurement can support (section 9).
- **The threat model includes the users.** Players will try to steer an agent that can read chat.
  In-world text is data, never instruction, and the approval gate is not optional (section 7).

That set of problems (constrained action spaces, reversibility, human-in-the-loop gating,
injection resistance, grounded evaluation) is the substance of applied agent infrastructure.
Minecraft is the environment that makes them visible in two minutes on a projector.

---

## 2. Essential background you cannot skip

Almost every claim about Minecraft servers changed in 2026. Do not trust older writing.

**Versioning is YY.D.H now.** Minecraft abandoned 1.x versioning in December 2025. The format is
two-digit year, drop number, hotfix. There is no 1.22 and never will be; 1.21.11 (9 Dec 2025) was
the last 1.x release. Current stable is **26.2 "Chaos Cubed"** (June 2026); 26.3 is in
development.

**Java Edition is deobfuscated from 26.1 onward.** The server JAR ships with real class and
method names. Paper dropped its internal remapper entirely; Fabric retired Yarn mappings after
nine years. Crash logs now say `CreeperEntity` instead of `brc`. Why this matters here: every
AI-generated-plugin product on the market was built against obfuscated or remapped Minecraft.
Deobfuscation means a model can now work against the game's real API surface, and stack traces
are legible enough to feed back into an automatic repair loop. No shipped product reflects this
yet: AuraFlow tops out at Paper 1.21.4, MineClawd at 1.21.1. Targeting Paper 26.x is a
differentiator with a shelf life of months.

**Plugin vs mod: the line that governs everything downstream.** A plugin (Bukkit/Spigot/Paper)
is server-side only: **players join with an unmodified vanilla client**. A mod (Fabric/NeoForge)
rewrites game code and normally requires every player to run a matching modded client
(server-side-only mods being the exception). Plugins cannot add genuinely new blocks or items;
mods can, at that cost. This platform runs Paper, and the property that players join with the
game they already have **must not be broken**. It is why Fabric/NeoForge support is on the
do-not-build list.

**What a Paper server is.** Paper is the dominant plugin server: Bukkit + Spigot + Paper APIs,
hard-forked away from Spigot in December 2024 with ~1,600 patches, requiring Java 25. Purpur is
a drop-in Paper fork; Folia (regionised multithreading) breaks most plugins and PaperMC itself
says it "won't be useful for the majority of servers out there". A Paper server targets 20 ticks
per second: a 50 ms budget per tick. Sustained MSPT above 50 ms means the main thread is
behind; below 17 TPS is noticeable, below 15 is an emergency.

**Java cannot safely unload code, so `/reload` and PlugManX are not options.** To add behaviour
to a Paper server you write a Java plugin, build a JAR, drop it in `/plugins`, and restart. There
is no supported alternative. `/reload` is, in the words of the canonical community reference,
"always unsafe and error prone". It simulates a shutdown while the server keeps running, so old
and new code coexist and conflict: classloader and file-handle leaks (the notorious
`zip file closed` error), double-registered listeners, orphaned scheduler tasks, stale static
caches, NMS hooks bound to dead class objects. Neither Paper nor Spigot has ever recommended it;
Paper has carried this as an open design problem for years (issues #4317 and #9731), meaning
there is still no first-party hot-reload story in 2026. PlugManX (123,300 Modrinth downloads)
inherits every one of those failure modes: community consensus is "fine on a dev box, never in
production". The interpreted escape hatches (Skript at 206,100 downloads, Denizen much smaller)
reload scripts live but are console-driven plugins with no remote API, no candidate server, no
health check, no snapshot, no rollback; and new Skript addons still need a restart.

The consequence for this project: nobody has solved live plugin deployment because everyone
tries to solve it inside the JVM, where it is genuinely unsolvable. We do not have to. We own the
proxy and the orchestrator, so we solve it one layer up: build a replacement server, move the
world into it, move the players across, retire the original. That is section 4.

---

## 3. The baseline we build from

`ACM-VIT/farlands` is not a hosting panel with a Minecraft skin. It is a cloud-agnostic,
game-agnostic control plane in which a game server is a set of Kubernetes objects with a quota
attached, a proxy route in front, and a backup pipeline behind.

### 3.1 Architecture as built

```
<server-id>.mc.farlands.cloud:25565
        |
        v
AWS Network Load Balancer          (public TCP entrypoint)
        |
        v
Velocity proxy                     ns: infra-team
+ Farlands dynamic-routing plugin
  (polls the backend, registers every
   running server by routing hostname)
        |
        v
Per-server ClusterIP Service
        |
        v
Minecraft pod (Paper) + PVC        ns: infra-team
image: itzg/minecraft-server
        ^
        | creates PVC, ConfigMap, Deployment,
        | Service, NetworkPolicy; records route in Postgres
        |
Farlands backend (Bun + Elysia)    ns: dev-deployment
farlands-backend.dev-deployment.svc.cluster.local:3001
```

Server IDs are used as DNS labels, so renaming a server cannot break its public address.

- **Infrastructure as code.** OpenTofu across the AWS footprint in `ap-south-1`, with TFLint and
  Checkov enforced in CI.
- **Autoscaling with a hard ceiling.** Karpenter provisions nodes when pods go Pending,
  restricted to a `t3.small` / `t3.medium` pool capped at **8 CPU and 16 Gi**: an explicit spend
  guard, not just a scaling policy.
- **Per-user quotas.** `QuotaService` (`getResourceUsage()`, `getBackupUsage()`) returns CPU,
  RAM, storage, server-count and backup-count usage against limits, enforced before provisioning.
- **Backup as a first-class lifecycle.** A backup is a labelled Kubernetes Job
  (`farlands.dev/backup-id`) that mounts the server's PVC and uploads an archive to S3. Records
  reconcile against Job state, so results survive a backend restart. Restore is a Job that
  replaces PVC contents while the server sits in a transitional `restarting` state; the backup
  stays reusable if the restore fails. **This reconciliation pattern is the model for the
  deployment controller.**
- **Scoped cloud identity.** In-cluster AWS access comes from Kubernetes service accounts via EKS
  Pod Identity, each restricted to a single bucket prefix. No AWS keys inside containers.
- **A web application.** Next.js with Better Auth and Google OAuth, an admin dashboard, Modrinth
  integration, and the Plugin Builder.

### 3.2 The Plugin Builder: the most important asset in the repository

```
Builder UI
    |
    v
json-builder.ts     assemble a rule document
    |
    v
validation.ts       validate against the schema in types.ts
    |
    v
runtime-jar.ts      fetch the base template JAR from blob storage
    |
    v
jar-builder.ts      inject the rule JSON into a copy of the template
yaml-generator.ts   emit the plugin descriptor
    |
    +--> user downloads a working .jar
    +--> rule JSON persisted to S3
    v
backend rules module    registered as { name, description, gameType,
                                        jsonUrl, version }
```

The Java side is a Maven project at `farlands-app/plugin-runtime/` (`PluginMain.java` plus
`config/`, `listeners/` and `models/`): a generic interpreter that reads the injected JSON and
registers the Bukkit listeners it describes.

The structural consequence, stated honestly: **Farlands does not generate Java.** It generates a
validated JSON document that a pre-built, pre-reviewed Java runtime interprets. The template JAR
is fixed and reviewed once; each rule set is a payload injected into a copy of it. So the
interesting claim is not "we compile Java and Skript only interprets": both ship an interpreter
reading a rule document, and pretending otherwise invites a comparison that loses. The claim that
holds is about **how the change is delivered and what happens when it is wrong**: a
health-checked replacement server, an automatic snapshot, one-action rollback, and an API an
agent can drive. Skript has none of those. Neither does any panel.

The design decision that makes the whole safety model possible (a bounded rule vocabulary as the
only path to changing behaviour) was made here, for entirely unrelated reasons.

### 3.3 Scorecard against the seven structural problems

Seven structural problems define what running a Minecraft server costs people: (1) getting
reachable (port forwarding, CGNAT, dynamic IPs), (2) staying on 24/7, (3) configuration by text
file, (4) behaviour frozen at boot, (5) authoring requires Java, (6) backups coarse and untested,
(7) worlds go stale. The baseline's honest scorecard:

| # | Problem | Status | How |
|---|---|---|---|
| 1 | Getting reachable | Solved | NLB plus Velocity plus a stable `*.mc.farlands.cloud` hostname per server. No router, no CGNAT, no IP sharing. |
| 2 | Staying on | Solved | Kubernetes Deployments with Karpenter behind them; capacity appears on demand within a hard spend ceiling. |
| 3 | Configuration by text file | Partial | Provisioning is API-driven and quota-checked, so nobody edits `server.properties` to create a server. Deep per-plugin YAML remains untouched. |
| 4 | Behaviour frozen at boot | **Not solved** | A generated JAR is downloaded and installed like any other. Applying it means restarting the pod, which disconnects everyone. |
| 5 | Authoring requires Java | Solved | Plugin Builder: rules in a form, working plugin out. No Java, no Maven, no toolchain. |
| 6 | Backups coarse and untested | Solved | Labelled Kubernetes Jobs, S3 archives, durable reconciliation, restore verified against Job state, quota-limited per user. |
| 7 | Worlds go stale | **Not solved** | Nothing in the platform changes a world over time. Rules are authored once by a human. |

**Four solved outright, one in part, two unsolved.** And problems 1, 2 and 6 are exactly what
Aternos, Shockbyte and Pterodactyl already solve, at a price a student project cannot undercut.
The two unsolved problems are related: a world goes stale because its rules are frozen; its rules
are frozen because changing them costs a disconnect. And there is a third gap the scorecard does
not capture: everything the baseline can do requires a human with a browser. There is no surface
a script, a CLI, or an agent could act through. Farlands Live exists to close exactly those gaps.

### 3.4 Repository inventory: what to lift, extend, re-point, rewrite, drop

Verdicts: **LIFT** copy essentially verbatim. **EXTEND** keep and add to. **RE-POINT** keep the
pattern, change the target. **REWRITE** the shape is wrong for this product. **DROP** discard.

| Path (in `ACM-VIT/farlands`) | Verdict | Reasoning |
|---|---|---|
| `farlands-app/plugin-runtime/` | LIFT | The single most valuable asset in the repository. A Maven project (`PluginMain.java` plus `config/`, `listeners/`, `models/`) that interprets an injected JSON rule document at runtime. Copy wholesale; do not restructure. |
| `farlands-app/src/lib/plugin-builder/` | LIFT | The build pipeline: `types.ts`, `validation.ts`, `jar-builder.ts`, `runtime-jar.ts`, `yaml-generator.ts`, `s3-config.ts`, `s3-storage.ts`. Seven files that turn a validated document into a working plugin JAR. Rebuilding this would cost days. |
| `farlands-app/src/app/api/plugin-builder/` | LIFT | `route.ts` and `json-builder.ts`: the assembly entry point. Note this sits under `app/api/`, not in `lib/plugin-builder/`; it is the eighth file of the pipeline and easy to miss when copying. |
| `backend/src/modules/rules/` | LIFT | Registry of rule sets. The DTO is `{ name, description?, gameType, jsonUrl, version? }`: a pointer to a JSON document in S3, not the document itself. This indirection is exactly what versioning and rollback need. |
| `backend/src/modules/quota/` | EXTEND | `QuotaService.getResourceUsage()` and `getBackupUsage()`. Correct shape; needs deployment headroom and snapshot retention as new dimensions. |
| `backend/src/modules/provisioning/` | EXTEND | `kubernetes.ts`, `service.ts`, `utils.ts`. Creates PVC, ConfigMap, Deployment, Service and NetworkPolicy per server. Needs a second entry point: provision a candidate with Paper deliberately not started. |
| `backend/src/modules/backup/` + `backend/src/backup-sync.ts` | EXTEND | Labelled Kubernetes Jobs, S3 archives, durable reconciliation against Job state after a backend restart, `syncBackupsFromS3(prefix)`. The reconciliation pattern here is the model for the deployment controller. |
| `backend/src/modules/servers/` | EXTEND | Lifecycle and power actions. Add deployment states. Note the existing constraint: active server names are unique per user via `game_servers_user_active_name_idx` on `(user_id, name)` where `current_state <> 'deleted'`; a candidate must not collide with it. |
| `infra-minecraft/velocity/` | EXTEND | Velocity plus the Farlands dynamic-routing plugin, which polls the backend and registers running servers by hostname. Add player transfer and the lobby. Check the deployed Velocity version: current upstream is 4.1.1 (Java 25). If the cluster runs 3.x, upgrading is part of M0, not a later chore. |
| `infra-minecraft/k8s/` + `infra-minecraft/paper/` | EXTEND | Workload manifests and Paper configuration. Needs a stable RCON password as a Secret and a lobby workload added. |
| `packages/db/` | EXTEND | Drizzle schema and migrations, currently through 0005. Add five tables (section 10). |
| `backend/src/modules/auth/` + `backend/src/modules/admin/` | EXTEND | Working auth and admin surface. Needs machine credentials: API tokens for the CLI and MCP server, and approval-token minting. |
| `infra-opentofu/` + `.tflint.hcl` + `.checkov.yml` | RE-POINT | Keep the discipline: validate, TFLint and Checkov in CI is better hygiene than most production teams have. Change the account, cluster, buckets and the namespace model. |
| `farlands-app/src/lib/modrinth/` | LIFT | Browsing the existing plugin ecosystem stays useful and is the natural surface for a rule-set marketplace later. |
| `farlands-app/src/app/(dashboard)/` + `components/` | EXTEND | Next.js dashboard with Better Auth and Google OAuth. Add the review screen with semantic diffs. |
| `docs/farlands-guide.md` | REWRITE | Onboarding for club contributors sharing one AWS account. Contains the account ID, shared-namespace rules and contributor IAM role. None applies to a product. |
| `farlands-app/src/lib/mock-servers.ts` | DROP | Development fixture. |
| `docs/MOM/` · `.husky/` · `CODE_OF_CONDUCT.md` · Hacktoberfest scaffolding | DROP | Meeting minutes and open-source-event machinery. Keep the Husky hooks only if you want the same pre-commit discipline. |

A verification caveat carried over from the source inventory: file paths, module names and
directory structure were verified against the repository tree and its documentation; statements
about what a specific file *contains* are inferred from its name, siblings and documentation,
except where a document states the behaviour explicitly.

### 3.5 The four files to open before you start (`[CONFIRM]`)

These must be opened and checked against the actual code **before building anything** that
depends on them. Assumptions about them are load-bearing and unverified.

| File | What to check |
|---|---|
| `farlands-app/src/lib/plugin-builder/types.ts` | The rule vocabulary. This defines what a rule can express, and therefore the entire agent action space. Everything downstream depends on its shape. Read it before designing a single MCP tool. |
| `farlands-app/src/lib/plugin-builder/jar-builder.ts` | How the rule JSON is injected into the template: resource entry, manifest attribute, or rewritten class. Determines whether a rebuild is cheap enough to sit inside a deployment. |
| `farlands-app/plugin-runtime/src/main/java/com/farlands/config/` | How the runtime loads its config. If it reads from the JAR only, every change needs a rebuild. If it can read an external path, a class of changes becomes a file write instead. |
| `backend/src/modules/backup/service.ts` | Whether the backup Job is co-scheduled with the running server pod. RWO means one node, not one pod: a Job can share the volume if it lands on the same node. This determines which world-copy strategy is available. |

### 3.6 Why a new repository, and what changes about tenancy

We scaffold a **new repository** rather than extending in place, for one reason that outweighs
the rest: the current cluster runs every contributor inside a single shared `infra-team`
namespace with quotas sized for a student project: 20 pods, 2 PVCs, 8 Gi storage, zero
LoadBalancers, and an explicit warning in the project's own guide that other contributors can
read your Secrets. That is correct for a club learning environment and wrong for a product with
tenants. Changing it is not a patch; it is a different topology. The cost is inheriting
maintenance of copied code, losing upstream fixes, and roughly a day of scaffolding.

The target tenancy model: **namespace per tenant, not per team**; `ResourceQuota` and
`LimitRange` per namespace mirroring the numbers `QuotaService` enforces at the application layer
(the cluster is a backstop, not a duplicate); default-deny `NetworkPolicy` between tenant
namespaces; Secrets scoped per tenant (the RCON password is the first that must be); keep EKS Pod
Identity: extend it, do not replace it. Karpenter's 8 CPU / 16 Gi ceiling stays: a deployment
doubles a server's footprint for its duration and adds a lobby, so deployments are serialised
behind a queue rather than raising the ceiling by default.

---

## 4. The mechanism

Change delivery is a server replacement, one layer above the JVM:

```
t0  Players connected to pod A (rules v1) through Velocity.

t1  New rule set authored and validated. Build a fresh JAR
    from the reviewed template + the new rule JSON.

t2  Provision pod B and its volume. Paper on B is NOT started.
    A keeps serving; nobody notices.

t3  Pre-sync the world A -> B while A is still live.
    Inconsistent, and that is fine; it shrinks the delta.

t4  Velocity moves players A -> lobby. A holding area,
    not a kick. Their session with the proxy never drops.
    Nothing they do from here can be lost on A.

t5  FREEZE:
      A: rcon "save-off"        disable autosave FIRST
      A: rcon "save-all flush"  block until chunks are on disk
      delta-sync A -> B         only what changed since t3

t6  Start Paper on B against the delivered world.
    Health-check: up, rules loaded, no startup exceptions,
    TPS sane over a sampled window.
    Any failure -> abort, delete B, players return to A.

t7  Velocity moves every player lobby -> B. Backend-to-
    backend, no client reconnect, no address change, no kick.

t8  A drains and terminates. Its snapshot is retained.

Player-visible window: t4 through t7 (the delta sync
plus a Paper cold boot, spent in the lobby).
Player-visible disconnect: none.
```

### 4.1 The two constraints that shape this design: state them, do not hide them

**Paper cannot start on B before the world lands.** A running Paper server holds
`world/session.lock`, keeps loaded chunks in memory and rewrites region files on its next
autosave. Syncing files underneath a running server is ignored for loaded chunks, overwritten on
the next save, or fatal if `session.lock` is replaced. So Paper's cold boot on B sits **inside**
the freeze window: the honest cost is "delta sync plus a Paper start", tens of seconds, not an
instant.

**The volume cannot be shared.** The `farlands-gp3` StorageClass is EBS-backed and
ReadWriteOnce (attachable to one node at a time), and gp3 does not support Multi-Attach. Even
co-scheduled, two Paper servers could not share one world directory, because `session.lock`
forbids it. **The world must be copied.**

### 4.2 The world-move strategy

Three candidate strategies were weighed; **strategy B is the pick**:

- **A. Via S3**: existing backup Job archives PVC A to S3, existing restore Job unpacks into
  PVC B. Zero new mechanism, but two full transfers through S3 and no cheap incremental delta.
  It is the fallback if the sidecar stream proves fiddly, and useful for the very first
  end-to-end test because it is already written.
- **B. Pod-to-pod stream (PICK)**: a sidecar in pod A tars `world/` and streams over HTTP to a
  receiver init-container in pod B. New code, but small. Sidesteps every volume-attachment
  constraint and, crucially, supports an incremental pre-sync followed by a short delta, which
  is the only way to keep the freeze window down.
- **C. EBS volume snapshot**: CSI VolumeSnapshot, new PVC from `dataSource`. Cleanest and most
  Kubernetes-native, but restored gp3 volumes lazily fetch blocks on first access, so early world
  reads are slow unless Fast Snapshot Restore is enabled, which costs real money per
  snapshot-hour.

RCON (`save-off` -> `save-all flush` -> delta -> `save-on`, in that order) is the control channel
for the freeze.

### 4.3 The lobby, the transfer, and what does not survive

Because the freeze is not instantaneous, the honest product claim is **"nobody gets
disconnected", not "nobody notices"**. A small always-on lobby server (a minimal Paper instance
with a void world and a status message) is the waiting room during the freeze. Players see a
holding area with a progress message (standard practice on every large Minecraft network) instead
of a kick to the server list. Their session with the proxy never drops, their client never
returns to the main menu, and nothing in their inventory or position is lost.

Moving players out **before** the freeze rather than after it is not a detail. If players stayed
on A while B booted, everything they did in those tens of seconds would be written to A's disk
and thrown away when A drains. Draining to the lobby first is what makes the handover lossless.
This turns a hard latency problem into a UX problem, which is the right trade. Pre-syncing before
the freeze keeps the delta to minutes of play rather than a whole world; shrinking the window
further is an optimisation, not a prerequisite.

The transfer extends the routing plugin's existing poll rather than inventing a new channel
(endpoints in section 11). On seeing a transfer the plugin resolves the target and issues a
connection request per connected player: the TCP session to Velocity never drops, only the
backend behind it changes. Register route B during `staging`, well before cutover: the baseline's
own documentation warns a new route can take up to one polling interval to become visible.

**State that does not survive.** A backend transfer preserves the connection but not server-side
in-memory state. Anything the generated plugin holds in RAM rather than on disk is lost at
handover. This is a design constraint on the rule vocabulary (rules must be stateless or persist
through the world), and it is enforced in `validation.ts` rather than discovered in production.

### 4.4 THE INVARIANT

```
+--------------------------------------------------------------------+
|                                                                    |
|   POD A STAYS AUTHORITATIVE AND UNTOUCHED UNTIL CUTOVER.           |
|                                                                    |
|   Every failure before that point costs a deleted candidate and    |
|   nothing else: no player noticed, no world changed. There must    |
|   be NO code path that stops, unmounts or modifies A before the    |
|   health check on B has passed.                                    |
|                                                                    |
|   This single rule is the difference between a deployable system   |
|   and PlugManX.                                                    |
|                                                                    |
+--------------------------------------------------------------------+
```

Enforce it in code, and test the abort path harder than the happy path.

---

## 5. The deployment state machine

Owned by `apps/api/src/modules/deploy/` (Engineer 2). One row in `deployments` per attempt,
including failures. State is reconciled from Kubernetes after a backend restart, exactly as the
backup module reconciles Jobs.

```
idle
  │  POST /v1/servers/:id/deploy { ruleSetVersion, approvalToken }
  ▼
building     build JAR from template + rule JSON; validate
  │            fail -> abort, nothing happened
  ▼
staging      provision candidate pod B + PVC.
  │          Paper is NOT started.
  │            fail -> abort, delete B, A untouched
  ▼
presync      stream world A -> B while A serves
  │            fail -> abort, delete B, A untouched
  ▼
freezing     drain to lobby; save-off; save-all flush;
  │          delta sync; save-on
  ▼
verifying    start Paper on B, health check: up, rules
  │          loaded, no startup exceptions, TPS sane
  │          over a sampled window
  │            fail -> abort, delete B, return players
  │            from lobby to A. Nothing lost.
  ▼
cutover      Velocity moves players lobby -> B
  │            fail -> return players to A, delete B,
  │            mark deployment failed
  ▼
draining     A stops accepting, snapshot retained
  ▼
idle         B is the server of record
```

What each failure costs, precisely: through `presync`, nothing player-visible has happened; the
abort deletes B and that is all. From `freezing` onward players are in the lobby, so an abort
additionally costs a return trip lobby -> A. Only after `cutover` succeeds does A stop being the
server of record. `POST /v1/deployments/:id/abort` is safe at any state before `cutover` and a
no-op after.

Two operational constraints attach here:

- **Quota headroom.** A deployment doubles a server's footprint for its duration. `QuotaService`
  must reserve the candidate's CPU, memory and storage for the deployment's duration and release
  on completion or abort. Without this, a user at their ceiling can never deploy a change: a
  failure mode that looks like a bug and gets reported as one. Retained snapshots are a
  persistent storage cost per deployment that accumulates: add count and age limits, prune on a
  schedule.
- **Cluster-wide queue.** One server plus a candidate plus the shared lobby consumes a meaningful
  fraction of the 8 CPU / 16 Gi Karpenter ceiling. Serialise deployments behind a cluster-wide
  queue with a small concurrency limit, and surface queue position in the UI rather than letting
  a deployment sit silently in `staging` while pods stay Pending.

---

## 6. The three things that are easy to get wrong

1. **Order: `save-off` must come before `save-all flush`**, so no automatic save can fire
   between the flush completing and saving being disabled. Every canonical Minecraft backup
   script does it in this order.
2. **`save-off` is not a full write barrier.** It disables *automatic* world saves.
   Player-triggered writes (a disconnect during the freeze writing playerdata) still happen.
   Either drain players to the lobby before the freeze (which we do), or accept that a player who
   quits mid-freeze may lose their last few seconds.
3. **Paper cannot start on B until the world has landed.** A running server holds `session.lock`
   and keeps chunks in memory; files written underneath it are ignored or overwritten, and
   replacing `session.lock` triggers a hard shutdown. Paper's cold boot is therefore inside the
   freeze window. Budget for it and quote it honestly.

**The RCON note.** The `itzg/minecraft-server` image already used by the baseline supports RCON
on port 25575, and `ENABLE_RCON` is on by default. The work item is therefore **not enabling
RCON; it is supplying a known, stable password**, because the image generates a random one per
startup otherwise, which would silently break the control channel on every restart. Deliver it as
a Secret via `RCON_PASSWORD_FILE`, not a ConfigMap: in a shared-namespace model a ConfigMap is
readable by every other contributor. Keep 25575 inside the existing NetworkPolicy so only the
backend can reach it.

---

## 7. The safety model

### 7.1 Agent-safety concerns and their mechanisms

| Agent-safety concern | Mechanism in this system |
|---|---|
| Unbounded action space | The rule schema is the action space. The agent emits documents, never code, never shell, never Kubernetes calls. `validation.ts` is the only path in and has no bypass for "trusted" output. |
| Irreversible actions | A snapshot is taken before every deployment; rule rollback is one operation and preserves play since the change. The limit, stated honestly: rollback reverts rules, not the effects a bad rule already had on the world. |
| Blast radius | The candidate must boot, load rules and pass health checks before any player moves. A rule that crashes the server reaches nobody. |
| Autonomy overreach | Read and draft tools are open (scoped and rate-limited); every acting tool requires a human-minted approval token: single-use, short-lived, scoped to one server, and bound to a digest of the exact rule content the human saw, so an approved change cannot be substituted after the fact. |
| Runaway cost | Per-server deployment rate limits, quota headroom reservation, and the Karpenter node ceiling as a hard backstop. One proposal per server per hour is generous. |
| Prompt injection | Players will write instructions in chat aimed at the Director. In-world text (chat, signs, item names, player names) is data, never instruction. Because every deployment needs a fresh human approval, a successful injection can at most get a proposal in front of the owner. This property is exactly why v1 has no auto-approval tier. |
| Attribution | Every rule version records its source (`form`, `agent`, or `director`) with the prompt that produced it and the human who approved it. The `deployments` table is the audit log of record. |

### 7.2 Approval tokens: the mechanism the whole argument rests on

The token shape:

```
{ token, server_id, rule_set_version, issued_to, issued_by,
  issued_at, expires_at (minutes), single_use: true }
```

- **Minted only by a human action** in the web dashboard or the phone app, after seeing a
  semantic diff. `POST /v1/approvals` accepts a human session only, never a machine token.
- **Bound to content, not to a name.** The token carries `content_digest`: a hash of the exact
  rule JSON, and of the built JAR, that the human saw diffed. The deployment controller
  recomputes the digest at `building` and refuses on mismatch. The digest is never trusted from
  input.
- **Redeemable only by the principal in `issued_to`.** Otherwise a leaked token is bearer
  authority over a live world.
- **Short-lived and single-use.** A token consumed by a deployment that later aborts is spent; a
  retry needs a fresh approval. An agent that sits on a token cannot bank authority.
- **No auto-approval tier in v1.** Solve approval fatigue by batching a session's proposals into
  one review with one tap, not by tiering.

**The two failure modes this design exists to prevent:**

**Time-of-check / time-of-use.** The human approves a diff rendered from a JSON document in S3,
but the ungated draft tools are what write those documents. If a `rule_set_versions` row or its
S3 object can be rewritten, an agent can get approval for a benign v4 and have a *different* v4
built at deploy time. So: version rows are **append-only** and their S3 objects **write-once**. A
changed rule is a new version, and a new version needs a new approval. Without this the entire
safety argument is decorative. This is also the highest-severity row in the risk register
(section 17): a token that names a version rather than its content is the one failure that would
compromise the whole safety argument.

**Tiering versus injection.** An auto-approving rule class is a class a player can reach by
writing instructions in chat that steer the Director. **Tiering and "a successful injection
cannot deploy anything" cannot both be true.** If a tier is ever added it must be opt-in per
server, restricted to classes the Director cannot reach from any telemetry channel carrying
player-authored text, recorded with `issued_by = system`, and revoked automatically on any
rejected proposal.

The diff the human approves is a comparison of two JSON documents fetched from S3 by `jsonUrl`.
Render it semantically ("hostile spawns near spawn: 0.5x -> 1.4x"), never as a raw JSON patch.
A diff nobody can read is a gate nobody uses.

### 7.3 The three MCP tool classes: the class boundary is the security boundary

| Tools | Class | Notes |
|---|---|---|
| `list_servers` · `get_server` · `get_world_telemetry` · `list_rule_sets` · `get_rule_set` · `diff_rule_sets` · `get_deployment` | READ | No live effect. Scope every response to the caller's own servers: the existing per-user ownership checks are the model. `get_world_telemetry` returns a behavioural record of named players; treat it as personal data, not as public inventory. |
| `author_rules` · `preview_deploy` | DRAFT | Produce a validated rule version and a dry-run report (semantic diff, estimated player-visible window, quota impact, rollback target). No live effect, but they invoke a model and create durable rows, so rate-limit to bound cost. |
| `deploy_rules` · `rollback` · `create_server` · `power_action` | ACT | Require a valid approval token. Reject with a **structured error naming the missing approval**, so the agent's correct next move is to ask the human rather than retry. Note that `create_server` and `power_action` are cluster operations and are not undone by rollback: a stop disconnects everyone and no snapshot fixes that. Act tools always fail closed without a token. |

Generate the tool schemas from `packages/contracts` so the MCP surface, the CLI and the phone app
cannot drift. Every tool call is logged with caller, arguments and outcome as structured
application logging; the `deployments` table remains the audit log of record for anything that
changed a world.

---

## 8. Rollback, precisely

Two different operations get called rollback, and conflating them loses data:

| Operation | What it does | When |
|---|---|---|
| **Rule rollback** (the default) | Deploys the previous rule version onto the *current* world. Mechanically an ordinary deployment with source and target reversed. **Play since the change is preserved.** | Almost always. This is what the phone's rollback button does and what the Director's undo means. |
| **Snapshot restore** (disaster recovery) | Restores the retained world snapshot from before the change. **Discards everything players did since.** | Only when the world itself was corrupted or griefed. Requires an explicit confirmation naming the data loss. |

The honest limit, out loud: **rule rollback stops the rule acting further; it does not undo what
the rule already did.** Diamonds granted stay granted, mobs cleared stay cleared. If the world
itself must be repaired, that is a snapshot restore, and it costs the players everything they did
since the change, which is why it demands an explicit data-loss confirmation and is never the
default.

---

## 9. Evaluation and its limits

Because rule sets are versioned and worlds snapshotted, every deployment carries a before/after
telemetry window: session length, deaths, time spent in the affected region, whether players
came back. The environment grades the Director, not the Director itself. But be precise about
what that is:

- **Pre/post on one server is an interrupted time series, not a randomised trial.** Order
  effects, time of day, novelty and a friend-group's worth of observations are all uncontrolled,
  and players carry memory across a change in a way no snapshot can reset.
- **You cannot run two arms from one snapshot.** Returning to the shared snapshot for the second
  arm is a snapshot restore, which discards everything players did during the first arm. Two arms
  from one snapshot on one live server means throwing away real play, which nobody will accept
  twice. Say "pre/post on one server" and mean it, rather than claiming a controlled experiment
  the setup cannot deliver. `"parallel"` (two servers, split population) is the real experiment
  and costs double the infrastructure.
- **Report delta and n, never a winner.** Do not imply significance a friend-group sample cannot
  support. A directional result with its confounds named (and reporting the negative ones) is
  worth more than a clean claim nobody believes.
- **Run the random-valid-rule baseline arm.** A third arm of randomly sampled valid rule changes
  is the baseline; without it, "better than nothing" is untested.

The experiment record:

```
{ experiment_id, design: "pre_post" | "parallel",
  server_id, deployment_id, rule_version,
  window_before, window_after, metrics_before, metrics_after,
  delta, n_players, n_sessions, notes }
```

Even with these limits, this yields what most AI projects at this scale cannot: a measured
outcome rather than an assertion. "The agent's suggestions moved metric X by Y, with these
confounds" is the difference between a demo and a result.

---

## 10. The data model

Five new tables, all in `packages/db`, owned by Engineer 3:

| Table | Columns and purpose |
|---|---|
| `rule_set_versions` | `id, rule_set_id, version, json_url, content_digest, built_jar_url, source, source_prompt, created_by, created_at`. `source` is `form \| agent \| director`. **Append-only**, with write-once S3 objects behind `json_url`; a changed rule is a new row. `content_digest` is what approval binds to. Rollback targets a row here. |
| `deployments` | `id, server_id, from_version, to_version, state, candidate_pod, snapshot_id, player_visible_ms, approved_by, approval_token_hash, initiated_by, started_at, finished_at, error`. One row per attempt **including failures**. `state` mirrors the section 5 machine. `approval_token_hash` is a foreign key onto `approval_tokens`; never store the raw token. Reconcile against Kubernetes on backend restart, exactly as the backup module reconciles Jobs. **This table is the audit log of record.** |
| `approval_tokens` | `token_hash, server_id, rule_set_version, content_digest, issued_to, issued_by, issued_at, expires_at, consumed_at`. Store the hash, never the token. Single-use enforced by `consumed_at`; redemption checks `issued_to` against the calling principal and `content_digest` against the freshly built artefact. |
| `world_events_rollup` | `server_id, window_start, window_end, metrics jsonb`. Aggregated telemetry. **Deliberately not raw events**: raw events grow without bound and nothing reads them. |
| `proposals` | `id, server_id, suggested_rules jsonb, rationale, confidence, status, reviewed_by, reviewed_at, rejection_reason`. Director output awaiting approval. Rejection reasons are the most useful signal in the system; capture them. |

Conventions to follow (they are already established in `packages/db`):

- Drizzle migrations in a single sequence; **the baseline head is 0005** and new migrations
  continue from there. One owner (Engineer 3), one sequence: never two engineers writing
  migrations in parallel.
- `gen_random_uuid()` for identifiers.
- Partial unique indexes excluding soft-deleted rows: the pattern established by
  `game_servers_user_active_name_idx` on `(user_id, name)` where `current_state <> 'deleted'`.
  Candidate pods must not collide with this index.

---

## 11. The API surface

All new endpoints. `/v1/*` is the public API (four clients: web, CLI, MCP, mobile); `/internal/*`
is cluster-internal only.

| Endpoint | Purpose |
|---|---|
| `POST /v1/servers/:id/deploy` | Deploy a rule-set version. Requires an approval token. Quota-checked for headroom before anything is provisioned. |
| `GET /v1/deployments/:id` | Poll state. Drives the CLI `--watch` stream, the web progress UI and the phone feed. |
| `POST /v1/deployments/:id/abort` | Abort. Safe at any state before `cutover`; a no-op after. |
| `POST /v1/servers/:id/rollback` | Rule rollback (section 8). Preserves play. |
| `POST /v1/servers/:id/restore` | Snapshot restore. Requires explicit data-loss confirmation. |
| `POST /v1/servers/:id/rule-sets/author` | Plain English in, validated rule version out. Server-scoped, matching the CLI and MCP surfaces: a server's first rule set has no id yet, so a rule-set-scoped route cannot be the entry point. Deploys nothing. |
| `GET /v1/servers/:id/logs` | Server console log stream, backing `farlands logs --follow`. |
| `POST /v1/servers/:id/preview` | Dry run: semantic diff, estimated freeze, quota impact, rollback target. |
| `POST /v1/approvals` | Mint an approval token. Human session only, never a machine token. |
| `GET /v1/servers/:id/events` | SSE stream with `Last-Event-ID` replay. Consumed by web, CLI and mobile. |
| `GET /v1/servers/:id/proposals` | Director proposals for a server. |
| `POST /v1/proposals/:id/approve` | Approve mints a token and starts a deployment. |
| `POST /v1/proposals/:id/reject` | Reject records the reason (training signal). |
| `POST /internal/telemetry/:serverId` | Event ingest from the in-world plugin. Cluster-internal only. |
| `GET /internal/velocity/transfers` | Transfer instructions for the routing plugin: `[{ transferId, fromRoute, toRoute, message }]`. Extends the existing `GET /internal/velocity/routes` poll. |
| `POST /internal/velocity/transfers/:id/ack` | Plugin acknowledges a transfer: `{ movedPlayers, failures }`. |

The CLI (`farlands`) is a client of exactly this API: human-readable output by default,
newline-delimited JSON under `--json` with one object per state transition, machine-token auth,
and it fails without an approval token exactly as the MCP act tools do. The CLI is a client, not
a privilege escalation:

```
farlands servers list
farlands rules author <server> "<description>"    -> drafts a version
farlands deploy <server> --version N [--watch]    -> needs approval
farlands rollback <server>
farlands telemetry <server> --window 1h
farlands logs <server> --follow
```

---

## 12. Repository layout

```
farlands-live/
├── apps/
│   ├── api/src/modules/{auth,admin,rules,quota,servers,provisioning,backup,deploy,telemetry,director}
│   ├── web/                Next.js dashboard + review screen
│   ├── mcp/                MCP server
│   ├── cli/                farlands binary
│   └── mobile/             Expo / React Native
├── plugin-runtime/         Java (Maven) rule interpreter + telemetry emitter
├── packages/
│   ├── db/                 Drizzle schema + migrations
│   ├── contracts/          shared types, the locked seam
│   ├── plugin-builder/     rule document -> validated JAR
│   └── authoring/          plain English -> rule JSON
├── infra/
│   ├── k8s/                workloads, namespaces, quotas, policies, lobby
│   ├── velocity/           proxy + routing/transfer plugin
│   └── tofu/               OpenTofu, re-pointed
└── docs/
```

`packages/contracts` is small but load-bearing: four clients consume the same API, and a shared
type package is what keeps the CLI, the MCP tool schemas and the phone app from drifting apart
(the standard monorepo pattern).

Three deviations from the build plan's original layout are **decided**; every document in this
repo reflects them:

| Original location | Decided location | Why |
|---|---|---|
| `apps/web/src/lib/plugin-builder/` | `packages/plugin-builder/` | The deployment controller must build a JAR server-side during `building`. Web, API and the controller all import it. |
| `apps/web/src/lib/authoring/` | `packages/authoring/` | Three callers: the web form, `POST /v1/servers/:id/rule-sets/author`, and the MCP `author_rules` tool. |
| `packages/contracts` unowned | `packages/contracts` owned by Engineer 3 | Four clients consume it; one scribe prevents drift. Changes land by PR to Engineer 3, reviewed by whoever else the type touches. |

Everything else follows the build plan's section 2.1. `packages/plugin-builder` exposes the
lifted eight-file pipeline as `buildRuleJar(ruleJson) -> { jarUrl, contentDigest }`.

---

## 13. Who owns what

Three engineers, parallel tracks, integrated at the end. The expanded briefs are `ENGINEER-1.md`,
`ENGINEER-2.md` and `ENGINEER-3.md`; the phase-by-phase schedule is `PHASES.md`.

**Engineer 1: AI & Agent Systems ("the brain").** Owns everything that reasons, and every
surface an agent acts through: `packages/authoring/` (plain English to a rule document satisfying
the existing schema; emits validated JSON, never Java, with a validation-repair loop against
`validation.ts`); `apps/mcp/` (the three tool classes, scoping, rate limits, structured refusals
naming the missing approval); `apps/cli/` (human output by default, NDJSON under `--json`, one
object per state transition, machine-token auth); `apps/api/src/modules/telemetry/` (ingest at
`POST /internal/telemetry/:serverId`, rolling-window aggregation into `world_events_rollup`, raw
events not stored); `apps/api/src/modules/director/` (observe -> propose -> queue; never deploys;
one proposal per server per hour); `plugin-runtime/src/main/java/com/farlands/telemetry/` (the
in-world NDJSON emitter: join, leave, death, block placed/broken in region, time in region, chat
volume); and the evaluation harness including the random-valid-rule baseline arm. Owns the safety
properties: in-world text is data and never instruction; draft tools are rate-limited because
they invoke a model and create durable rows; act tools always fail closed without an approval
token. Consumes but does not build: `packages/contracts`, the approvals API,
`rule_set_versions` and the rules registry (E3), `POST /v1/servers/:id/deploy` (E2), and
`types.ts` + `validation.ts` (E3 lifts them). Cannot be blocked: works against contract fixtures
and a recorded telemetry sample until E2's cluster and E3's API are live.

**Engineer 2: Cloud & Deployment Infrastructure ("the mechanism").** Owns the AWS account the
project runs in (their credits fund the cluster) and the capability the entire product rests
on: changing a running server without disconnecting anyone. Owns `infra/tofu/` (OpenTofu
re-pointed at their own account: VPC, EKS, Karpenter pool with the 8 CPU / 16 Gi ceiling on
`t3.small`/`t3.medium`, NLB, S3 buckets and prefixes, EKS Pod Identity service accounts; TFLint
and Checkov in CI); `infra/k8s/` (namespace per tenant, `ResourceQuota` and `LimitRange`
mirroring the application-layer quota numbers, default-deny `NetworkPolicy` between tenants,
Paper workload manifests, the RCON password Secret via `RCON_PASSWORD_FILE`, the always-on lobby
workload); `infra/velocity/` (confirm/upgrade to 4.1.1 on Java 25; the routing plugin extended
with player transfer); `apps/api/src/modules/provisioning/` (second entry point: candidate pod
with Paper deliberately not started); `apps/api/src/modules/backup/` (snapshots per deployment,
world handover, reconciliation); `apps/api/src/modules/deploy/` (**the deployment controller**:
the full state machine, every abort path, the rollback pointer, reconciliation from Kubernetes
state after a backend restart, the cluster-wide deployment queue); the quota extension
(deployment headroom, snapshot retention with scheduled pruning); the world-move mechanism
(strategy B: sidecar tar stream over HTTP, RCON as the control channel); the Velocity transfer
endpoints; and `POST /v1/servers/:id/deploy`, `GET /v1/deployments/:id`,
`POST /v1/deployments/:id/abort`, `POST /v1/servers/:id/rollback`,
`POST /v1/servers/:id/restore`. **Owns the invariant** (section 4.4): enforce it in code, test
the abort path harder than the happy path. **Owns the falsification test (M1)**: measure delta
sync + Paper cold boot on a realistic world, due before anyone builds on top of it. Consumes:
`buildRuleJar()`, approval-token validation, and the `deployments` / `approval_tokens` schema
(all E3).

**Engineer 3: Platform Core & Human Surfaces ("the product").** Owns the shared spine (types,
schema, the rule vocabulary, the build pipeline) and every surface a human touches:
`packages/contracts/` (the locked seam; scribe and owner; every other engineer's types land here
by PR); `packages/db/` (**sole owner of the migration sequence** from head 0005; the five new
tables; E1 and E2 request tables by PR); `packages/plugin-builder/` (the eight-file lift exposed
as `buildRuleJar(ruleJson) -> { jarUrl, contentDigest }`); `plugin-runtime/` (the Java
interpreter lift; E1 adds `telemetry/` inside it); the core API modules (`auth/` extended with
machine tokens; `approvals/`: mint, redeem, content-digest binding, single-use, short-lived,
`issued_to` check; `rules/` registry; `servers/` lifecycle and deployment states; the SSE events
endpoint with `Last-Event-ID` replay; logs); `apps/web/` (dashboard, lifted plugin-builder UI,
the review screen with semantic diffs ("hostile spawns near spawn: 0.5x -> 1.4x", never a raw
JSON patch), deployment progress, queue position); `apps/mobile/` (Expo client, four screens
only: Servers, World feed, Proposals, Rollback; read-plus-approve; no authoring on the phone,
deliberately: the phone is the gate, and a gate with an authoring surface attached is a gate
people will use to rubber-stamp their own drafts); and the approvals/authoring/preview/proposals
endpoints. **Owns the approval token design**, the single mechanism the whole safety argument
rests on: append-only version rows, write-once S3 objects, digest recomputed at build time,
refusal on mismatch. Widest scope of the three: the phase plan gives E3 an explicit priority
order, and mobile (M6) is named as what gets cut first if time runs short: the phone can trail
the web review screen.

### The eight integration seams

Integration risk lives here and nowhere else.

| # | Seam | Provider | Consumers | Contract |
|---|---|---|---|---|
| 1 | `packages/contracts` | E3 | E1, E2 | Locked in Phase 0. Changes by PR, reviewed by whoever the type touches. |
| 2 | `buildRuleJar(ruleJson)` | E3 | E2 (`building` state) | Returns `{ jarUrl, contentDigest }`. Digest is recomputed, never trusted from input. |
| 3 | `POST /v1/servers/:id/deploy` | E2 | E1 (MCP/CLI/Director), E3 (web/phone approve) | Requires an approval token; validated against E3's `approvals` module. |
| 4 | `authorRules(serverId, prompt)` | E1 | E3 (API route, web form), E1 (MCP `author_rules`) | Returns a validated `rule_set_version` row. Deploys nothing. |
| 5 | Approval tokens | E3 | E1 (act tools), E2 (redemption at `building`) | Content-digest bound, single-use, short-lived, `issued_to`-scoped. |
| 6 | SSE `/v1/servers/:id/events` | E3 | E1 (CLI `--watch`), E2 (publishes deployment states), E3 (web, phone) | One event envelope, `Last-Event-ID` replay. |
| 7 | Telemetry pipeline | E1 end-to-end | E3 (proposals UI), E2 (runs the pods that emit) | Emitter -> `/internal/telemetry/:serverId` -> rollups -> Director. |
| 8 | DB migration sequence | E3 | E1, E2 | One owner, one sequence. Never two engineers writing migrations in parallel. |

---

## 14. Build order

Ordered so the riskiest assumption is tested first and every milestone produces something
demonstrable.

| Stage | Deliverable | Done when |
|---|---|---|
| M0 | Scaffold: lift the reusable subsystems into the new repo; re-point OpenTofu at E2's AWS account; per-tenant namespaces; confirm or upgrade the Velocity version; RCON password as a Secret. | A server can be created through the API and joined from the game client, exactly as the baseline does today. No new features. This is the baseline you must not break. |
| M1 | Prove the world moves: pod-to-pod copy (strategy B). A script, not a controller. | Delta sync + Paper cold boot measured on a realistic world. **The falsification test.** Whatever number comes back is the freeze window everyone designs the lobby experience around; find it before building anything on top of it. |
| M2 | Manual deployment: controller through `verifying`, driven by a hand-written rule JSON. Lobby workload deployed. No cutover. | Players drain to the lobby, the freeze runs, the candidate boots against the copied world and passes health checks. Abort at any point returns players and leaves no trace. This exercises the whole freeze-and-return cycle without a cutover. |
| M3 | Cutover: Velocity transfer endpoint and plugin change. Full state machine including rule rollback. | The product exists. You change a rule, players pass through the lobby into the new world without disconnecting, and you can put it back. Everything after this is leverage on a capability you already have. |
| M4 | Authoring + approvals: plain English to rule JSON through the existing validator; approval tokens; review screen with semantic diff. | Someone types a sentence, sees what it will do, approves it, and the world changes around them. |
| M5 | Agent surfaces: MCP server with the three tool classes; CLI with NDJSON output; `packages/contracts`. | An agent drafts a change and is correctly refused until a human approves. **The refusal is as important a demo as the success.** |
| M6 | Phone client (Expo app): servers, world feed over SSE, push proposals, approve/reject, rollback. | A proposal arrives as a notification and is approved from a phone while standing in the world. |
| M7 | Director + evaluation: telemetry emitter, rollups, proposal loop, evaluation harness. | The server proposes a change from observed play, an owner approves it from a phone, and the harness reports whether it helped. |
| M8 | Hardening: deployment queue, quota headroom and snapshot pruning, rate limits, reconciliation after backend restart. | A deployment survives the backend being killed mid-flight, reconciled from Kubernetes state, exactly as the backup module already reconciles Jobs. |

**M0-M3 is the entire product.** M4 makes it demonstrable to a non-technical audience. M5 is what
makes it an AI systems project rather than an infrastructure one, and it is cheap once the API
exists: the MCP server is a thin wrapper over endpoints already built. M6 and M7 are the
differentiators; M8 is what makes it real.

**Do not build the Director first because it is the fun part.** An agent that proposes rule
changes you cannot deploy live is a chatbot with extra steps. The deployment controller is the
product; the other six new components are surfaces and feeders. Build it first, driven by a
hand-written rule JSON committed to the repository. If deployment works with a static file,
everything else is plumbing. If it does not work, nothing else is worth building.

---

## 15. What not to build

| Tempting | Why not |
|---|---|
| In-JVM class hot-swapping | Java cannot safely unload loaded code; Paper has carried this as an open design problem for years. The entire value of this architecture is that it does not need to solve it. |
| Letting the model write Java | Discards the safety property that makes this shippable, and puts you in direct competition with AuraFlow's paid product on its own ground. |
| Live VM or JVM memory snapshotting | Enormous effort. `save-off` plus `save-all flush` already gives a consistent world on disk, though not in-memory plugin state, which is why rules must be stateless. |
| An unattended, fully autonomous Director | Removing the approval gate deletes the most defensible part of the design. Autonomy is not the achievement; safe autonomy is. |
| Supporting Fabric and NeoForge too | Mods normally require every player to install a matching client, destroying the "join with the game you already have" property, and it puts you against MineClawd where it is strongest. |
| A rule marketplace before M4 | The rules registry makes this cheap later. It is worth nothing until rules can deploy live. |
| Multi-game support | The DTO carries a `gameType` enum, so the seam exists. Leave it a seam. One game done properly beats two done partially. |

---

## 16. The claim that survives scrutiny

**Do not claim:** AI that writes plugins; changing a server without a restart; AI-generated
quests or dialogue; agents that play Minecraft. All four positions are occupied, some heavily.

**Do claim:** a game-server control plane exposed as a gated agent action space, where a rule
change is delivered by health-checked server replacement with no player disconnect, an automatic
snapshot, and one-action rollback, approved from a phone. Research found no product doing this,
and the individual pieces do not add up to it anywhere else.

The prior art, so nobody accidentally re-pitches an occupied position:

| Prior art | Scale | What it does, and where it stops |
|---|---|---|
| AuraFlow | $19–$99/mo | Plain English to production Paper API Java; compiles server-side and auto-fixes its own compilation errors. Stops at: you download the JAR and install it yourself. Paper 1.18.2–1.21.4. |
| BukkitGPT / CyniaAI | 55 stars | The open-source original: prompt to plugin, compiles via Maven and BuildTools, self-debugs. Status: development paused, users redirected to MineClawd. |
| MineClawd | 2.1K downloads, 61 stars | The closest existing thing. Natural language to live server change with no restart, writing commands, recipes, drops, listeners and tick behaviour. Stops at: an Architectury mod requiring a Fabric/Forge/NeoForge loader on the server rather than Paper, executing generated JavaScript in a mod runtime; no control plane, no snapshot, no rollback, no approval gate. MC 1.20.1–1.20.6 and 1.21–1.21.1. |
| Skript | 206.1K downloads | A decade of live-reloadable no-code behaviour on Paper, the comparison you will be asked about. Stops at: console-driven with no remote API; no candidate server, no health check, no snapshot, no rollback, no approval primitive; new addons still need a restart. It is a plugin, not a platform. |
| NSR-AI | 915 downloads | RAG support agent, AI companions, dynamic quests and dialogue. Explicitly does not execute commands or alter server behaviour live. |
| AI-Player | 153.6K downloads | The largest AI-Minecraft audience by downloads: an intelligent second player. Multiplayer is not implemented. Controls a character, not the world's rules. |
| Voyager / MineDojo | Research | Voyager is the canonical LLM-Minecraft agent, writing JavaScript against Mineflayer to control a bot. MineDojo is not an agent; it is the framework, internet-scale dataset and MineCLIP reward model underneath much of that work (NeurIPS 2022 Outstanding Paper). Different layer entirely: they act as a player inside the rules; this changes the rules. |
| Pterodactyl / Pelican | Panel standard | Everything operational. No hot plugin loading, no authoring, no agent surface. Their REST APIs are CRUD over servers and files: no change object an agent could be bounded by, no approval primitive, no rollback. |

Why only this platform can build the mechanism: it needs simultaneous ownership of the **builder**
(to produce the new plugin artefact), the **orchestrator** (to stand up a replacement and move a
volume), and the **proxy** (to move players without a reconnect). AuraFlow and its kin have only
the builder; Aternos and Shockbyte have orchestrator and proxy but no authoring surface;
Pterodactyl and Pelican have only the orchestrator; MineClawd has live change but no control
plane. This project has all three; only the controller that sequences them is missing.

---

## 17. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| Freeze window too long to feel acceptable | High | The core technical risk. Freeze = delta sync + Paper cold boot on B. Prototype and measure this first (M1). The lobby handover means the honest claim is "no disconnect", which survives a slow window; do not promise "instant". |
| Double resource cost during deployment | Medium | Quota must reserve headroom for one concurrent candidate per user. Karpenter's 8 CPU / 16 Gi ceiling caps cluster-wide concurrency; serialise deployments behind a queue. Retained snapshots also accumulate and must be quota'd. |
| Rule vocabulary too narrow to be interesting | Medium | The safety property comes from constraining the vocabulary; the product value comes from widening it. Expand deliberately, one reviewed primitive at a time, treating each as a security change. |
| Approval fatigue | Medium | If every trivial change needs a tap, owners will look for a way to switch the gate off. Solve it by batching, not by tiering: group a session's proposals into one review with one tap. Auto-approval tiers are the obvious fix and the wrong one for v1: any rule class that auto-approves is a class a player can reach through chat injection, which deletes the strongest safety property. If tiering is ever added it must be opt-in per server, restricted to classes the Director cannot reach from any player-authored text, and revoked automatically on a rejected proposal. |
| Paper 26.x moves under you | Medium | 26.1 turned gamerules into a registry and renamed them camelCase to snake_case; 26.2 removed previously deprecated API. Pin the Paper build in the template and treat a bump as a deliberate migration. |
| Prompt injection via in-world text | Medium | Chat, signs, item names and player names are untrusted data, never instructions. The approval gate is mandatory and unconditional, which is only true for as long as no auto-approval tier exists. See the approval-fatigue row. |
| Approval token substitution | High | A token that names a version rather than its content can be approved against a benign draft and redeemed against a rewritten one. Bind the token to a digest of the exact rule JSON the human saw, make rule versions append-only with write-once storage, and recompute the digest at build time. **This is the one failure that would compromise the entire safety argument.** |
| Skript comparison in every conversation | Low | Expect it and answer directly: Skript is a console-driven interpreter with no candidate, no health check, no snapshot, no rollback and no remote API. Both are legitimate; they are not the same thing. |

### What would falsify this

1. **If the freeze window cannot be brought to a tolerable length.** Measure delta sync plus
   Paper cold boot on a realistic world before building anything else. This is the load-bearing
   assumption.
2. **If Velocity's backend transfer proves visibly disruptive** in ways players reject. The pitch
   rests on "nobody gets disconnected" being literally true.
3. **If Paper ships a first-party plugin lifecycle API.** Open issues exist. If it lands,
   in-process reload becomes safe and the orchestration advantage narrows, though the agent
   surface, gating, snapshotting and rollback all remain.
4. **If the Director's proposals are not better than a random baseline.** Run a third arm of
   randomly sampled valid rule changes and compare against it. The result will be directional
   rather than significant; report it anyway, negative or not. Asserting the loop works without
   measuring it is the failure mode the evaluation section exists to avoid.

---

## 18. The demonstration script

Two minutes, in this order, with the game on screen throughout:

1. **Be in the world (M3).** Standing in Minecraft, connected through the proxy. Two clients if
   possible, so the audience sees it is genuinely multiplayer.
2. **Ask an agent, in a terminal, to change the world (M5).** It reads telemetry through MCP,
   drafts a rule set, and calls `deploy_rules`, and is refused for lack of approval. Show the
   structured refusal. This is the single most important five seconds of the demo: it proves the
   agent is bounded by design, not by prompt.
3. **Approve it on the phone (M6).** The notification arrives, the diff is legible, one tap.
4. **Watch the deployment (M3)** (candidate staging, world syncing) while you keep playing.
   Nothing is happening to you yet.
5. **The handover (M3).** Brief lobby, then into the new world. Still connected. Test the new
   rule live.
6. **Break it deliberately (M4/M6).** Deploy a rule you know is bad, then roll back from the
   phone and show the world return, with everything players did since the change still intact.
   Say out loud what rollback does not undo; the honesty lands better than the claim would.
7. **The Director (M7), if it exists:** a proposal generated from the last few minutes of play,
   with its rationale and the before/after result for a previous one.

**Steps 2 and 6 are what convince engineers.** Anyone can demonstrate a change; demonstrating a
refused change and a reversible one on a live multiplayer world is what makes the architecture
legible in ten seconds.

---

## 19. Working agreements

How three parallel tracks avoid blocking each other:

- **E2 owns the AWS account, so E1 and E3 must not need it.** E2 delivers, early: a local cluster
  path (kind or k3d) reproducing namespaces and quotas, plus a docker-compose Postgres.
- **E3 delivers contracts and a mock API first**, so E1's MCP/CLI and E3's own web/phone can be
  built against it before the real controller exists.
- **E1 works from a recorded telemetry fixture** until real worlds emit events.
- **Migration sequence has one owner.** E3 owns `packages/db` and the migration sequence from
  head 0005. E1 and E2 request tables by PR; nobody writes a migration in parallel with anyone
  else. This is seam 8, and it is the cheapest integration failure to prevent.
- **Contract changes land by PR to E3**, reviewed by whoever else the type touches.
  `packages/contracts` is locked in Phase 0; after that it changes deliberately, not
  incidentally. Tool schemas, CLI output types and mobile screens are all generated from or typed
  against it, so an unreviewed change breaks three surfaces at once.
- **The one genuine serialisation is M1.** Nobody designs the lobby experience or the deployment
  UX until E2 reports the measured freeze window. That number (delta sync plus Paper cold boot
  on a realistic world) is a hard input to everyone else's design, not a detail to be tuned
  later. It is due before anyone builds on top of it, and if it cannot be brought to a tolerable
  length, that falsifies the core assumption and we need to know immediately, not at M4.
- **Test the abort path harder than the happy path.** The invariant (section 4.4) is enforced in
  code and exercised in M2's freeze-and-return cycle before any cutover exists.

The expanded per-engineer briefs are in `ENGINEER-1.md`, `ENGINEER-2.md` and `ENGINEER-3.md`;
the milestone-by-milestone schedule with cut lines is in `PHASES.md`.
