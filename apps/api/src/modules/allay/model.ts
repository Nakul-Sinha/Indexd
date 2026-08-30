import { Elysia } from "elysia";
import { z } from "zod";

const allayTurnDto = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1).max(500),
  })
  .strict();

export const allayChatDto = z
  .object({
    message: z.string().trim().min(1).max(180),
    history: z.array(allayTurnDto).max(8).default([]),
  })
  .strict();

export type AllayChatInput = z.infer<typeof allayChatDto>;

export const AllayModel = new Elysia({ name: "allay.model" }).model({
  "allay.chat": allayChatDto,
});
