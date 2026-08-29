import "./load-env";
import { serverK8s } from "@repo/db/schema";
import { eq, sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { db } from "./db";
import { adminModule } from "./modules/admin";
import { AuthService } from "./modules/auth/service";
import { BackupModule } from "./modules/backup";
import { deployModule } from "./modules/deploy/http";
import { quotaModule } from "./modules/quota";
import { rulesModule } from "./modules/rules";
import { serversModule } from "./modules/servers";
import {
  createLogKubernetesClients,
  LogPodResolutionError,
  resolveServerLogPod,
  startPodLogPolling,
} from "./modules/servers/logs";
import { ServerService } from "./modules/servers/service";
import { InMemoryRollupStore, telemetryPlugin } from "./modules/telemetry/index.ts";
import { velocityModule } from "./modules/velocity/http";

export const app = new Elysia()
  .get("/", () => "Hello Elysia")

  // GET /health — basic DB connectivity check
  .get("/health", async () => {
    const result = await db.execute<{ db: string; now: string }>(
      sql`SELECT NOW() as now, current_database() as db`,
    );
    const row = result.rows[0];
    return { status: "ok", db: row?.db, now: row?.now };
  })

  .use(rulesModule)
  .use(serversModule)
  .use(quotaModule)
  .use(adminModule)
  .use(deployModule)
  .use(velocityModule)
  .use(telemetryPlugin({ store: new InMemoryRollupStore() }))
  .group("/api/servers/:serverId", (app) => app.use(BackupModule))
  .ws("/api/servers/:serverId/logs", {
    async open(ws: any) {
      const serverId: string | undefined = ws.data.params?.serverId;

      // SECURITY: Read the session credential from the Cookie header on the WebSocket
      // upgrade request rather than from a URL query parameter. Tokens in the URL are
      // recorded verbatim in browser history, proxy access logs, and server access logs,
      // which makes them trivially extractable by anyone with access to those logs.
      const cookieHeader: string = ws.data.headers?.cookie ?? "";
      if (!serverId) {
        (ws as any).close(4000, "Bad Request");
        return;
      }

      // EDGE CASE: Guard against a client disconnecting while open() is still awaiting
      // async work (DB queries, K8s pod lookup, log.log() startup). Without this flag,
      // the close() handler runs before ws.data.k8sReq is assigned, so it cannot abort
      // the in-flight K8s watch. Subsequent awaits check the flag and bail early,
      // aborting the watch immediately if it was already started on a dead socket.
      ws.data.closed = false;

      try {
        // WebSocket upgrades carry the same Better Auth cookie as HTTP server routes.
        const sessionRecord = await AuthService.getValidSession(cookieHeader);

        // EDGE CASE: Client may have disconnected while the DB query was in flight.
        if (ws.data.closed) return;

        if (!sessionRecord || sessionRecord.expiresAt < new Date()) {
          ws.send("Unauthorized: Invalid or expired session");
          (ws as any).close(4001, "Unauthorized");
          return;
        }

        const userId = sessionRecord.userId;

        // SECURITY: Enforce a hard connection deadline at session expiry so that a
        // revoked or expired credential cannot continue receiving log output indefinitely.
        // A single setTimeout is insufficient because JS engines store the delay as a
        // signed 32-bit integer: any value above 2_147_483_647 ms (~24.8 days) silently
        // overflows and fires almost immediately. Better Auth's default session lifetime
        // is 30 days, which exceeds this threshold. scheduleExpiry self-reschedules in
        // safe-sized slices and only tears down the stream once Date.now() has actually
        // passed sessionRecord.expiresAt, preventing premature disconnections.
        const MAX_TIMEOUT_MS = 2_147_483_647; // maximum safe 32-bit signed integer delay
        const expiresAt = sessionRecord.expiresAt;
        const scheduleExpiry = () => {
          const remaining = expiresAt.getTime() - Date.now();
          if (remaining <= 0) {
            try {
              ws.data.k8sReq?.abort();
              ws.send("Session expired. Connection closed.");
              (ws as any).close(4001, "Session Expired");
            } catch {
              // EDGE CASE: Socket may have already been closed by the client between
              // the timer firing and this callback executing; suppress the resulting error.
            }
            return;
          }
          ws.data.expiryTimer = setTimeout(scheduleExpiry, Math.min(remaining, MAX_TIMEOUT_MS));
        };
        scheduleExpiry();

        const isAuthorized = await ServerService.hasOwnership(userId, serverId);

        // EDGE CASE: Client may have disconnected while the authorization query was in flight.
        if (ws.data.closed) return;

        if (!isAuthorized) {
          ws.send("Forbidden: You do not have access to this server");
          (ws as any).close(4003, "Forbidden");
          return;
        }

        // Resolve the Kubernetes pod coordinates mapped to this game server.
        const k8sRecord = await db.query.serverK8s.findFirst({
          where: eq(serverK8s.serverId, serverId),
        });

        // EDGE CASE: Client may have disconnected while the K8s record query was in flight.
        if (ws.data.closed) return;

        if (!k8sRecord) {
          ws.send("Error: Kubernetes metadata not found for this server");
          (ws as any).close(4004, "K8s Resource Not Found");
          return;
        }

        // Initialize the Kubernetes client from the same Farlands kubeconfig path
        // used by provisioning.
        const { core: k8sApi, apps: appsApi } = createLogKubernetesClients();

        // Resolve the container name dynamically so we remain container-agnostic.
        const namespace = k8sRecord.namespace;
        let podName = "";
        let containerName = "";
        try {
          const resolvedPod = await resolveServerLogPod(k8sApi, appsApi, serverId, k8sRecord);
          podName = resolvedPod.podName;
          containerName = resolvedPod.containerName;
        } catch (err) {
          if (err instanceof LogPodResolutionError) {
            const messageByCode: Record<string, string> = {
              "missing-metadata": "Error: Kubernetes metadata not found for this server",
              "pod-not-ready": "Error: Server pod is not ready yet. Please try again shortly.",
              "deployment-missing":
                "Error: Kubernetes deployment is missing for this server. Provisioning may have failed.",
              "container-missing": "Error: No containers found in the server pod",
            };

            ws.send(messageByCode[err.code] ?? "Error: Server logs unavailable");
            (ws as any).close(4004, err.code);
            return;
          }

          // SECURITY: Log the full Kubernetes error server-side using serverId as a
          // correlation key, but send only a generic message to the client. Raw K8s
          // errors can expose cluster hostnames, namespace paths, RBAC denial reasons,
          // and service-account metadata — information that is useful to an attacker
          // mapping the cluster but irrelevant to the end user.
          console.error(`[${serverId}] Failed to fetch pod status:`, err);
          ws.send("Error: Failed to reach server resources. Please try again later.");
          (ws as any).close(4004, "Pod Not Found");
          return;
        }

        // EDGE CASE: Client may have disconnected while the pod metadata request was in flight.
        if (ws.data.closed) return;

        const req = await startPodLogPolling(
          k8sApi,
          {
            namespace,
            podName,
            containerName,
            tailLines: 100,
          },
          (chunk) => {
            try {
              ws.send(chunk);
            } catch (sendError) {
              console.error(`[${serverId}] Error sending log chunk:`, sendError);
            }
          },
        ).catch((streamError) => {
          console.error(`[${serverId}] Failed to start log polling:`, {
            message: streamError instanceof Error ? streamError.message : String(streamError),
            statusCode:
              typeof streamError === "object" && streamError !== null
                ? ((streamError as { code?: number; statusCode?: number }).code ??
                  (streamError as { code?: number; statusCode?: number }).statusCode)
                : undefined,
          });
          try {
            ws.send("[System Error] Failed to start log stream. Please try again later.");
            (ws as any).close(4500, "Internal Server Error");
          } catch {
            // Socket may already be closed.
          }
          return null;
        });

        if (!req) return;

        // EDGE CASE: The client may have disconnected during the async log polling startup.
        // At this point the polling timer may be active but ws.data.k8sReq has not yet
        // been assigned, so the close() handler could not have stopped it.
        if (ws.data.closed) {
          req.abort();
          return;
        }

        ws.data.k8sReq = req;
      } catch (err: any) {
        // SECURITY: Log the full exception server-side but return only a generic message
        // to the client. Unhandled errors from the Kubernetes client can contain cluster
        // hostnames, internal service URLs, TLS handshake details, and stack traces that
        // reveal backend topology and should never be forwarded to an end user.
        console.error(`[${serverId}] WebSocket log streaming error during open:`, err);
        try {
          ws.send("[System Error] Failed to start log stream. Please try again later.");
          (ws as any).close(4500, "Internal Server Error");
        } catch {
          // Socket may already be closed.
        }
      }
    },

    message(_ws: any, _msg: any) {
      // This endpoint is send-only; no inbound message handling is required.
    },

    close(ws: any) {
      // EDGE CASE: Signal open() to abandon any still-pending async steps. Without this
      // flag, awaited DB or K8s calls that complete after close() has run will continue
      // executing and may store a live K8s watch handle on an already-dead socket.
      ws.data.closed = true;

      // MEMORY: Cancel the session-expiry timer on client-initiated disconnect.
      // The timer holds a closure over the ws object and reschedules itself; without
      // explicit cancellation it would continue firing in MAX_TIMEOUT_MS-sized
      // intervals, accumulating orphaned callbacks and leaking the ws reference.
      if (ws.data.expiryTimer) {
        clearTimeout(ws.data.expiryTimer);
      }

      // Abort the K8s HTTP watch to free the upstream connection immediately.
      const req = ws.data.k8sReq;
      if (req) {
        try {
          req.abort();
          console.log(
            `Successfully stopped K8s log polling for server ${ws.data.params?.serverId}`,
          );
        } catch (err) {
          console.error("Error stopping K8s log polling:", err);
        }
      }
    },
  });

export type App = typeof app;
