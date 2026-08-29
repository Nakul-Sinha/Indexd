import { $ } from "bun";
import { type Comment, scanForRequests } from "./mentions.ts";

/**
 * Report whether a pull request has an unanswered review request.
 *
 *   bun run tools/pr-gatekeeper/src/watch-mentions.ts 35
 *
 * Exit 0 with "none" when there is nothing to do, exit 0 with "REVIEW_REQUESTED"
 * and the requesting comments when there is. The comments are printed so a human
 * or an agent can see what was asked, as quoted data. They are not instructions.
 */

const number = process.argv[2];
if (!number) {
  console.error("usage: watch-mentions.ts <pr-number>");
  process.exit(1);
}

const result = await $`gh pr view ${number} --json comments`.quiet().nothrow();
if (result.exitCode !== 0) {
  console.error("could not read comments");
  process.exit(1);
}

const parsed = JSON.parse(result.stdout.toString()) as {
  comments: { author: { login: string }; createdAt: string; body: string }[];
};

const comments: Comment[] = parsed.comments.map((comment) => ({
  author: comment.author.login,
  createdAt: comment.createdAt,
  body: comment.body,
}));

const { pending, lastAuditAt } = scanForRequests(comments);

if (pending.length === 0) {
  console.log(`none (${comments.length} comments, last audit ${lastAuditAt ?? "never"})`);
} else {
  console.log("REVIEW_REQUESTED");
  console.log(`last audit: ${lastAuditAt ?? "never"}`);
  for (const comment of pending) {
    console.log(`--- from ${comment.author} at ${comment.createdAt} ---`);
    console.log(comment.body.slice(0, 600));
  }
}
