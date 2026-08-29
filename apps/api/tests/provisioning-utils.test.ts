import { expect, test } from "bun:test";

import { MinecraftUtils } from "../src/modules/provisioning/utils";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

test("resolves latest to the release version before reading its Java requirement", async () => {
  const requestedUrls: string[] = [];
  const fetchImpl = async (input: string | URL | Request) => {
    const url = input.toString();
    requestedUrls.push(url);

    if (url.endsWith("version_manifest_v2.json")) {
      return jsonResponse({
        latest: { release: "26.1.2" },
        versions: [{ id: "26.1.2", url: "https://example.test/versions/26.1.2" }],
      });
    }

    return jsonResponse({ javaVersion: { majorVersion: 25 } });
  };

  await expect(MinecraftUtils.fetchMojangJavaRequirement("latest", 5000, fetchImpl)).resolves.toBe(
    25,
  );
  expect(requestedUrls).toEqual([
    "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
    "https://example.test/versions/26.1.2",
  ]);
});

test("uses Java 25 when latest-version metadata is unavailable", async () => {
  const unavailableFetch = async () => new Response(null, { status: 503 });

  await expect(MinecraftUtils.getRuntimeImage("latest", unavailableFetch)).resolves.toBe(
    "itzg/minecraft-server:java25",
  );
});

test("uses Java 25 for calendar-version fallback", () => {
  expect(MinecraftUtils.getFallbackJavaVersion("26.1.2")).toBe(25);
});
