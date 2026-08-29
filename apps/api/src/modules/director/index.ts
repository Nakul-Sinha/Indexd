/**
 * The Director: the resident agent that closes the loop.
 *
 * Observe, propose, queue. It reads aggregated telemetry for one server, decides
 * whether the numbers justify one rule change, phrases that change as a request,
 * puts the request through the same authoring pipeline every other author uses,
 * and inserts a `pending` proposal. That row is its terminal action.
 *
 * The three properties this module exists to hold, each with a test rather than
 * a promise behind it:
 *
 *   1. It never deploys. No import of a deploy module, no HTTP client, no route,
 *      and a store handle with no approve on it. Approval is a human on a phone,
 *      minting a token bound to the digest they saw.
 *   2. One proposal per server per hour, enforced against the durable rows. A
 *      world that changes constantly is not alive, it is unstable.
 *   3. Player-authored text is data. Names never reach the prompt at all, because
 *      rollups carry cardinalities rather than names, and everything that does
 *      reach it sits inside a delimited data section with the delimiters stripped
 *      out of it.
 */

export { BriefParseError, type ProposalBrief, parseBrief } from "./brief.ts";
export {
  DEFAULT_REJECTION_LIMIT,
  DEFAULT_WINDOW_LIMIT,
  DIRECTOR_PRINCIPAL,
  Director,
  type DirectorDeps,
  type DirectorRunInput,
  type DirectorRunOutcome,
} from "./director.ts";
export type { ProposalModel, ProposalModelRequest } from "./model.ts";
export {
  buildObservation,
  DIRECTOR_SYSTEM_PROMPT,
  type ObservationInput,
  type RejectionNote,
} from "./prompt.ts";
export {
  PROPOSAL_INTERVAL_SECONDS,
  type ProposalWindowVerdict,
  proposalWindow,
} from "./rate-limit.ts";
export {
  type DirectorProposalStore,
  InMemoryProposalStore,
  type InMemoryProposalStoreOptions,
  type PendingProposalInput,
  ProposalNotFoundError,
  type ProposalStore,
  type ProposalVerdict,
} from "./store.ts";
