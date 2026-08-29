import { expect, test } from "bun:test";

import { getMinecraftRouteHostname } from "../src/modules/servers/routing";

test("builds a stable server-id hostname from the configured route domain", () => {
  expect(
    getMinecraftRouteHostname("60af9e5c-d6fd-4e7e-9516-b86dbd4cb8a8", " MC.Farlands.Cloud. "),
  ).toBe("60af9e5c-d6fd-4e7e-9516-b86dbd4cb8a8.mc.farlands.cloud");
});

test("fails closed when the route domain is missing or invalid", () => {
  for (const routeDomain of [undefined, "https://mc.farlands.cloud"]) {
    let thrown: unknown;

    try {
      getMinecraftRouteHostname("server-id", routeDomain);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: 503,
      response: "Minecraft routing is not configured.",
    });
  }
});
