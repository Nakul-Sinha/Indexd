import type { NextRequest } from "next/server";

import { getSession } from "@/lib/auth";
import { upstreamSessionCookie } from "@/lib/auth-cookie";
import { ConnectorBodyTooLargeError, readConnectorBody } from "@/lib/connector-body";
import { connectorOriginAllowed, connectorPathAllowed } from "@/lib/connector-policy";

export const runtime = "nodejs";
export const maxDuration = 300;

const FORWARDED_REQUEST_HEADERS = ["accept", "content-type", "if-match", "x-request-id"];
const FORWARDED_RESPONSE_HEADERS = [
  "content-disposition",
  "content-type",
  "etag",
  "location",
  "x-request-id",
];

function liveApiBase(): string | null {
  const configured = process.env.LIVE_API_URL?.trim().replace(/\/$/, "");
  if (configured) return configured;
  return process.env.NODE_ENV === "production" ? null : "http://127.0.0.1:3001";
}

function requestOriginAllowed(request: NextRequest): boolean {
  return connectorOriginAllowed({
    method: request.method,
    origin: request.headers.get("origin"),
    requestOrigin: request.nextUrl.origin,
    configuredOrigin: process.env.CONTROL_PLANE_WEB_ORIGIN?.trim(),
    production: process.env.NODE_ENV === "production",
  });
}

async function proxy(request: NextRequest, path: string[]): Promise<Response> {
  const authResult = await getSession(request.headers);
  if (authResult.response) return authResult.response;
  const session = authResult.session;
  if (!session) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  const pathname = `/${path.map(encodeURIComponent).join("/")}`;
  if (!connectorPathAllowed(pathname)) {
    return Response.json({ error: "Connector path is not allowed" }, { status: 404 });
  }
  if (!requestOriginAllowed(request)) {
    return Response.json({ error: "Untrusted request origin" }, { status: 403 });
  }

  const base = liveApiBase();
  if (!base) {
    return Response.json(
      { error: "The live control-plane connector is not configured." },
      { status: 503 },
    );
  }

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("cookie", upstreamSessionCookie(session.session.token));

  const method = request.method.toUpperCase();
  let body: ArrayBuffer | undefined;
  try {
    body = await readConnectorBody(request);
  } catch (error) {
    if (error instanceof ConnectorBodyTooLargeError) {
      return Response.json({ error: "Connector request body is too large" }, { status: 413 });
    }
    throw error;
  }

  try {
    const upstream = await fetch(`${base}${pathname}${request.nextUrl.search}`, {
      method,
      headers,
      body,
      redirect: "manual",
      cache: "no-store",
      signal: request.signal,
    });

    const responseHeaders = new Headers();
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    responseHeaders.set("cache-control", "private, no-store");

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error("Control-plane connector request failed", {
      path: pathname,
      message: error instanceof Error ? error.message : "Unknown connector error",
    });
    return Response.json(
      { error: "The live control plane is currently unreachable." },
      { status: 502 },
    );
  }
}

type RouteContext = { params: Promise<{ path: string[] }> };

export async function GET(request: NextRequest, context: RouteContext) {
  return proxy(request, (await context.params).path);
}

export async function POST(request: NextRequest, context: RouteContext) {
  return proxy(request, (await context.params).path);
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  return proxy(request, (await context.params).path);
}

export async function PUT(request: NextRequest, context: RouteContext) {
  return proxy(request, (await context.params).path);
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  return proxy(request, (await context.params).path);
}
