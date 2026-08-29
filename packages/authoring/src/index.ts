/**
 * @farlands/authoring turns plain English into a validated rule document.
 *
 * One function serves all three callers named in ENGINEER-1.md section 5: the
 * web form, E3's author route, and the MCP `author_rules` tool. It emits JSON
 * documents that a pre-built runtime interprets, never source code, which is
 * the constraint that makes validation possible at all and gives the action
 * space a ceiling.
 *
 * It deploys nothing and it persists nothing. A caller that wants a
 * `rule_set_versions` row builds one from what authorRules returns, and the
 * only thing it can ever return is a document that
 * `provisionalValidation.validateRuleDocument` has already accepted.
 */

export {
  type AnthropicRuleModelOptions,
  AUTHORING_MODEL,
  authoringRequest,
  createAnthropicRuleModel,
  parseCandidate,
  RuleModelError,
} from "./anthropic.ts";
export type { RuleModel, RuleModelRequest } from "./model.ts";
export {
  type AuthoredRules,
  AuthoringFailedError,
  type AuthorRulesDeps,
  authorRules,
  MAX_ATTEMPTS,
} from "./pipeline.ts";
export {
  buildInstruction,
  type InstructionInput,
  type RepairReport,
  SYSTEM_PROMPT,
} from "./prompt.ts";
export { RULE_DOCUMENT_SCHEMA, RULE_DOCUMENT_SCHEMA_TEXT } from "./schema.ts";
