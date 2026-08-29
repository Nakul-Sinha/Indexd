# Farlands Live

**A game-server control plane whose entire surface (provisioning, rule authoring, live
deployment, rollback and telemetry) is exposed as an agent action space, with irreversibility
engineered out.**

A live multiplayer world an AI agent can safely reshape while people are inside it. Every change
is health-checked, approved by a human, and reversible.

> **Status:** early build. This README describes what the product is and how it works. The
> engineering plan lives in [CONTEXT.md](CONTEXT.md) and [PHASES.md](PHASES.md).

---

## The problem

A Minecraft server's behaviour is frozen the moment it boots. Changing what it does means adding
or updating a plugin, and that means a restart, which means kicking everyone out of the world.

This is not a bug anyone can patch. Java has no safe, supported mechanism for unloading
already-loaded code, so `/reload` is unsafe by design and every control panel's "install plugin"
button is a file copy followed by a restart. The problem has been open for years, and every
hosting panel on the market works around it the same way: it doesn't.

Unfreezing it does something more interesting than making deployment convenient. It turns a live
multiplayer world into a system an agent can act on, with a bounded action space, a human
approval gate, and an undo button.

## The mechanism

Live plugin deployment is unsolvable inside the JVM. Farlands Live doesn't try. It owns the
proxy and the orchestrator, so it solves the problem one layer up: build a replacement server,
move the world into it, move the players across, retire the original.

```
t0  Players connected to pod A (rules v1) through the proxy.

t1  New rule set authored and validated. Build a fresh JAR
    from the reviewed template + the new rule JSON.

t2  Provision pod B and its volume. Paper on B is NOT started.
    A keeps serving; nobody notices.

t3  Pre-sync the world A -> B while A is still live.
    Inconsistent, and that is fine: it shrinks the delta.

t4  Move players A -> lobby. A holding area, not a kick.
    Their session with the proxy never drops.

t5  FREEZE:
      A: save-off          disable autosave FIRST
      A: save-all flush    block until chunks are on disk
      delta-sync A -> B    only what changed since t3

t6  Start Paper on B against the delivered world.
    Health-check: up, rules loaded, no startup exceptions,
    TPS sane over a sampled window.
    Any failure -> abort, delete B, players return to A.

t7  Move every player lobby -> B. Backend-to-backend, no
    client reconnect, no address change, no kick.

t8  A drains and terminates. Its snapshot is retained.

    Player-visible disconnect: none.
```

**The invariant everything depends on:** pod A stays authoritative and untouched until cutover
succeeds. Every failure before that point costs a deleted candidate and nothing else: no player
noticed, no world changed.

**The honest version of the claim:** nobody gets *disconnected*, not nobody *notices*. Paper's
cold boot on the candidate sits inside the freeze window, so the cost is a delta sync plus a
server start: tens of seconds, spent in a lobby with a progress message rather than kicked to
the server list.

## Why this is an AI systems project

In most "AI + X" projects the model produces text a human then acts on. Here the model's output
*is* the action, and the engineering problem is making that safe.

- **The action space is a fixed set of typed operations.** A validated rule document, or a
  scoped server lifecycle call. Never code, never a shell, never raw cluster access. The rule
  schema is simultaneously the capability ceiling and the security boundary.
- **Every rule change is reversible, and the reversal is one operation.** A snapshot precedes
  every change. The limit, stated plainly: rollback restores the rules. Effects a bad rule
  already had on the world persist unless the owner accepts a snapshot restore and its data loss.
- **Blast radius is gated by health checks, not by hope.** The candidate must boot, load the
  rules and pass checks before a single player is moved to it. A rule that crashes the server
  reaches nobody.
- **The environment answers back.** Every change carries a before/after telemetry window, so the
  agent is measured against observed player behaviour rather than its own assessment of its work.
- **The threat model includes the users.** Players will try to steer an agent that can read
  chat. In-world text is data, never instruction, and the approval gate is not optional.

## Surfaces

| Surface | What it is |
|---|---|
| **MCP server** | The platform as an agent action space. Any agent (in a terminal, in an IDE, custom-built) can operate it directly. |
| **CLI** | The same API as a binary. Human-readable by default, newline-delimited JSON under `--json` so an agent or CI job can follow a long deployment as a stream. |
| **Phone** | Live world feed, proposals as push notifications, approve or reject against a readable diff, and rollback with one thumb. |
| **Web** | Dashboard, rule authoring, the review screen, deployment progress. |

### The tool boundary is the safety boundary

| Class | Tools | Effect |
|---|---|---|
| **READ** | `list_servers`, `get_server`, `get_world_telemetry`, `list_rule_sets`, `get_rule_set`, `diff_rule_sets`, `get_deployment` | No live effect. Scoped to the caller's own servers: telemetry is a behavioural record of named players. |
| **DRAFT** | `author_rules`, `preview_deploy` | Plain English in, validated rule document out. Deploys nothing. Rate-limited, because they invoke a model and create durable versions. |
| **ACT** | `deploy_rules`, `rollback`, `create_server`, `power_action` | Changes a live world. Requires an approval token minted by a human against the exact content being deployed. |

An agent can prepare a deployment, argue for it, and queue it. It cannot perform one.

## The approval gate

The approval token is what makes an agent-operable platform defensible rather than reckless:

- **Minted only by a human action**, in the dashboard or on the phone, after seeing a semantic
  diff, "hostile spawns near spawn: 0.5x -> 1.4x", never a raw JSON patch.
- **Bound to content, not to a name.** The token carries a digest of the exact rule JSON the
  human saw. The controller recomputes it at build time and refuses on mismatch, so an approved
  change cannot be substituted after the fact.
- **Redeemable only by the principal it was issued to**, short-lived, and single-use. An agent
  that sits on a token cannot bank authority.
- **No auto-approval tier.** Any rule class that auto-approves is a class a player can reach
  through chat injection. Approval fatigue is solved by batching a session's proposals into one
  review with one tap, not by tiering.

## The Director

The platform sits in the connection path and inside the world, so it can observe what actually
happens. The Director closes the loop:

```
observe    aggregated world telemetry
           (joins, deaths, blocks, time-in-region, chat volume)
   |
propose    a rule-set diff + rationale + confidence
   |
gate       owner approves on phone or web        [MANDATORY]
   |
act        deploy through the mechanism above
   |
evaluate   telemetry delta over the following window
           feeds the next observation
```

Be precise about what the evaluation is: an interrupted time series on a single server, not a
randomised trial. Order effects, time of day, novelty and a friend-group's worth of observations
are all uncontrolled. Report the delta and the sample size, with the confounds named, not a
winner.

## Rollback, precisely

Two different operations get called rollback, and conflating them loses data.

| Operation | What it does | When |
|---|---|---|
| **Rule rollback** *(the default)* | Deploys the previous rule version onto the current world. Play since the change is preserved. It stops the rule from acting further; it does not undo what the rule already did. | Almost always. This is what the phone's rollback button does. |
| **Snapshot restore** *(disaster recovery)* | Restores the retained world snapshot from before the change. Discards everything players did since. | Only when the world itself was corrupted or griefed. Requires explicit confirmation naming the data loss. |

## Architecture

| Layer | Choice |
|---|---|
| **Entrypoint** | AWS Network Load Balancer, one stable hostname per server |
| **Proxy** | Velocity with a dynamic-routing plugin, extended with player transfer and a lobby |
| **Orchestration** | Kubernetes on EKS, namespace per tenant, Karpenter within a hard spend ceiling |
| **Game server** | Paper 26.x in a pod with a persistent volume; RCON as the control channel |
| **Control plane** | Bun + Elysia, TypeScript: lifecycle, deployment controller, telemetry, billing of quota |
| **Rule runtime** | A pre-built, pre-reviewed Java plugin that interprets an injected JSON rule document |
| **Database** | Postgres + Drizzle: versions, deployments, approvals, rollups, proposals |
| **Object storage** | S3: rule documents (write-once), built JARs, world snapshots |
| **Realtime** | SSE with `Last-Event-ID` replay, consumed by web, CLI and phone |
| **Web** | Next.js |
| **Mobile** | Expo / React Native |
| **Agent surface** | MCP server, tool schemas generated from the shared contracts package |
| **Infra** | OpenTofu, with TFLint and Checkov enforced in CI |

## Repository layout

```
apps/
  api/          control plane: lifecycle, deployment controller, telemetry, director
  web/          Next.js dashboard and review screen
  mcp/          MCP server
  cli/          the farlands binary
  mobile/       Expo client
plugin-runtime/ Java rule interpreter + in-world telemetry emitter
packages/
  contracts/    shared types: the locked seam across all four clients
  db/           Drizzle schema and migrations
  plugin-builder/  rule document -> validated, digest-stamped JAR
  authoring/    plain English -> validated rule JSON
infra/
  k8s/          workloads, per-tenant namespaces, quotas, policies, lobby
  velocity/     proxy and routing/transfer plugin
  tofu/         OpenTofu
```

## Build order

The deployment controller is the product; everything else is a surface or a feeder.

| Stage | Deliverable |
|---|---|
| M0 | Scaffold: create a server through the API and join it from the game client |
| M1 | Prove the world moves: measure delta sync plus Paper cold boot |
| M2 | Manual deployment: freeze, candidate boots, health checks pass, abort returns players |
| M3 | Cutover: the product exists |
| M4 | Authoring and approvals |
| M5 | Agent surfaces: MCP and CLI |
| M6 | Phone client |
| M7 | Director and evaluation |
| M8 | Hardening: survive a backend restart mid-deployment |

M0–M3 is the entire product. M1 is the falsification test: if the freeze window cannot be brought
to a tolerable length, nothing above it is worth building.

## Running the scaffold

Requires Bun 1.4 or newer. Node 22 is needed later for the web and phone clients, which do not
exist yet.

```bash
bun install && bun run test
```

Other useful commands:

| Command | What it does |
|---|---|
| `bun run mock` | Start the mock API on port 4010 |
| `bun run typecheck` | Typecheck every workspace |
| `bun run lint` | Biome lint and format check |
| `bun run schemas:check` | Fail if the generated schemas drifted from the contract types |
| `bun run fixtures/telemetry/generate.ts` | Regenerate the recorded telemetry sample |

The mock API serves scripted deployments so clients can be built before the real controller
exists. Pick a scenario with a query parameter:

```bash
curl -X POST 'http://localhost:4010/v1/servers/srv_7f2/deploy?scenario=stall' -H 'content-type: application/json' -d '{"rule_set_version":3}'
```

`scenario` accepts `happy`, `stall`, `abort_at_verifying` and `fail_at_building`. Without an
approval token every deploy returns the structured refusal, which is the intended behaviour and
the thing worth looking at first.

## Documentation

| Document | What it covers |
|---|---|
| [CONTEXT.md](CONTEXT.md) | Full project context. Read this before touching any code. |
| [STACK.md](STACK.md) | Every technology decision, with the reason and the runner-up. |
| [PROVISIONAL-VOCABULARY.md](PROVISIONAL-VOCABULARY.md) | The two stand-in files, why they exist, and how to swap them out. |
| [PHASES.md](PHASES.md) | Step-by-step phases for the whole project and for each engineer. |
| [ENGINEER-1.md](ENGINEER-1.md) | AI and agent systems: authoring, MCP, CLI, telemetry, Director. |
| [ENGINEER-2.md](ENGINEER-2.md) | Cloud and deployment infrastructure: the mechanism. |
| [ENGINEER-3.md](ENGINEER-3.md) | Platform core and human surfaces: contracts, schema, web, phone. |

## What this is not

Do not claim, and do not build toward: AI that writes plugins; changing a server without a
restart; AI-generated quests or dialogue; agents that play Minecraft. All four positions are
occupied, some heavily.

The claim that holds is narrower and harder: a game-server control plane exposed as a gated agent
action space, where a rule change is delivered by health-checked server replacement with no
player disconnect, an automatic snapshot, and one-action rollback, approved from a phone.
