/**
 * The seam between the Director loop and whatever produces a brief.
 *
 * Deliberately the same shape as `RuleModel` in packages/authoring rather than a
 * second pattern invented here: one method, plain string fields, no provider
 * type crossing it. That is what lets every test in apps/api drive a scripted
 * fake, and there is no API key in this workspace to make anything else possible.
 *
 * No provider adapter lives in this module. STACK.md section 5 keeps client
 * construction in a single file so the Bedrock switch stays one constructor, and
 * that file is packages/authoring/src/anthropic.ts. The composition root builds
 * the Director's implementation with the settings section 5 records for it:
 * `claude-opus-5`, adaptive thinking, and `output_config.effort` of "medium"
 * rather than authoring's "high", because a proposal is a suggestion a human
 * reads while an authored document is the thing that has to be correct.
 */

export interface ProposalModelRequest {
  /** Rules of engagement and the brief's output shape. Identical on every call. */
  readonly system: string;
  /** This server's turn: the rollups it was asked to read, and any owner feedback. */
  readonly instruction: string;
}

export interface ProposalModel {
  /**
   * Returns a parsed JSON brief, typed unknown because nothing but `parseBrief`
   * is allowed to decide that a value is one. An implementation that returned a
   * typed brief would be asserting the thing the parser exists to establish, and
   * the brief is assembled from a model that has just read player-influenced
   * data.
   */
  propose(request: ProposalModelRequest): Promise<unknown>;
}
