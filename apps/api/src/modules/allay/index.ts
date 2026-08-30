import { Elysia } from "elysia";

import { AuthService } from "../auth/service";
import { type AllayChatInput, AllayModel } from "./model";
import { FixedWindowRateLimiter } from "./rate-limit";
import { AllayService } from "./service";

type AllayModuleDependencies = {
  authenticate: (cookie: string) => Promise<string>;
  reply: (input: AllayChatInput, signal?: AbortSignal) => Promise<string>;
  rateLimiter: FixedWindowRateLimiter;
  globalRateLimiter: FixedWindowRateLimiter;
};

export function createAllayModule(overrides: Partial<AllayModuleDependencies> = {}) {
  const authenticate =
    overrides.authenticate ?? ((cookie: string) => AuthService.requireServerControlUserId(cookie));
  const reply = overrides.reply ?? ((input, signal) => AllayService.reply(input, signal));
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

        const response = await reply(body, request.signal);
        return { success: true, data: { reply: response } };
      },
      { body: "allay.chat" },
    );
}

export const allayModule = createAllayModule();
