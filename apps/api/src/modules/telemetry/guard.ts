import type { NotFoundRefusal } from "@farlands/contracts";

/**
 * The half of "cluster-internal only" that code can enforce.
 *
 * The real boundary is a NetworkPolicy that permits traffic to this pod on this
 * path only from the in-cluster plugin, and it is Engineer 2's to write. This
 * module cannot see the network, so claiming to enforce network policy from
 * here would be a lie in a comment. What it can do is refuse a request that
 * carries the fingerprints of having crossed an edge proxy, which is what an
 * accidental public route or a misconfigured ingress leaves behind.
 *
 * Treat this as a second lock, not the lock. It catches the misconfiguration
 * that is actually likely (someone proxies /internal/* while adding an unrelated
 * route) and it does not stop an attacker already inside the cluster, which is
 * exactly what the NetworkPolicy is for.
 */

/**
 * Headers a request only carries once something outside the cluster has
 * forwarded it. Every one of these is written by a proxy, load balancer or CDN
 * that sits at or beyond the edge; the in-cluster plugin posting directly to the
 * backend Service sends none of them.
 */
export const EXTERNAL_ROUTING_HEADERS = [
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "forwarded",
  "x-real-ip",
  "x-cluster-client-ip",
  "x-envoy-external-address",
  "cf-connecting-ip",
  "true-client-ip",
] as const;

/**
 * The header that gave the request away, or null when it looks in-cluster.
 *
 * Returns the name rather than a boolean so the refusal and the log line can
 * say which header was seen, which is the difference between a five second fix
 * and an afternoon.
 */
export function externalRoutingHeader(
  headers: Readonly<Record<string, string | undefined>>,
): string | null {
  for (const name of EXTERNAL_ROUTING_HEADERS) {
    const value = headers[name];
    if (value !== undefined && value !== "") return name;
  }
  return null;
}

/**
 * The refusal, as a not_found rather than a forbidden.
 *
 * A 403 confirms that `/internal/telemetry/:serverId` exists to anything that
 * reaches it from outside, and the first thing a scanner does with a confirmed
 * internal endpoint is come back for the rest of `/internal/*`. The contract
 * already carries a not_found refusal for exactly this reasoning (refusing
 * rather than returning empty, so existence does not leak), so this reuses it
 * instead of inventing a fourth refusal shape. The message and resolution still
 * name the real cause, so an operator who has misconfigured an ingress reads
 * the body and understands immediately.
 */
export function internalOnlyRefusal(header: string): NotFoundRefusal {
  return {
    error: "not_found",
    tool: "telemetry_ingest",
    resource: "telemetry ingest",
    message: `This endpoint is cluster-internal. The request carried ${header}, so it was routed from outside the cluster and was not served.`,
    resolution:
      "Post telemetry from inside the cluster, directly to the backend Service. If this is in-cluster traffic, remove the proxy that is adding forwarding headers; no public route may proxy to /internal/*.",
  };
}
