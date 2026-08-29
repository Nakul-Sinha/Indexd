import { Elysia } from "elysia";
import { z } from "zod";

export const serverActionDto = z.object({
  action: z.enum(["start", "stop", "restart"]),
});

const baseServerSchema = z.object({
  name: z.string().min(3).max(50),
  // Provisioning resolves an exact Mojang manifest entry. Aliases such as
  // "latest" are deliberately rejected so the stored configuration remains
  // reproducible and untrusted input cannot flow through as an arbitrary tag.
  version: z
    .string()
    .trim()
    .min(1)
    .max(16)
    .regex(
      /^\d{1,2}\.\d{1,2}(?:\.\d{1,2})?$/,
      "version must be an explicit Minecraft release (for example, 1.21.4)",
    ),
  cpuCores: z.coerce.number().int().min(1).max(16),
  ramMb: z.coerce.number().int().min(512).max(32768),
  storageGb: z.coerce.number().int().min(2).max(500),
});

// Game specific details
const minecraftSchema = baseServerSchema
  .extend({
    game: z.literal("minecraft"),
    type: z.enum(["vanilla", "paper", "fabric", "forge", "purpur"]).default("vanilla"),
    gameConfigJson: z
      .object({
        loaderVersion: z.string().optional(),

        seed: z.string().max(32).optional(),
        maxPlayers: z.number().min(1).max(100).default(20),
        difficulty: z.enum(["peaceful", "easy", "normal", "hard"]).default("normal"),
        pvp: z.boolean().default(true),
        motd: z.string().max(100).optional(),
      })
      .default({
        maxPlayers: 20,
        difficulty: "normal",
        pvp: true,
      }),
  })
  .superRefine((data, ctx) => {
    // If the server type is fabric or forge, loaderVersion becomes required
    if (["fabric", "forge"].includes(data.type) && !data.gameConfigJson.loaderVersion) {
      ctx.addIssue({
        code: "custom",
        message: `A loaderVersion is strictly required when using ${data.type}`,
        path: ["gameConfigJson", "loaderVersion"],
      });
    }
  });

export const createServerDto = z.discriminatedUnion("game", [
  minecraftSchema,
  // rustSchema,
  // cs2Schema,
]);

export type ServerActionInput = z.infer<typeof serverActionDto>;
export type CreateServerInput = z.infer<typeof createServerDto>;

export const updateServerConfigDto = z
  .object({
    cpuCores: z.coerce.number().int().min(1).max(16).optional(),
    ramMb: z.coerce.number().int().min(512).max(32768).optional(),
    storageGb: z.coerce.number().int().min(2).max(500).optional(),
    gameConfigJson: z
      .object({
        maxPlayers: z.number().min(1).max(100).optional(),
        difficulty: z.enum(["peaceful", "easy", "normal", "hard"]).optional(),
        pvp: z.boolean().optional(),
        motd: z.string().max(100).optional(),
        seed: z.string().max(32).optional(),
      })
      .refine((data) => Object.values(data).some((v) => v !== undefined), {
        message: "gameConfigJson must include at least one field",
      })
      .optional(),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "At least one field must be provided to update",
  });

export type UpdateServerConfigInput = z.infer<typeof updateServerConfigDto>;

export const ServersModel = new Elysia({ name: "servers.model" }).model({
  "servers.action": serverActionDto,
  "server.create": createServerDto,
  "server.update": updateServerConfigDto,
});
