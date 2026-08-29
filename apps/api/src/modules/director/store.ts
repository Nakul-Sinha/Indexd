import type { Proposal, ProposalStatus, RollupMetrics } from "@farlands/contracts";

/**
 * Persistence for proposals.
 *
 * The interface exists for the same reason the telemetry one does: the loop has
 * to be exercisable without a database, and the failure contract belongs in one
 * place. It also carries a safety property that a bare table does not. A
 * proposal is the Director's terminal action, so the shape of this seam is where
 * "the Director never deploys" stops being a convention and becomes a type.
 *
 * Two decisions make that hold:
 *
 *   1. `insertPending` takes no `status`. Pending is not a value a caller passes
 *      and could pass wrongly; it is the only status this method can produce, so
 *      there is no argument anyone can get wrong and no review to skip.
 *   2. The verdict write lives on this interface but not on the handle the
 *      Director is given (`DirectorProposalStore` below). Approval and rejection
 *      are the review surface's writes, and the Director holds a store it cannot
 *      call them on.
 *
 * The production implementation is Drizzle over the `proposals` table created by
 * `krishang/packages/db/migrations/0006_live_tables.sql`. That migration and its
 * sequence are Engineer 3's, so the table is requested by pull request rather
 * than written here. Two columns the contract needs are not in 0006 yet
 * (`created_at` and `observed`); until they land, a real store has nothing to
 * order rows by, which is what the hourly limit reads.
 */

/**
 * What the Director hands over. No id, no status, no reviewer: those are the
 * store's to assign and a human's to fill in later.
 */
export interface PendingProposalInput {
  readonly server_id: string;
  /** Already through validation.ts, because authorRules is the only way to get one. */
  readonly suggested_rules: unknown;
  readonly rationale: string;
  readonly confidence: number;
  /** The aggregates the proposal was reasoned from, so a reviewer can check it. */
  readonly observed: RollupMetrics | null;
}

/** A human's verdict on a queued proposal. */
export interface ProposalVerdict {
  readonly proposal_id: string;
  readonly status: Extract<ProposalStatus, "approved" | "rejected">;
  readonly reviewed_by: string;
  /**
   * Required on a rejection and refused on an approval. A rejection with no
   * reason is the one outcome that teaches the Director nothing, and the whole
   * argument for capturing it is that it is ground truth gathered at the moment
   * an owner was paying attention.
   */
  readonly rejection_reason?: string;
}

/**
 * The full table seam: the Director's writes plus the review surface's.
 */
export interface ProposalStore {
  /** Queue one proposal. The only write the Director makes, and it is always pending. */
  insertPending(input: PendingProposalInput): Promise<Proposal>;
  /** Newest proposal for a server, whatever its status. Backs the hourly limit. */
  latest(serverId: string): Promise<Proposal | null>;
  /** Rejected proposals for a server, newest first, for the next run's context. */
  recentRejections(serverId: string, limit: number): Promise<readonly Proposal[]>;
  /** Record a human verdict. Belongs to the review surface, never to the Director. */
  review(verdict: ProposalVerdict): Promise<Proposal>;
}

/**
 * The handle the Director is constructed with.
 *
 * Narrowing here rather than trusting the Director not to call `review` means
 * the no-deploy claim survives someone adding a feature in a hurry: approving is
 * what starts a deployment, and this type has no approve.
 */
export type DirectorProposalStore = Pick<
  ProposalStore,
  "insertPending" | "latest" | "recentRejections"
>;

export class ProposalNotFoundError extends Error {
  constructor(readonly proposalId: string) {
    super(`No proposal with id ${proposalId}.`);
    this.name = "ProposalNotFoundError";
  }
}

export interface InMemoryProposalStoreOptions {
  /** Injected so a test can place two runs an hour apart without waiting an hour. */
  now?: () => number;
  /** Injected so ids are reproducible in a test that compares two runs byte for byte. */
  mintId?: () => string;
}

function defaultMintId(): string {
  // ProposalId is prefixed and lowercase alphanumeric; uuid hex satisfies the
  // character class once the dashes are gone. The production default is
  // gen_random_uuid() with no prefix, which does not satisfy it, so that is a
  // migration to reconcile rather than a difference to paper over here.
  return `prp_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

/**
 * The development and test implementation.
 *
 * Rows are held per server in insertion order, which is also creation order, so
 * "newest" is the last element and no sort is needed. Nothing here prunes: a
 * proposal is a durable record of what was suggested and what an owner said
 * about it, and the row count grows with owner decisions rather than with play.
 */
export class InMemoryProposalStore implements ProposalStore {
  private readonly rows = new Map<string, Proposal[]>();
  private readonly byId = new Map<string, Proposal>();
  private readonly now: () => number;
  private readonly mintId: () => string;

  constructor(options: InMemoryProposalStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.mintId = options.mintId ?? defaultMintId;
  }

  async insertPending(input: PendingProposalInput): Promise<Proposal> {
    const row: Proposal = {
      proposal_id: this.mintId(),
      server_id: input.server_id,
      suggested_rules: input.suggested_rules,
      rationale: input.rationale,
      confidence: input.confidence,
      observed: input.observed,
      status: "pending",
      reviewed_by: null,
      reviewed_at: null,
      rejection_reason: null,
      created_at: new Date(this.now()).toISOString(),
    };

    const existing = this.rows.get(row.server_id);
    if (existing) existing.push(row);
    else this.rows.set(row.server_id, [row]);
    this.byId.set(row.proposal_id, row);

    return { ...row };
  }

  async latest(serverId: string): Promise<Proposal | null> {
    const rows = this.rows.get(serverId);
    const newest = rows?.at(-1);
    return newest ? { ...newest } : null;
  }

  async recentRejections(serverId: string, limit: number): Promise<readonly Proposal[]> {
    if (limit <= 0) return [];
    const rows = this.rows.get(serverId) ?? [];
    return rows
      .filter((row) => row.status === "rejected" && row.rejection_reason !== null)
      .slice(-limit)
      .reverse()
      .map((row) => ({ ...row }));
  }

  async review(verdict: ProposalVerdict): Promise<Proposal> {
    const row = this.byId.get(verdict.proposal_id);
    if (row === undefined) throw new ProposalNotFoundError(verdict.proposal_id);

    if (verdict.status === "rejected" && !verdict.rejection_reason?.trim()) {
      throw new Error(
        "A rejection needs a reason: it is the signal the rejection exists to carry.",
      );
    }
    if (verdict.status === "approved" && verdict.rejection_reason !== undefined) {
      throw new Error("An approval cannot carry a rejection reason.");
    }

    row.status = verdict.status;
    row.reviewed_by = verdict.reviewed_by;
    row.reviewed_at = new Date(this.now()).toISOString();
    row.rejection_reason =
      verdict.status === "rejected" ? (verdict.rejection_reason ?? null) : null;

    return { ...row };
  }

  /**
   * Everything the store holds, for tests that inspect persistence rather than
   * trust a claim about it. A test asserting "the only write is a pending row"
   * has to be able to see every row, including one an implementation wrote by
   * accident.
   */
  contents(): Record<string, readonly Proposal[]> {
    return Object.fromEntries(this.rows);
  }

  clear(): void {
    this.rows.clear();
    this.byId.clear();
  }
}
