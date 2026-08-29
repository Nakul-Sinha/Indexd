import { Elysia } from "elysia";

import { AuthService } from "../auth/service";
import { ServersModel } from "../servers/model";
import { ServerService } from "../servers/service";
import { AdminNodesService } from "./nodes";

export const adminModule = new Elysia({ prefix: "/api/admin" })
  .use(ServersModel)
  .derive(async ({ headers }) => ({
    adminUserId: await AuthService.requireAdminUserId(headers.cookie ?? ""),
  }))
  .get("/authorization-check", ({ adminUserId: _adminUserId }) => ({
    success: true as const,
  }))
  .get("/nodes", async () => ({
    success: true as const,
    data: await AdminNodesService.list(),
  }))
  .get("/nodes/:nodeName", async ({ params }) => ({
    success: true as const,
    data: await AdminNodesService.get(params.nodeName),
  }))
  .get("/servers", async () => ({
    success: true as const,
    data: await AdminNodesService.listGameServers(),
  }))
  .post(
    "/servers/:serverId/action",
    async ({ params, body }) => {
      const ownerId = await ServerService.getOwnerId(params.serverId);
      return {
        success: true as const,
        data: await ServerService.performAction(params.serverId, ownerId, body),
      };
    },
    { body: "servers.action" },
  )
  .delete("/servers/:serverId", async ({ params }) => {
    const ownerId = await ServerService.getOwnerId(params.serverId);
    const result = await ServerService.delete(ownerId, params.serverId);
    return {
      success: true as const,
      message: "Server deleted successfully",
      data: { id: result.deletedServerId },
    };
  });
