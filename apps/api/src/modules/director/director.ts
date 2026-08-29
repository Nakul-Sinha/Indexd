import type { Proposal, provisionalVocabulary } from "@farlands/contracts";
// Relative because apps/api does not declare @farlands/authoring as a workspace
// dependency, and adding one is a package.json and lockfile change that belongs
// to whoever owns the manifest. The path points at the package's own entry
// rather than into its internals: authorRules is the front door, and reaching
// past it would be the private path into the registry that this module is
// specifically not allowed to have.
import {
  AuthoringFailedError,
  authorRules,
  type RuleModel,
} from "../../../../../packages/authoring/src/index.ts";
import type { RollupStore } from "../telemetry/index.ts";
import { BriefParseError, type ProposalBrief, parseBrief } from "./brief.ts";
import type { ProposalModel } from "./model.ts";
import { buildObservation, DIRECTOR_SYSTEM_PROMPT, type RejectionNote } from "./prompt.ts";
import { PROPOSAL_INTERVAL_SECONDS, proposalWindow } from "./rate-limit.ts";
import type { DirectorProposalStore } from "./store.ts";

/**
 * Observe, propose, queue. The whole module, and the whole of what the Director
 * is allowed to be.
 *
 *   observe   read closed rollup windows for one server
 *      |      (never raw events: none are stored anywhere)
 *      v
 *   propose   a request in plain English, through authorRules and therefore
 *      |      through validation.ts, like every other author
 *      v
 *   queue     insert one pending row
 *      |
 *      x      and stop. "act" belongs to a human holding a phone.
 *
 * The step after queue is a human approving on a phone or on the web, which
 * mints a token bound to the content digest they saw. Nothing in this file can
 * reach that step: there is no import of a deploy module, no HTTP client, no
 * route, and the store handle the Director is given has no approve on it. A test
 * asserts all of that at the source level rather than trusting this paragraph.
 *
 * The two model seams are both injected. One writes the brief, one authors the
 * document inside authorRules. Neither is constructed here, so nothing in this
 * workspace needs an API key and no test reaches the network.
 */

/** Attribution on every rule version the Director causes. Never optional. */
export const DIRECTOR_PRINCIPAL = "director";

/**
 * Twelve five-minute windows: the hour the Director was quiet for, which is the
 * same hour the rate limit made it sit out. Reading exactly the interval it
 * waited is the reason for the number.
 */
export const DEFAULT_WINDOW_LIMIT = 12;

/** How many past rejections are fed back. Recent ones; an owner's mind can change. */
export const DEFAULT_REJECTION_LIMIT = 5;

export interface DirectorDeps {
  /**
   * Read-only by construction. The Director consumes the telemetry module's
   * output and has no business writing a window, so it is handed the one method
   * it needs rather than the store.
   */
  readonly rollups: Pick<RollupStore, "list">;
  /** Insert and read. The approve and reject writes are not on this type. */
  readonly proposals: DirectorProposalStore;
  /** Writes the brief. Injected, and every test drives a scripted fake. */
  readonly model: ProposalModel;
  /** Turns the brief's request into a validated document. Owned by authorRules. */
  readonly ruleModel: RuleModel;
  readonly now?: () => number;
  /** Closed windows carried into one observation. */
  readonly windowLimit?: number;
  /** Rejections carried into one observation. */
  readonly rejectionLimit?: number;
  /** The proposal interval. Configurable so a test can compress an hour. */
  readonly intervalSeconds?: number;
}

export interface DirectorRunInput {
  /** The server facts semantic validation needs. The caller holds the server row. */
  readonly context: provisionalVocabulary.ServerRuleContext;
  /** The owner's display name for the server, if there is one. Data, like the regions. */
  readonly serverName?: string;
}

/**
 * Every way a run can end.
 *
 * A union rather than a thrown error, because most of these are ordinary
 * outcomes of a scheduled job rather than faults: a suppressed run, a quiet
 * server and an abstention are all the system working. Only a transport failure
 * propagates, and it propagates unchanged.
 */
export type DirectorRunOutcome =
  | { status: "proposed"; proposal: Proposal; attempts: number }
  | { status: "rate_limited"; interval_seconds: number; retry_after_seconds: number }
  | { status: "no_observation" }
  | { status: "abstained"; rationale: string }
  | { status: "unusable_brief"; message: string }
  | { status: "authoring_failed"; message: string };

export class Director {
  private readonly rollups: Pick<RollupStore, "list">;
  private readonly proposals: DirectorProposalStore;
  private readonly model: ProposalModel;
  private readonly ruleModel: RuleModel;
  private readonly now: () => number;
  private readonly windowLimit: number;
  private readonly rejectionLimit: number;
  private readonly intervalSeconds: number;

  constructor(deps: DirectorDeps) {
    this.rollups = deps.rollups;
    this.proposals = deps.proposals;
    this.model = deps.model;
    this.ruleModel = deps.ruleModel;
    this.now = deps.now ?? Date.now;
    this.windowLimit = deps.windowLimit ?? DEFAULT_WINDOW_LIMIT;
    this.rejectionLimit = deps.rejectionLimit ?? DEFAULT_REJECTION_LIMIT;
    this.intervalSeconds = deps.intervalSeconds ?? PROPOSAL_INTERVAL_SECONDS;
  }

  async run(input: DirectorRunInput): Promise<DirectorRunOutcome> {
    const serverId = input.context.server_id;

    // The limit is checked before anything else, so a suppressed run costs one
    // read and has no side effect at all: no model call, no tokens, and nothing
    // to undo. Checking it after generating would make the limit a filter on
    // output rather than a bound on how often the world changes.
    const latest = await this.proposals.latest(serverId);
    const verdict = proposalWindow(latest?.created_at ?? null, this.now(), this.intervalSeconds);
    if (!verdict.allowed) {
      return {
        status: "rate_limited",
        interval_seconds: verdict.interval_seconds,
        retry_after_seconds: verdict.retry_after_seconds,
      };
    }

    const rollups = (await this.rollups.list(serverId)).slice(-this.windowLimit);
    if (rollups.length === 0) {
      // Asking a model to confirm that a server with no telemetry has nothing
      // worth changing is pure cost with one possible answer.
      return { status: "no_observation" };
    }

    const observation = buildObservation({
      context: input.context,
      serverName: input.serverName,
      rollups,
      rejections: await this.rejectionNotes(serverId),
    });

    const candidate = await this.model.propose({
      system: DIRECTOR_SYSTEM_PROMPT,
      instruction: observation,
    });

    let brief: ProposalBrief;
    try {
      brief = parseBrief(candidate);
    } catch (error) {
      // A malformed brief ends the run quietly. There is no repair loop here on
      // purpose: authorRules already owns one for the part that has to be
      // correct, and a Director that retries until it gets an answer it likes is
      // a Director that proposes on every window.
      if (error instanceof BriefParseError) {
        return { status: "unusable_brief", message: error.message };
      }
      throw error;
    }

    if (!brief.propose) return { status: "abstained", rationale: brief.rationale };

    let authored: Awaited<ReturnType<typeof authorRules>>;
    try {
      authored = await authorRules(serverId, brief.request, {
        model: this.ruleModel,
        context: input.context,
        source: "director",
        createdBy: DIRECTOR_PRINCIPAL,
        serverName: input.serverName,
      });
    } catch (error) {
      // Three attempts produced nothing valid. That is a quiet hour, not an
      // exception a scheduler should be woken for.
      if (error instanceof AuthoringFailedError) {
        return { status: "authoring_failed", message: error.message };
      }
      throw error;
    }

    const proposal = await this.proposals.insertPending({
      server_id: serverId,
      suggested_rules: authored.document,
      rationale: brief.rationale,
      confidence: brief.confidence,
      // The newest closed window, because the contract carries one metric set
      // and this is the one a reviewer can check the rationale against without
      // an aggregation nobody defined.
      observed: rollups.at(-1)?.metrics ?? null,
    });

    return { status: "proposed", proposal, attempts: authored.attempts };
  }

  /**
   * What the owner has already said no to.
   *
   * This is the most useful signal in the system: ground truth about what an
   * owner actually wants, gathered at the exact moment they were paying
   * attention. A rejected proposal that teaches nothing was pure cost, so the
   * reasons are read back into every subsequent run for that server. A row with
   * no reason carries nothing and is skipped rather than padded.
   */
  private async rejectionNotes(serverId: string): Promise<RejectionNote[]> {
    const rejected = await this.proposals.recentRejections(serverId, this.rejectionLimit);
    return rejected.flatMap((row) =>
      row.rejection_reason === null
        ? []
        : [
            {
              rejected_at: row.reviewed_at,
              rationale: row.rationale,
              rejection_reason: row.rejection_reason,
            },
          ],
    );
  }
}
