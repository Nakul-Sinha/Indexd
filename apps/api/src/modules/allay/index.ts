import type { ToolOutcome } from "@farlands/mcp";
import { Elysia } from "elysia";

import { AuthService } from "../auth/service";
import { createAllayMcpBridge } from "./mcp";
import { type AllayChatInput, AllayModel, type AllayToolProposal } from "./model";
import { FixedWindowRateLimiter } from "./rate-limit";
import { type AllayReply, AllayService } from "./service";

type AllayModuleDependencies = {
  authenticate: (cookie: string) => Promise<string>;
  reply: (input: AllayChatInput, userId: string, signal?: AbortSignal) => Promise<AllayReply>;
  execute: (userId: string, proposal: AllayToolProposal) => Promise<ToolOutcome>;
  rateLimiter: FixedWindowRateLimiter;
  globalRateLimiter: FixedWindowRateLimiter;
};

function sanitizedExecutionError(outcome: ToolOutcome): { status: number; message: string } {
  switch (outcome.code) {
    case "invalid_arguments":
      return { status: 400, message: "The confirmed action arguments are invalid." };
    case "not_found":
      return { status: 404, message: "That server is unavailable or outside this account." };
    case "approval_required":
      return { status: 409, message: "The control plane did not accept the confirmation." };
    case "upstream_unreachable":
    case "upstream_error":
      return { status: 502, message: "The live control plane could not complete the action." };
    default:
      return { status: 500, message: "The confirmed action could not be completed." };
  }
}

export function createAllayModule(overrides: Partial<AllayModuleDependencies> = {}) {
  const authenticate =
    overrides.authenticate ?? ((cookie: string) => AuthService.requireServerControlUserId(cookie));
  const reply =
    overrides.reply ?? ((input, userId, signal) => AllayService.reply(input, userId, signal));
  const execute =
    overrides.execute ??
    ((userId, proposal) => createAllayMcpBridge(userId).executeConfirmed(proposal));
  const rateLimiter = overrides.rateLimiter ?? new FixedWindowRateLimiter(20, 60_000);
  const globalRateLimiter = overrides.globalRateLimiter ?? new FixedWindowRateLimiter(100, 60_000);

  return new Elysia({ prefix: "/api/allay" })
    .use(AllayModel)
    .derive(async ({ headers }) => ({
      userId: await authenticate(headers.cookie ?? ""),
    }))
    .post(
      "/chat",
      async ({ body, request, userId, set }) => {
        if (!rateLimiter.consume(userId) || !globalRateLimiter.consume("all-users")) {
          set.status = 429;
          return { success: false, error: "Allay is resting for a moment. Please try again soon." };
        }

        const response = await reply(body, userId, request.signal);
        return { success: true, data: response };
      },
      { body: "allay.chat" },
    )
    .post(
      "/execute",
      async ({ body, userId, set }) => {
        let outcome: ToolOutcome;
        try {
          outcome = await execute(userId, body);
        } catch (error) {
          console.error("Allay confirmed execution failed", {
            name: error instanceof Error ? error.name : "UnknownError",
          });
          set.status = 502;
          return { success: false, error: "The live control plane could not complete the action." };
        }

        if (outcome.kind !== "ok") {
          const failure = sanitizedExecutionError(outcome);
          set.status = failure.status;
          return { success: false, error: failure.message };
        }
        return { success: true, data: outcome.body };
      },
      { body: "allay.execute" },
    );
}

export const allayModule = createAllayModule();
