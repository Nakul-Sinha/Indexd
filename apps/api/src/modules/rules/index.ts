import { Elysia } from "elysia";

import { AuthService } from "../auth/service";
import { RulesModel } from "./model";
import { RulesService } from "./service";

export const rulesModule = new Elysia({ prefix: "/api/rules" })
  .use(RulesModel)

  .get("/", async ({ headers }) => {
    const userId = await AuthService.requireUserId(headers.cookie ?? "");
    const rules = await RulesService.getAllByUser(userId);
    return { success: true, data: rules };
  })

  .post(
    "/",
    async ({ headers, body, set }) => {
      const userId = await AuthService.requireUserId(headers.cookie ?? "");
      const rule = await RulesService.create(userId, body);
      set.status = 201;
      return { success: true, data: rule };
    },
    {
      body: "rules.create",
    },
  )

  .patch(
    "/:id",
    async ({ headers, params: { id }, body }) => {
      const userId = await AuthService.requireUserId(headers.cookie ?? "");
      const rule = await RulesService.update(id, userId, body);
      return { success: true, data: rule };
    },
    {
      body: "rules.update",
    },
  )

  .delete("/:id", async ({ headers, params: { id } }) => {
    const userId = await AuthService.requireUserId(headers.cookie ?? "");
    const rule = await RulesService.delete(id, userId);
    return { success: true, data: rule };
  });
