type MinecraftVersionManifest = {
  latest?: { release?: string };
  versions?: Array<{ id: string; url: string }>;
};

type MinecraftVersionDetails = {
  javaVersion?: { majorVersion?: number };
};

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const SUPPORTED_JAVA_VERSIONS = [8, 11, 16, 17, 19, 21, 25] as const;

export const MinecraftUtils = {
  // Dynamically fetches the required java version directly from mojang launcher API.
  async fetchMojangJavaRequirement(
    version: string,
    timeoutMs = 5000,
    fetchImpl: FetchLike = fetch,
  ): Promise<number | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const manifestReq = await fetchImpl(
        "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
        { signal: controller.signal },
      );
      if (!manifestReq.ok) return null;

      const manifest = (await manifestReq.json()) as MinecraftVersionManifest;
      const requestedVersion = version.trim();
      const resolvedVersion =
        requestedVersion.toLowerCase() === "latest" ? manifest.latest?.release : requestedVersion;
      const versionMeta = manifest.versions?.find((candidate) => candidate.id === resolvedVersion);
      if (!versionMeta) return null;

      const detailsReq = await fetchImpl(versionMeta.url, {
        signal: controller.signal,
      });
      if (!detailsReq.ok) return null;

      const details = (await detailsReq.json()) as MinecraftVersionDetails;
      const majorVersion = details.javaVersion?.majorVersion;
      return typeof majorVersion === "number" ? majorVersion : null;
    } catch (error: any) {
      if (error.name === "AbortError") {
        console.warn(`[Mojang API] Request timed out after ${timeoutMs}ms for version ${version}.`);
      } else {
        console.warn(
          `[Mojang API] Failed to fetch Java requirement for ${version}, using fallback.`,
          error,
        );
      }
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  },

  // Fallback calculating the Java version based on wiki data.
  getFallbackJavaVersion(version: string): number {
    const normalizedVersion = version.trim().toLowerCase();
    if (normalizedVersion === "latest") return 25;

    const parts = normalizedVersion.split(".");
    const major = parseInt(parts[0] || "0", 10);
    const minor = parseInt(parts[1] || "0", 10);
    const patch = parseInt(parts[2] || "0", 10);

    // Minecraft's 2026+ calendar versions require the modern Java runtime.
    if (major >= 26) return 25;
    if (major !== 1) return 25;

    if (minor <= 5) return 5;
    if (minor >= 6 && minor <= 11) return 6;
    if (minor >= 12 && minor <= 16) return 8;
    if (minor === 17) return 16;
    if (minor >= 18 && minor <= 20) {
      if (minor === 20 && patch >= 5) return 21;
      return 17;
    }
    return 21;
  },

  async getRuntimeImage(version: string, fetchImpl: FetchLike = fetch): Promise<string> {
    const requiredJava =
      (await this.fetchMojangJavaRequirement(version, 5000, fetchImpl)) ??
      this.getFallbackJavaVersion(version);

    const targetJava =
      SUPPORTED_JAVA_VERSIONS.find((java) => java >= requiredJava) ??
      SUPPORTED_JAVA_VERSIONS[SUPPORTED_JAVA_VERSIONS.length - 1];

    return `itzg/minecraft-server:java${targetJava}`;
  },
};

export function calculateContainerMemory(heapMb: number): number {
  // Headroom for java virtual machine to prevent oom kills
  // 1. Flat 512MB for Java Metaspace, CodeCache, and basic thread stacks.
  // 2. 10% of heap for G1GC structures and DirectByteBuffers.
  // 3. Cap the maximum overhead at 2048MB so large servers don't waste node RAM.
  const overheadMb = Math.min(2048, 512 + Math.floor(heapMb * 0.1));

  return heapMb + overheadMb;
}
