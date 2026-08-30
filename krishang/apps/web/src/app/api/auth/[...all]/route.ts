import { toNextJsHandler } from "better-auth/next-js";

import { authenticationUnavailable, getAuth } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(request: Request): Promise<Response> {
  try {
    const handler = toNextJsHandler(getAuth());
    return await (request.method === "GET" ? handler.GET(request) : handler.POST(request));
  } catch (error) {
    return authenticationUnavailable(error);
  }
}

export const GET = handle;
export const POST = handle;
