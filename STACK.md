# STACK.md — Farlands Live

Every technology decision for every component, with the reason. One choice per slot, not a
survey. Where a decision is genuinely close, the runner-up is named and the tiebreaker stated.

Read [CONTEXT.md](CONTEXT.md) for what the system is and [PHASES.md](PHASES.md) for when each
piece gets built. This file answers only "with what".

## The four constraints every decision below obeys

1. **The lifted code is not up for redesign.** `packages/plugin-builder` and `plugin-runtime/`
   come over wholesale. Their internal choices — including whatever `validation.ts` validates
   with — stay as they are. Rewriting the validator is a security change, not a stack change.
2. **Three engineers, one repo, no shared files.** Anything that forces two people into the same
   file is wrong regardless of its merits.
3. **Boring where it is load-bearing.** The deployment controller and the approval path get the
   most conservative option available. Novelty is spent on the agent surface, where the payoff is.
4. **No new infrastructure without a reason that survives a hackathon.** Postgres and S3 exist.
   A second datastore has to earn its operational cost.

---

## The stack at a glance

| Layer | Choice |
|---|---|
| Language (everything except the game layer) | TypeScript 5.x, `strict: true` |
| Language (game layer) | Java 25 |
| Package manager / workspaces | Bun workspaces |
| Task orchestration | Turborepo |
| Server runtime | Bun (`apps/api`, `apps/mcp`, `apps/cli`) |
| Framework-driven runtime | Node 22 LTS (`apps/web`, `apps/mobile`) |
| HTTP framework | Elysia |
| Shared types + validation | TypeBox, in `packages/contracts` |
| Database | PostgreSQL 16 + Drizzle ORM + drizzle-kit |
| Queue / scheduler | pg-boss (Postgres-backed) |
| Object storage | S3, `@aws-sdk/client-s3` v3, Object Lock on the rules prefix |
| Model provider | Anthropic API, `@anthropic-ai/sdk`, `claude-opus-5` |
| Agent surface | `@modelcontextprotocol/sdk` (stdio + Streamable HTTP) |
| CLI | citty, compiled with `bun build --compile` |
| Web | Next.js App Router + React + Tailwind + Better Auth |
| Mobile | Expo + Expo Router + React Query + Expo Notifications |
| Kubernetes client | `@kubernetes/client-node` |
| Game server | Paper 26.x on `itzg/minecraft-server` |
| Proxy | Velocity 4.1.1 |
| Java JSON / HTTP | Gson + `java.net.http.HttpClient` (both already present) |
| IaC | OpenTofu + TFLint + Checkov |
| Lint / format | Biome |
| Tests | `bun test` · Vitest (web) · jest-expo (mobile) · JUnit 5 (Java) |
| Logging | pino (JSON) |
| Tracing / errors | OpenTelemetry SDK + Sentry |
| CI | GitHub Actions |

---

## 1. Language and runtime

**TypeScript everywhere except the game layer, `strict: true` from the first commit.** Turning
strict on later across nine workspaces is a week nobody has.

**Bun for server-side, Node 22 for the two framework apps.** Bun is the baseline's backend
runtime and it is genuinely better here: native TypeScript execution with no build step in dev,
a fast test runner, and `bun build --compile` produces the single-file CLI binary the work order
asks for. But Next.js and Expo/Metro both target Node, and neither is worth debugging on a
non-default runtime during a build with fixed dates. So:

| Workspace | Runtime |
|---|---|
| `apps/api`, `apps/mcp`, `apps/cli`, all `packages/*` | Bun |
| `apps/web`, `apps/mobile` | Node 22 LTS |

Bun is the package manager and workspace root for all nine regardless. Pin both in `engines` and
in CI so the split is explicit rather than accidental.

**Turborepo for task orchestration.** Nine workspaces with real dependency edges — `contracts`
feeds five consumers, and the MCP schema-drift check has to run after a contracts build. Bun's
script runner does not do dependency-aware ordering; Turborepo does, and its cache makes the CI
matrix affordable. This is the one piece of build tooling that pays for itself immediately.

---

## 2. `packages/contracts` — TypeBox

The single most consequential choice in this file, because seam 1 touches all three engineers.

**TypeBox.** It gives three artifacts from one definition:

- **Static TypeScript types** — what every workspace imports.
- **Runtime validation** — Elysia is TypeBox-native, so route validation is the same object with
  no adapter and no second schema to drift.
- **JSON Schema** — TypeBox *is* JSON Schema at runtime, which is exactly what MCP tool schemas
  and strict tool-use definitions require. The work order demands tool schemas generated from
  contracts with a CI check that fails on drift; with TypeBox that generator is a serialization,
  not a translation.

Zod is the runner-up and would win on a Hono or Express codebase — `z.toJSONSchema()` closed most
of the gap. The tiebreaker is Elysia: with Zod, every route needs an adapter and TypeBox ends up
in the tree anyway as Elysia's internal representation. One schema language beats two.

What lives here: the deployment state union (E2 authors, E3 hosts), the SSE event envelope, the
structured refusal, the NDJSON deployment-event object, `rule_set_version`, `proposal`, the
rollup metrics type, the MCP tool schemas, and every API request/response pair.

**This does not extend to `packages/plugin-builder`.** The lifted `types.ts` and `validation.ts`
keep their own validation library. They are the rule vocabulary — the security boundary — and
they arrive reviewed. Porting them to TypeBox would mean re-deriving the safety property by hand.
Contracts *references* the rule-document type across the seam; it does not re-implement it.

---

## 3. `packages/db` — Postgres 16 + Drizzle

Drizzle is the baseline's ORM and the right one here anyway: schema-as-TypeScript, generated SQL
migrations that get reviewed as SQL, and no runtime code generation step to keep in sync.

- **drizzle-kit** for the migration sequence, continuing from head `0005`. E3 is sole owner
  (seam 8).
- **`jsonb`** for `world_events_rollup.metrics`, `proposals.suggested_rules`, and experiment
  metric sets. These are read whole and never queried by inner key at speed.
- **Append-only enforced in the database, not in the application.** `rule_set_versions` gets a
  `BEFORE UPDATE OR DELETE` trigger that raises. The work order says a rewritten rule version
  must be impossible; a repository method that declines to write is a convention, and a trigger
  is a guarantee.
- **No TimescaleDB, no ClickHouse, no Redis.** Raw events are never stored, so there is no
  time-series volume to justify a second engine, and pg-boss removes the only other Redis
  argument.

---

## 4. Queue and scheduling — pg-boss

Three separate needs, one mechanism:

| Need | Owner |
|---|---|
| Cluster-wide deployment queue with a small concurrency limit | E2 |
| Director runs, rate-limited to one per server per hour | E1 |
| Snapshot pruning and rollup flush on a schedule | E2 / E1 |

pg-boss runs on the Postgres already in the cluster: durable across restarts, exactly-once with
visibility timeouts, cron-style scheduling, and per-queue concurrency caps. BullMQ is more
capable and needs Redis; Redis is a second stateful service to provision, secure per tenant, and
explain. Kubernetes `CronJob` handles the schedules but not the concurrency-limited queue, so it
would be a second mechanism next to whatever runs deployments.

One caveat to hold: pg-boss owns *queueing*, not *truth*. E2's deployment controller reconciles
from Kubernetes state after a restart — the queue schedules the work, the cluster says what
actually happened.

---

## 5. `packages/authoring` and the Director — Anthropic API

**`@anthropic-ai/sdk` against the Anthropic API, model `claude-opus-5`.**

| Setting | Value | Why |
|---|---|---|
| Model | `claude-opus-5` | Default for both authoring and the Director. |
| Thinking | `thinking: { type: "adaptive" }` | On by default on this model; set it explicitly so the intent is legible. |
| Effort | `output_config: { effort: "high" }` for authoring; `"medium"` for Director proposals | Authoring correctness is worth the tokens; a proposal is a suggestion a human reads. |
| Output shape | `output_config: { format: … }` — structured outputs | Constrains generation to the rule-document JSON Schema, so the repair loop starts from a document that is already shape-valid. |
| Caching | `cache_control` on the system prompt and the vocabulary schema | The vocabulary prefix is large, identical across every call, and Opus 5's 512-token cache minimum is the lowest in the family. |
| Streaming | Yes, with `.get_final_message()` | Long generations, no HTTP-timeout risk. |

**Structured outputs does not replace `validation.ts`.** It gets the model to the right *shape*;
`validation.ts` enforces the *semantics* — regions that exist, primitives that are permitted, the
stateless-rules constraint. The order is: structured generation → `validation.ts` → repair loop on
failure → hard fail after three attempts. There is still exactly one path in, and it is the
validator.

**Why the direct API rather than Bedrock**, given the project is otherwise AWS-native and E2 holds
the credits: prompt caching, structured outputs and adaptive thinking land on the first-party API
first, and the positioning document's own argument is that the Paper 26.x window has a shelf life
of months. Moving fast is the strategy. If credit economics force the move, the switch is a client
constructor — `AnthropicBedrockMantle` with an `anthropic.`-prefixed model id — and nothing else in
the authoring package changes. Keep the client construction in one file so that stays true.

The API key lives in AWS Secrets Manager, reached through EKS Pod Identity like every other
credential. It never reaches a container environment variable in plaintext and never reaches a
sandbox.

---

## 6. `apps/api` — Elysia on Bun

Elysia is the baseline's framework and the TypeBox pairing makes it the right one to keep.
Route-level schemas come straight from `packages/contracts`, so a route cannot accept a body its
contract forbids.

**SSE with `Last-Event-ID` replay** is the piece worth specifying, because three clients depend on
it (seam 6):

- Elysia's async-generator streaming over `Bun.serve` — no extra library.
- **Replay buffer:** an in-memory ring per server (last N events, minutes not hours) for the
  common reconnect, falling back to reconstructing from `deployments` rows and rollups when the
  requested `Last-Event-ID` predates the ring. A phone in a lift resumes from memory; a phone that
  was closed overnight resumes from the database.
- The buffer is per-process. That is correct at current scale and becomes wrong the moment the API
  runs more than one replica — noted here so it is a known limit rather than a surprise.

**Rate limiting is server-side and Postgres-backed** — a windowed counter table keyed by
(principal, server, window). In-memory counters are per-replica and therefore not a limit.

**Kubernetes access** via `@kubernetes/client-node`, the official client, used only from E2's
modules.

---

## 7. `apps/mcp` — the official MCP SDK

**`@modelcontextprotocol/sdk`**, TypeScript, on Bun.

- **Two transports.** stdio for an agent running in a terminal on someone's machine — the demo
  path. Streamable HTTP for remote and hosted agents, authenticated with a machine token.
- **Tool schemas are generated, not written.** A build step serializes the TypeBox contract types
  to JSON Schema and writes them into the server; CI regenerates and fails if the committed output
  differs. This is the mechanical guarantee behind seam 1.
- **`strict: true`** on tool definitions where the calling agent supports it, so tool inputs
  validate exactly rather than approximately.
- **Structured refusals are a return value, not an exception.** The refusal shape in ENGINEER-1.md
  §6 is a contract type returned identically by the MCP act tools, the CLI, and E2's deploy
  endpoint. Anything that throws will be rendered by some agent framework as a stack trace, and
  the demo depends on it being readable.

---

## 8. `apps/cli` — citty, compiled with Bun

**citty** for the command tree: TypeScript-first, minimal, and it does not fight the single-binary
build. Commander is the runner-up and the safer name; citty wins on argument typing and on not
pulling a help-formatter opinion into the NDJSON path.

**`bun build --compile`** produces a standalone binary with no Node install required on the target
machine — which matters for a CLI meant to run in CI and in other people's terminals.

Two hard rules that shape the implementation:

- **`--json` writes pure NDJSON to stdout.** No colour, no ANSI, no progress spinner, no banner.
  Human-facing output goes to stderr or is suppressed entirely under `--json`. A single stray
  escape sequence breaks every consumer.
- **Human mode uses `picocolors` and a hand-rolled table.** No TUI framework. The output is a list
  of named steps with timings, ending with the rollback command — a renderer, not an application.

`--watch` consumes the SSE endpoint with polling of `GET /v1/deployments/:id` as fallback, and
carries a per-state stall budget so it can detect a hang and call abort.

---

## 9. `apps/web` — Next.js

Next.js App Router with React and **Better Auth + Google OAuth**, all inherited from the baseline
web app, extended rather than replaced.

- **Tailwind** for styling. The review screen is the only screen with real design weight and it is
  a diff renderer, not a design system.
- **The semantic diff is hand-written.** Explicitly do not reach for `jsondiffpatch`,
  `rfc6902`, or any JSON-patch library: they produce exactly the artifact the product forbids
  showing a human. The renderer walks the rule vocabulary and emits sentences —
  "hostile spawns near spawn: 0.5x -> 1.4x". It is vocabulary-aware by construction, which means
  it grows when the vocabulary grows, and that is the correct coupling.
- **TanStack Query** for server state, matching mobile so the two clients share fetch semantics.

---

## 10. `apps/mobile` — Expo

Expo with Expo Router, TanStack Query, and **Expo Notifications** for the proposal pushes.

One gotcha worth stating in the stack file because it will otherwise be discovered late:
**React Native has no native `EventSource`.** The SSE replay behaviour the work order requires —
resume via `Last-Event-ID` rather than restart — needs `react-native-sse` or an equivalent
fetch-stream implementation with explicit reconnect handling. Budget for it; it is not free the way
it is on web.

Four screens, no navigation library beyond Expo Router, no state manager beyond Query. The app is
read-plus-approve, so there is no form state worth a library.

---

## 11. The Java layer

**Java 25** throughout — Paper 26.1+ requires it and Velocity 4.1.1 requires it, so there is no
choice to make.

**`plugin-runtime/` stays Maven.** It is lifted wholesale and restructuring it is explicitly out
of scope. E1's `telemetry/` package is added inside the existing project.

For the telemetry emitter, both dependencies are already present, which is the entire reason to
pick them:

- **Gson** — ships on the Paper/Bukkit classpath. No shading, no relocation, no dependency
  conflict with another plugin's Jackson.
- **`java.net.http.HttpClient`** — in the JDK since 11. Async, no dependency at all.

The emitter batches, posts, and **fails silently**: a world whose ingest endpoint is unreachable
keeps playing. Telemetry never degrades the game. Use a bounded queue with a drop-oldest policy so
an outage cannot grow the heap.

**Velocity plugin build tool: confirm in Phase 0.** Velocity plugins are conventionally Gradle,
the baseline's routing plugin may be either, and E2 keeps whatever is already there. This is
listed as unresolved rather than guessed because E2 will have the answer within an hour of opening
the repo.

**Tests: JUnit 5**, with MockBukkit for the listener-level tests on the emitter.

---

## 12. Storage, digests, and the two mechanisms the safety argument rests on

### S3 Object Lock for write-once rule documents

The approval token binds to a digest of the exact document a human saw. If that S3 object can be
overwritten, the whole gate is decorative. Application-level "we only ever write once" is a
convention; **S3 Object Lock in Governance mode on the rule-documents prefix** is enforcement.

Two operational notes: Object Lock requires bucket versioning, and it must be enabled at bucket
creation — which puts it in E2's Phase 0 OpenTofu, not in a later hardening pass. Retention is set
per object at write time.

### RFC 8785 canonical JSON for the content digest

**SHA-256 over JCS-canonicalized JSON**, never over `JSON.stringify` output.

This is not pedantry. The digest is computed by E3's `buildRuleJar()`, recomputed by E2's
controller during `building`, and compared. Those are two different processes, potentially two
different runtimes, serializing the same logical document. Any difference in key order, unicode
escaping, or number formatting produces a different hash and refuses a legitimate deployment — a
bug that would present as "approvals randomly stop working" and take a day to find. Canonicalize
once, in a shared helper in `packages/contracts`, and have both sides call it.

### Token storage

Machine tokens and approval tokens are opaque random values, prefix-tagged (`flk_`, `apv_`) so
they are greppable in a leak, **stored only as SHA-256 hashes**. The `deployments` table holds
`approval_token_hash`, never the token. Prefix tagging also enables secret-scanning rules later.

---

## 13. Cross-cutting

| Concern | Choice | Note |
|---|---|---|
| Lint + format | **Biome** | One tool, one config, fast enough to run on pre-commit. Replaces ESLint + Prettier entirely. |
| Tests (Bun workspaces) | **`bun test`** | Built in, no config, fast. |
| Tests (web) | **Vitest** | Next.js compatibility. |
| Tests (mobile) | **jest-expo** | Expo's supported path; do not fight it. |
| Tests (Java) | **JUnit 5** + MockBukkit | |
| Logging | **pino** | JSON to stdout, collected by the cluster. Every MCP tool call is one structured line: caller, arguments, outcome. |
| Tracing | **OpenTelemetry SDK** | Deployment state transitions as spans makes the state machine legible in a trace view — the single highest-value instrumentation in the system. |
| Errors | **Sentry** | |
| Secrets | **AWS Secrets Manager** via **EKS Pod Identity** | Baseline pattern, extended. No AWS keys in containers. |
| CI | **GitHub Actions** | Biome · typecheck · `bun test` · contract-schema drift check · Maven build · `tofu validate` + TFLint + Checkov. |
| Containers | **`oven/bun`** base for services; **`itzg/minecraft-server`** for Paper | |

---

## 14. By engineer

**Engineer 1 — AI & Agent Systems.**
TypeScript on Bun. `@anthropic-ai/sdk` with `claude-opus-5`, adaptive thinking, structured
outputs, and prompt caching on the vocabulary prefix. `@modelcontextprotocol/sdk` over stdio and
Streamable HTTP. citty compiled to a binary with `bun build --compile`. Java 25 with Gson and
`java.net.http.HttpClient` for the in-world emitter. pg-boss for Director scheduling and the rollup
flush. Postgres-backed rate limiting. `bun test` plus JUnit 5.

**Engineer 2 — Cloud & Deployment Infrastructure.**
OpenTofu with TFLint and Checkov, EKS, Karpenter, S3 with Object Lock on the rules prefix, EKS Pod
Identity. `@kubernetes/client-node` from Elysia modules on Bun. pg-boss for the deployment queue.
Velocity 4.1.1 on Java 25. Paper 26.x on `itzg/minecraft-server`. RCON over the existing client on
25575 with the password as a Secret. OpenTelemetry spans across the state machine.

**Engineer 3 — Platform Core & Human Surfaces.**
TypeBox in `packages/contracts` — the seam everyone imports. Drizzle and drizzle-kit on Postgres 16
with an append-only trigger on `rule_set_versions`. The lifted plugin-builder untouched, wrapped as
`buildRuleJar()`, with JCS canonicalization behind the digest. Elysia on Bun for the API core and
the SSE endpoint. Next.js with Better Auth, Tailwind, TanStack Query and a hand-written semantic
diff renderer. Expo with Expo Router, TanStack Query, Expo Notifications and `react-native-sse`.

---

## 15. Rejected, and why

| Not using | Why not |
|---|---|
| Zod in `packages/contracts` | Good choice generally; loses to TypeBox only because Elysia is TypeBox-native and JSON Schema is the primary output we need. |
| Redis / BullMQ | A second stateful service to provision, secure per tenant, and explain. pg-boss uses the Postgres already there. |
| TimescaleDB or a time-series store | Raw events are never stored. There is no volume to justify it. |
| tRPC or Elysia Eden | End-to-end inference couples clients to the server implementation. `packages/contracts` is deliberately a separate, reviewable artifact — four clients and an MCP schema generator read it. |
| A JSON-patch diff library | Produces exactly the artifact the product forbids showing a human. The semantic renderer is vocabulary-aware by design. |
| Rewriting `validation.ts` in TypeBox | It is the security boundary and it arrives reviewed. Re-deriving it by hand is how you lose a safety property without noticing. |
| Nx | Turborepo covers dependency-aware tasks and caching with a fraction of the configuration. |
| ESLint + Prettier | Biome does both, faster, with one config file. |
| Bun for Next.js and Expo | Both toolchains target Node. Not worth debugging on a deadline. |
| Kubernetes `CronJob` for scheduling | Would sit alongside a queue mechanism rather than replacing one. |

---

## 16. Open at Phase 0

Four items that need a fact rather than an opinion. All are answerable in the first sitting.

1. **Velocity plugin build tool** — Gradle or Maven, whatever the baseline's routing plugin uses.
   E2 confirms on first read.
2. **What `validation.ts` validates with** — determines how `packages/contracts` references the
   rule-document type across the seam without duplicating it. One of the four `[CONFIRM]` files.
3. **How `jar-builder.ts` injects the rule JSON** — resource entry, manifest attribute, or
   rewritten class. Decides whether a rebuild is cheap enough to sit inside the `building` state.
   Also one of the four.
4. **Exact version pins** — Next.js, Expo SDK, Bun, and the Anthropic SDK are pinned to their
   current stable releases at Phase 0 and recorded here. Deliberately not guessed in advance; the
   Paper build in the template is pinned the same way, and bumping it is a deliberate migration,
   never a background update.
