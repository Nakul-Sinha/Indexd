import { Elysia } from "elysia";
import { AuthService } from "../auth/service";
import { QuotaService } from "./quota.service";

export const quotaModule = new Elysia({ prefix: "/api/quota" })
  .derive(async ({ headers }) => ({
    userId: await AuthService.requireUserId(headers.cookie ?? ""),
  }))
  .get("/", async ({ userId, set }) => {
    const usage = await QuotaService.getResourceUsage(userId);
    if (!usage) {
      set.status = 404;
      return { success: false, error: "Quota not found" };
    }
    return { success: true, data: usage };
  });
