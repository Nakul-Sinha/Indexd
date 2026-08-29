import { type Static, Type } from "@sinclair/typebox";
import { ContentDigest, RuleSource, ServerId, Timestamp } from "./common.ts";

/**
 * Rule sets and their versions.
 *
 * The registry stores a pointer, not the document: { name, gameType, jsonUrl,
 * version }. That indirection is what versioning and rollback need, and it is
 * why the S3 object behind json_url is write-once. A changed rule is a new row,
 * and a new row needs a new approval.
 */

export const RuleSet = Type.Object({
  rule_set_id: Type.String(),
  server_id: ServerId,
  name: Type.String({ minLength: 1, maxLength: 120 }),
  description: Type.Union([Type.String({ maxLength: 1000 }), Type.Null()]),
  game_type: Type.Literal("minecraft_paper", {
    description: "A seam, deliberately left a seam. One game done properly.",
  }),
  current_version: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
});
export type RuleSet = Static<typeof RuleSet>;

/**
 * Append-only. The database enforces this with a trigger rather than the
 * application enforcing it by convention, because the approval gate is only
 * meaningful if the approved content cannot be rewritten underneath it.
 */
export const RuleSetVersion = Type.Object({
  id: Type.String(),
  rule_set_id: Type.String(),
  version: Type.Integer({ minimum: 1 }),
  json_url: Type.String({ description: "S3 URL of the write-once rule document" }),
  content_digest: ContentDigest,
  built_jar_url: Type.Union([Type.String(), Type.Null()]),
  source: RuleSource,
  source_prompt: Type.Union([Type.String(), Type.Null()]),
  created_by: Type.String(),
  created_at: Timestamp,
});
export type RuleSetVersion = Static<typeof RuleSetVersion>;

/**
 * A semantic diff entry. Rendered as a sentence, never as a JSON patch: a diff
 * nobody can read is a gate nobody uses. The renderer walks the rule vocabulary,
 * which means it grows when the vocabulary grows, and that is the correct
 * coupling.
 */
export const RuleDiffEntry = Type.Object({
  kind: Type.Union([Type.Literal("added"), Type.Literal("removed"), Type.Literal("changed")]),
  rule_id: Type.String(),
  /** A complete sentence, for example "hostile spawns near spawn: 0.5x -> 1.4x". */
  summary: Type.String(),
  before: Type.Union([Type.String(), Type.Null()]),
  after: Type.Union([Type.String(), Type.Null()]),
});
export type RuleDiffEntry = Static<typeof RuleDiffEntry>;

export const RuleDiff = Type.Object({
  server_id: ServerId,
  from_version: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  to_version: Type.Integer({ minimum: 1 }),
  entries: Type.Array(RuleDiffEntry),
});
export type RuleDiff = Static<typeof RuleDiff>;
