import { describe, expect, test } from "bun:test";

import { createServerDto } from "../src/modules/servers/model";

const validServer = {
  name: "test-server",
  game: "minecraft" as const,
  type: "paper" as const,
  version: "1.21.4",
  cpuCores: 1,
  ramMb: 2048,
  storageGb: 4,
  gameConfigJson: {
    maxPlayers: 20,
    difficulty: "normal" as const,
    pvp: true,
  },
};

describe("createServerDto Minecraft version", () => {
  test.each(["1.20", "1.21.4", "26.1.2"])("accepts explicit release %s", (version) => {
    expect(createServerDto.safeParse({ ...validServer, version }).success).toBe(true);
  });

  test.each(["latest", "", "1.21.4; rm -rf /", "itzg/minecraft-server:latest"])(
    "rejects non-release value %s",
    (version) => {
      expect(createServerDto.safeParse({ ...validServer, version }).success).toBe(false);
    },
  );

  test("requires a version instead of silently defaulting", () => {
    const { version: _version, ...withoutVersion } = validServer;

    expect(createServerDto.safeParse(withoutVersion).success).toBe(false);
  });
});
