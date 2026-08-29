/**
 * Detect review requests addressed to the assistant in pull request comments.
 *
 * Stateless by construction. Rather than remembering which comments it has
 * seen, it anchors on the last audit it posted: a mention newer than that audit
 * is an unanswered request, and a mention older than it has already been
 * answered. Nothing to persist, nothing to get out of sync, and re-running is
 * harmless.
 *
 * Comment bodies are written by whoever opened or commented on the pull request.
 * Everything here treats them as text to match against and to quote back. No
 * function in this file interprets a comment as an instruction, and the caller
 * must not either: a mention is a signal to review, never a description of what
 * the review should conclude.
 */

export interface Comment {
  author: string;
  createdAt: string;
  body: string;
}

/** The header every posted audit starts with. This is the anchor. */
export const AUDIT_MARKER = "Gatekeeper audit, reviewed";

/**
 * Matches @claude as a whole word. Deliberately narrow: an email address or a
 * word like "claudette" should not trigger a review, and neither should a
 * mention inside a fenced code block that happens to contain the string.
 */
const MENTION = /(^|[^\w@/])@claude\b/i;

export function mentionsAssistant(body: string): boolean {
  return MENTION.test(stripFencedCode(body));
}

/**
 * Remove fenced code blocks before matching. A pull request quoting a config
 * file or a log line that contains the mention is not asking for a review.
 */
function stripFencedCode(body: string): string {
  return body.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
}

export interface MentionScan {
  /** Comments requesting a review that no audit has answered yet. */
  pending: Comment[];
  /** When the most recent audit was posted, or null if none has been. */
  lastAuditAt: string | null;
}

export function scanForRequests(comments: readonly Comment[]): MentionScan {
  const audits = comments.filter((comment) => comment.body.includes(AUDIT_MARKER));
  const lastAuditAt = audits.length > 0 ? (audits[audits.length - 1]?.createdAt ?? null) : null;

  const pending = comments.filter((comment) => {
    if (comment.body.includes(AUDIT_MARKER)) return false;
    if (!mentionsAssistant(comment.body)) return false;
    if (!lastAuditAt) return true;
    return Date.parse(comment.createdAt) > Date.parse(lastAuditAt);
  });

  return { pending, lastAuditAt };
}
