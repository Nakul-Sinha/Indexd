import { randomBytes } from "node:crypto";
import type * as k8s from "@kubernetes/client-node";
import { userQuotas } from "@repo/db/schema";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import {
  getKubernetesStatusCode,
  type KubernetesClients,
  makeKubernetesClients,
} from "./kubernetes";

export const SYSTEM_NAMESPACE = process.env.FARLANDS_SYSTEM_NAMESPACE ?? "farlands-system";
export const PROXY_NAMESPACE = process.env.FARLANDS_PROXY_NAMESPACE ?? "infra-team";
export const BACKEND_NAMESPACE = process.env.FARLANDS_BACKEND_NAMESPACE ?? "dev-deployment";
export const RCON_SECRET_NAME = "rcon-password";
export const RCON_SECRET_KEY = "password";
export const RCON_PASSWORD_MOUNT = "/run/secrets/rcon";
export const RCON_PASSWORD_FILE = `${RCON_PASSWORD_MOUNT}/${RCON_SECRET_KEY}`;
export const WORLD_SYNC_PORT = 8080;
export const RCON_PORT = 25575;
export const VELOCITY_SECRET_NAME =
  process.env.FARLANDS_VELOCITY_SECRET_NAME ?? "velocity-forwarding-secret";

export type TenantQuotaMirror = {
  cpuLimit: string;
  ramLimitMb: number;
  storageLimitGb: number;
  serversLimit: number;
};

const DEFAULT_QUOTA: TenantQuotaMirror = {
  cpuLimit: "2",
  ramLimitMb: 2048,
  storageLimitGb: 5,
  serversLimit: 1,
};

export function tenantNamespace(userId: string): string {
  const slug = userId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (!slug) {
    throw new Error("userId cannot be mapped to a Kubernetes namespace");
  }
  return `fl-${slug}`;
}

export async function quotaMirrorForUser(userId: string): Promise<TenantQuotaMirror> {
  const [row] = await db
    .select({
      cpuLimit: userQuotas.cpuLimit,
      ramLimitMb: userQuotas.ramLimitMb,
      storageLimitGb: userQuotas.storageLimitGb,
      serversLimit: userQuotas.serversLimit,
    })
    .from(userQuotas)
    .where(eq(userQuotas.userId, userId))
    .limit(1);

  return row ?? DEFAULT_QUOTA;
}

function alreadyExists(error: unknown): boolean {
  return getKubernetesStatusCode(error) === 409;
}

function notFound(error: unknown): boolean {
  return getKubernetesStatusCode(error) === 404;
}

async function ensureNamespace(
  core: k8s.CoreV1Api,
  namespace: string,
  userId: string,
): Promise<void> {
  try {
    await core.createNamespace({
      body: {
        metadata: {
          name: namespace,
          labels: {
            "farlands.dev/tenant": "true",
            "farlands.dev/user-id": userId.slice(0, 63),
            "pod-security.kubernetes.io/enforce": "baseline",
          },
        },
      },
    });
  } catch (error) {
    if (!alreadyExists(error)) throw error;
  }
}

function buildResourceQuota(namespace: string, quota: TenantQuotaMirror): k8s.V1ResourceQuota {
  // Double CPU/RAM/PVC so a candidate can exist during deploy (headroom).
  const cpu = `${Number.parseFloat(quota.cpuLimit) * 2}`;
  const memoryGi = Math.ceil((quota.ramLimitMb * 2 * 1.5) / 1024);
  const storage = quota.storageLimitGb * 2;
  const pods = Math.max(quota.serversLimit * 6, 8);

  return {
    metadata: { name: "tenant-quota", namespace },
    spec: {
      hard: {
        pods: String(pods),
        "requests.cpu": cpu,
        "limits.cpu": cpu,
        "requests.memory": `${memoryGi}Gi`,
        "limits.memory": `${memoryGi}Gi`,
        "requests.storage": `${storage}Gi`,
        persistentvolumeclaims: String(Math.max(quota.serversLimit * 3, 4)),
      },
    },
  };
}

function buildLimitRange(namespace: string): k8s.V1LimitRange {
  return {
    metadata: { name: "tenant-limits", namespace },
    spec: {
      limits: [
        {
          type: "Container",
          defaultRequest: { cpu: "250m", memory: "256Mi" },
          default: { cpu: "1", memory: "1280Mi" },
          max: { cpu: "2", memory: "4Gi" },
        } as k8s.V1LimitRangeItem,
        {
          type: "PersistentVolumeClaim",
          max: { storage: "20Gi" },
        },
      ],
    },
  };
}

function buildDefaultDeny(namespace: string): k8s.V1NetworkPolicy {
  return {
    metadata: { name: "default-deny-cross-tenant", namespace },
    spec: {
      podSelector: {},
      policyTypes: ["Ingress"],
      ingress: [
        { from: [{ podSelector: {} }] } as k8s.V1NetworkPolicyIngressRule,
        {
          from: [
            {
              namespaceSelector: {
                matchLabels: { "farlands.dev/shared": "true" },
              },
            },
          ],
        } as k8s.V1NetworkPolicyIngressRule,
      ],
    },
  };
}

async function upsertQuota(
  core: k8s.CoreV1Api,
  namespace: string,
  quota: TenantQuotaMirror,
): Promise<void> {
  const body = buildResourceQuota(namespace, quota);
  try {
    await core.createNamespacedResourceQuota({ namespace, body });
  } catch (error) {
    if (!alreadyExists(error)) throw error;
    await core.replaceNamespacedResourceQuota({
      name: "tenant-quota",
      namespace,
      body,
    });
  }
}

async function ensureLimitRange(core: k8s.CoreV1Api, namespace: string): Promise<void> {
  const body = buildLimitRange(namespace);
  try {
    await core.createNamespacedLimitRange({ namespace, body });
  } catch (error) {
    if (!alreadyExists(error) && !notFound(error)) {
      // Some clusters reject LimitRange create as 409; ignore exists.
      if (getKubernetesStatusCode(error) !== 409) throw error;
    }
  }
}

async function ensureDefaultDeny(
  networking: k8s.NetworkingV1Api,
  namespace: string,
): Promise<void> {
  const body = buildDefaultDeny(namespace);
  try {
    await networking.createNamespacedNetworkPolicy({ namespace, body });
  } catch (error) {
    if (!alreadyExists(error)) throw error;
  }
}

async function ensureRconSecret(core: k8s.CoreV1Api, namespace: string): Promise<void> {
  try {
    await core.readNamespacedSecret({ name: RCON_SECRET_NAME, namespace });
    return;
  } catch (error) {
    if (!notFound(error)) throw error;
  }

  const password = randomBytes(24).toString("base64url");
  await core.createNamespacedSecret({
    namespace,
    body: {
      metadata: {
        name: RCON_SECRET_NAME,
        namespace,
        labels: { "farlands.dev/kind": "rcon" },
      },
      type: "Opaque",
      stringData: { [RCON_SECRET_KEY]: password },
    },
  });
}

async function copyVelocitySecret(core: k8s.CoreV1Api, namespace: string): Promise<void> {
  try {
    await core.readNamespacedSecret({
      name: VELOCITY_SECRET_NAME,
      namespace,
    });
    return;
  } catch (error) {
    if (!notFound(error)) throw error;
  }

  const source = await core.readNamespacedSecret({
    name: VELOCITY_SECRET_NAME,
    namespace: PROXY_NAMESPACE,
  });

  await core.createNamespacedSecret({
    namespace,
    body: {
      metadata: {
        name: VELOCITY_SECRET_NAME,
        namespace,
        labels: { "farlands.dev/kind": "velocity-forwarding" },
      },
      type: "Opaque",
      data: source.data,
    },
  });
}

async function ensureWorldSyncConfigMap(core: k8s.CoreV1Api, namespace: string): Promise<void> {
  const sender = `#!/usr/bin/env python3
import http.server, os, subprocess, sys
PORT = int(os.environ.get("WORLD_SYNC_PORT", "8080"))
ROOT = os.environ.get("WORLD_ROOT", "/data/world")

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\\n" % (self.address_string(), fmt % args))
    def do_GET(self):
        if self.path.startswith("/health"):
            self.send_response(200); self.end_headers(); self.wfile.write(b"ok"); return
        self.send_response(404); self.end_headers()
    def do_POST(self):
        if not self.path.startswith("/stream"):
            self.send_response(404); self.end_headers(); return
        if not os.path.isdir(ROOT):
            self.send_response(204); self.end_headers(); return
        extra = []
        if "delta=1" in self.path:
            extra = ["--newer-mtime", os.environ.get("DELTA_SINCE", "1970-01-01")]
        proc = subprocess.Popen(["tar", "-C", ROOT, "-cf", "-", *extra, "."], stdout=subprocess.PIPE)
        self.send_response(200)
        self.send_header("Content-Type", "application/x-tar")
        self.end_headers()
        assert proc.stdout is not None
        while True:
            chunk = proc.stdout.read(1024 * 256)
            if not chunk: break
            self.wfile.write(chunk)
        proc.wait()
        if proc.returncode != 0:
            sys.stderr.write("tar failed %s\\n" % proc.returncode)

http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
`;

  const receiver = `#!/usr/bin/env python3
import os, socket, subprocess, sys
PORT = int(os.environ.get("WORLD_SYNC_PORT", "8080"))
ROOT = os.environ.get("WORLD_ROOT", "/data/world")
os.makedirs(ROOT, exist_ok=True)
srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("0.0.0.0", PORT)); srv.listen(1)
print("receiver listening on %s" % PORT, flush=True)
conn, _ = srv.accept()
os.makedirs(ROOT, exist_ok=True)
proc = subprocess.Popen(["tar", "-C", ROOT, "-xf", "-"], stdin=conn)
proc.wait()
conn.close(); srv.close()
sys.exit(proc.returncode)
`;

  const body: k8s.V1ConfigMap = {
    metadata: { name: "cm-world-sync", namespace },
    data: {
      "sender.py": sender,
      "receiver.py": receiver,
    },
  };

  try {
    await core.createNamespacedConfigMap({ namespace, body });
  } catch (error) {
    if (!alreadyExists(error)) throw error;
    await core.replaceNamespacedConfigMap({
      name: "cm-world-sync",
      namespace,
      body,
    });
  }
}

export async function ensureTenantNamespace(
  userId: string,
  clients: KubernetesClients = makeKubernetesClients(),
): Promise<string> {
  const namespace = tenantNamespace(userId);
  const quota = await quotaMirrorForUser(userId);

  await ensureNamespace(clients.core, namespace, userId);
  await upsertQuota(clients.core, namespace, quota);
  await ensureLimitRange(clients.core, namespace);
  await ensureDefaultDeny(clients.networking, namespace);
  await ensureRconSecret(clients.core, namespace);
  await copyVelocitySecret(clients.core, namespace);
  await ensureWorldSyncConfigMap(clients.core, namespace);

  return namespace;
}
