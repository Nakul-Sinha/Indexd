/**
 * The seam between the repair loop and whatever produces candidates.
 *
 * It is one method over three plain fields on purpose. No provider type crosses
 * it, so the Bedrock switch STACK.md section 5 anticipates is a change of client
 * construction inside src/anthropic.ts and nothing else, and every test in this
 * package runs against a scripted fake rather than the network. There is no API
 * key in CI and there should never need to be one.
 */

export interface RuleModelRequest {
  /**
   * The rules of engagement and the vocabulary schema. Byte-identical on every
   * call, which is the only reason the cache breakpoint in src/anthropic.ts
   * pays for itself.
   */
  readonly system: string;
  /**
   * This attempt's turn: the server facts, the owner's request, and on a retry
   * the validation report that rejected the previous candidate. Server-derived
   * strings live inside delimited data sections here, never as instructions.
   */
  readonly instruction: string;
  /** 1-based. Attempt 1 is a fresh draft; later attempts carry a repair report. */
  readonly attempt: number;
}

export interface RuleModel {
  /**
   * Returns a parsed JSON candidate, typed unknown because nothing but
   * validateRuleDocument is allowed to decide that a candidate is a rule
   * document. An implementation that returned a typed document would be
   * asserting the thing the validator exists to establish.
   */
  generate(request: RuleModelRequest): Promise<unknown>;
}
