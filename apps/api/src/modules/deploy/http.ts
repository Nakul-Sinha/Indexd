import { Elysia, t } from "elysia";
import {
  abortDeployment,
  enqueueDeploy,
  getDeployment,
  reconcileInFlight,
  restoreServer,
  rollbackServer,
} from "./controller";

export const deployModule = new Elysia()
  .onStart(async () => {
    await reconcileInFlight();
  })
  .post(
    "/v1/servers/:id/deploy",
    async ({ params, body, set }) => {
      try {
        return await enqueueDeploy({
          serverId: params.id,
          ruleSetVersion: body.ruleSetVersion,
          approvalToken: body.approvalToken,
          initiatedBy: "api",
        });
      } catch (error) {
        set.status = 400;
        return {
          error: error instanceof Error ? error.message : "deploy refused",
        };
      }
    },
    {
      body: t.Object({
        ruleSetVersion: t.String(),
        approvalToken: t.String(),
      }),
    },
  )
  .get("/v1/deployments/:id", ({ params, set }) => {
    const row = getDeployment(params.id);
    if (!row) {
      set.status = 404;
      return { error: "Deployment not found" };
    }
    return row;
  })
  .post("/v1/deployments/:id/abort", async ({ params, set }) => {
    try {
      return await abortDeployment(params.id);
    } catch (error) {
      set.status = 400;
      return {
        error: error instanceof Error ? error.message : "abort refused",
      };
    }
  })
  .post("/v1/servers/:id/rollback", async ({ params, set }) => {
    try {
      return await rollbackServer(params.id);
    } catch (error) {
      set.status = 400;
      return {
        error: error instanceof Error ? error.message : "rollback refused",
      };
    }
  })
  .post(
    "/v1/servers/:id/restore",
    async ({ params, body, set }) => {
      try {
        return await restoreServer(params.id, body.confirmDataLoss);
      } catch (error) {
        set.status = 400;
        return {
          error: error instanceof Error ? error.message : "restore refused",
        };
      }
    },
    {
      body: t.Object({
        confirmDataLoss: t.String(),
      }),
    },
  );
