import { Elysia } from "elysia";
import { z } from "zod";

const serverIdPattern =
  /^(?:srv_[a-z0-9]{3,32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$/;

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

export const allayCreateServerArgumentsDto = z
  .object({
    name: z.string().trim().min(3).max(50),
    type: z.enum(["paper", "vanilla"]).default("paper"),
    version: z
      .string()
      .trim()
      .regex(/^\d{1,2}\.\d{1,2}(?:\.\d{1,2})?$/)
      .default("1.21.8"),
    cpu_cores: z.number().int().min(1).max(16).default(1),
    ram_mb: z.number().int().min(512).max(32768).default(2048),
    storage_gb: z.number().int().min(2).max(500).default(5),
    max_players: z.number().int().min(1).max(100).default(20),
    difficulty: z.enum(["peaceful", "easy", "normal", "hard"]).default("normal"),
    pvp: z.boolean().default(true),
    seed: z.string().max(32).optional(),
    motd: z.string().max(100).optional(),
  })
  .strict();

export const allayPowerActionArgumentsDto = z
  .object({
    server_id: z.string().regex(serverIdPattern),
    action: z.enum(["start", "stop", "restart"]),
  })
  .strict();

export const allayProposalDto = z.discriminatedUnion("tool", [
  z
    .object({
      tool: z.literal("create_server"),
      arguments: allayCreateServerArgumentsDto,
    })
    .strict(),
  z
    .object({
      tool: z.literal("power_action"),
      arguments: allayPowerActionArgumentsDto,
    })
    .strict(),
]);

export type AllayCreateServerArguments = z.infer<typeof allayCreateServerArgumentsDto>;
export type AllayPowerActionArguments = z.infer<typeof allayPowerActionArgumentsDto>;
export type AllayToolProposal = z.infer<typeof allayProposalDto>;

export const AllayModel = new Elysia({ name: "allay.model" }).model({
  "allay.chat": allayChatDto,
  "allay.execute": allayProposalDto,
});
