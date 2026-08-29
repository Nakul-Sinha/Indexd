import { Elysia, t } from "elysia";
import { ackTransfer, listPendingTransfers } from "./transfers";

export const velocityModule = new Elysia({ prefix: "/internal/velocity" })
  .get("/transfers", () => listPendingTransfers())
  .post("/transfers/:id/ack", ({ params, body }) => ackTransfer(params.id, body), {
    body: t.Object({
      movedPlayers: t.Array(t.String()),
      failures: t.Array(
        t.Object({
          player: t.String(),
          reason: t.String(),
        }),
      ),
    }),
  });
