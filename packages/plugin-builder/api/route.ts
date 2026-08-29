import crypto from "crypto";
import { auth } from "@/lib/auth";
import { buildPluginJar } from "@/lib/plugin-builder/jar-builder";
import { uploadPluginJson } from "@/lib/plugin-builder/s3-storage";
import {
  MAX_PLUGIN_BUILDER_BODY_BYTES,
  validatePluginBuilderBody,
} from "@/lib/plugin-builder/validation";
import { generateYaml } from "@/lib/plugin-builder/yaml-generator";

export const runtime = "nodejs";

function createPluginJsonKey(pluginName: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

  return `${pluginName}-${timestamp}-${crypto.randomUUID()}.json`;
}

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get("content-type") ?? "";

    if (!contentType.includes("application/json")) {
      return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
    }

    const contentLength = Number(request.headers.get("content-length") ?? 0);

    if (contentLength > MAX_PLUGIN_BUILDER_BODY_BYTES) {
      return Response.json({ error: "Request body is too large" }, { status: 413 });
    }

    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }

    const requestText = await request.text();

    if (Buffer.byteLength(requestText, "utf8") > MAX_PLUGIN_BUILDER_BODY_BYTES) {
      return Response.json({ error: "Request body is too large" }, { status: 413 });
    }

    let parsedBody: unknown;

    try {
      parsedBody = JSON.parse(requestText);
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const validation = validatePluginBuilderBody(parsedBody);

    if (!validation.ok) {
      return Response.json({ error: validation.error }, { status: 400 });
    }

    const body = validation.value;
    const pluginName = validation.pluginName;
    const yamlContent = generateYaml(body);

    const jarBuffer = await buildPluginJar(pluginName, yamlContent);

    try {
      await uploadPluginJson(createPluginJsonKey(pluginName), {
        pluginName,
        createdAt: new Date().toISOString(),
        config: body,
      });
    } catch (s3Error) {
      console.warn("Failed to upload plugin metadata to S3 (non-critical):", s3Error);
    }

    return new Response(new Uint8Array(jarBuffer), {
      headers: {
        "Content-Type": "application/java-archive",

        "Content-Disposition": `attachment; filename="${pluginName}.jar"`,

        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("Plugin generation failed", error);

    return Response.json(
      {
        success: false,
        error: "Plugin generation failed",
      },
      { status: 500 },
    );
  }
}
