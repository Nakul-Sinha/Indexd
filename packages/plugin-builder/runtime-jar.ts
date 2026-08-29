import { get, list } from "@vercel/blob";

const DEFAULT_RUNTIME_JAR_BLOB_PATHNAME = "plugin-builder/runtime/farlands-plugin-1.0.0.jar";

function requiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

let cachedRuntimeJar: Buffer | null = null;

export async function getRuntimeJar(): Promise<Buffer> {
  if (cachedRuntimeJar) {
    // Return a copy to prevent in-place modifications from mutating cached buffer
    return Buffer.from(cachedRuntimeJar);
  }

  const token = requiredEnv("BLOB_READ_WRITE_TOKEN");

  const runtimeJarPathname =
    process.env.RUNTIME_JAR_BLOB_PATHNAME ?? DEFAULT_RUNTIME_JAR_BLOB_PATHNAME;

  let url = runtimeJarPathname;

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    const response = await list({
      token,
      prefix: runtimeJarPathname,
    });

    const foundBlob = response.blobs.find((b) => b.pathname === runtimeJarPathname);

    if (!foundBlob) {
      throw new Error(`Runtime jar blob not found for pathname: ${runtimeJarPathname}`);
    }

    url = foundBlob.url;
  }

  const result = await get(url, {
    access: "private",
    token,
    useCache: false,
  });

  if (!result?.stream) {
    throw new Error(`Runtime jar blob not found at URL: ${url}`);
  }

  const bytes = await new Response(result.stream).arrayBuffer();

  if (bytes.byteLength === 0) {
    throw new Error(`Runtime jar blob was empty at URL: ${url}`);
  }

  cachedRuntimeJar = Buffer.from(bytes);
  return Buffer.from(cachedRuntimeJar);
}
