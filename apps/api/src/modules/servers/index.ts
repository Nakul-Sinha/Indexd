import { Elysia } from "elysia";
import { AuthService } from "../auth/service";
import { ServersModel } from "./model";
import { ServerService } from "./service";

const VALID_GAMES = ["minecraft", "rust", "cs2"];
const VALID_STATES = [
  "ready",
  "running",
  "stopped",
  "deleted",
  "provisioning",
  "starting",
  "stopping",
  "restarting",
  "failed",
];

export const serversModule = new Elysia({ prefix: "/api/servers" })
  .use(ServersModel)

  // Internal route must come BEFORE .derive() so it doesn't require
  // user session auth — it uses its own x-internal-key mechanism instead.
  .get("/internal", async ({ headers, query, set }) => {
    const internalKey = process.env.INTERNAL_API_KEY;

    if (!internalKey) {
      set.status = 503;
      return { success: false, error: "Internal API not configured" };
    }

    if (headers["x-internal-key"] !== internalKey) {
      set.status = 401;
      return { success: false, error: "Unauthorized" };
    }

    if (query.game && !VALID_GAMES.includes(query.game)) {
      set.status = 400;
      return { success: false, error: `Invalid game: ${query.game}` };
    }

    if (query.status && !VALID_STATES.includes(query.status)) {
      set.status = 400;
      return { success: false, error: `Invalid status: ${query.status}` };
    }

    const servers = await ServerService.getInternalServers(
      query.game as string | undefined,
      query.status as string | undefined,
    );

    return { success: true, data: servers };
  })

  // All routes below this derive require a valid user session.
  .derive(async ({ headers }) => ({
    userId: await AuthService.requireUserId(headers.cookie ?? ""),
  }))
  .get("/", async ({ userId }) => {
    const servers = await ServerService.getAllByUser(userId);
    return { success: true, data: servers };
  })
  .get("/:serverId", async ({ userId, params }) => {
    const server = await ServerService.getById(userId, params.serverId);
    return { success: true, data: server };
  })
  .get("/:serverId/status", async ({ userId, params: { serverId } }) => {
    const result = await ServerService.getStatus(serverId, userId);
    return { success: true, data: result };
  })
  .post(
    "/:serverId/action",
    async ({ userId, params: { serverId }, body }) => {
      const result = await ServerService.performAction(serverId, userId, body);
      return { success: true, data: result };
    },
    { body: "servers.action" },
  )
  .post(
    "/create",
    async ({ userId, body, set }) => {
      const newServerId = await ServerService.create(userId, body);
      set.status = 201;
      return {
        success: true,
        message: "Server provisioned successfully",
        data: { id: newServerId },
      };
    },
    {
      body: "server.create",
    },
  )
  .patch(
    "/:serverId/config",
    async ({ userId, params: { serverId }, body }) => {
      const result = await ServerService.updateServerConfig(serverId, userId, body);
      return { success: true, data: result };
    },
    { body: "server.update" },
  )
  .delete("/:serverId", async ({ userId, params: { serverId }, set }) => {
    const result = await ServerService.delete(userId, serverId);
    set.status = 200;
    return {
      success: true,
      message: "Server deleted successfully",
      data: {
        id: result.deletedServerId,
      },
    };
  });
