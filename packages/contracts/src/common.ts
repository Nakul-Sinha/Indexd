import { type Static, Type } from "@sinclair/typebox";

/**
 * Shared primitives. Wire shapes use snake_case throughout, matching the
 * database columns and the structured refusal pinned in ENGINEER-1.md section 6.
 */

/** ISO-8601 timestamp, always UTC, always with an explicit offset. */
export const Timestamp = Type.String({
  format: "date-time",
  description: "ISO-8601 UTC timestamp",
});

/** A content digest, always prefixed with its algorithm. */
export const ContentDigest = Type.String({
  pattern: "^sha256:[0-9a-f]{64}$",
  description: "SHA-256 over RFC 8785 canonical JSON, prefixed with the algorithm",
});
export type ContentDigest = Static<typeof ContentDigest>;

export const ServerId = Type.String({ pattern: "^srv_[a-z0-9]{3,32}$" });
export type ServerId = Static<typeof ServerId>;

export const DeploymentId = Type.String({ pattern: "^dep_[a-z0-9]{3,32}$" });
export type DeploymentId = Static<typeof DeploymentId>;

export const ProposalId = Type.String({ pattern: "^prp_[a-z0-9]{3,32}$" });
export type ProposalId = Static<typeof ProposalId>;

/**
 * Token prefixes. Tokens are opaque random values stored only as SHA-256
 * hashes; the prefix exists so a leaked token is greppable and so secret
 * scanning can match on it later.
 */
export const TOKEN_PREFIX = {
  machine: "flk_",
  approval: "apv_",
} as const;

/** Where a rule version came from. Attribution is never optional. */
export const RuleSource = Type.Union(
  [Type.Literal("form"), Type.Literal("agent"), Type.Literal("director")],
  { description: "Origin of a rule version: a human form, an agent, or the Director" },
);
export type RuleSource = Static<typeof RuleSource>;

export const Paginated = <T extends ReturnType<typeof Type.Object>>(item: T) =>
  Type.Object({
    items: Type.Array(item),
    next_cursor: Type.Union([Type.String(), Type.Null()]),
  });
