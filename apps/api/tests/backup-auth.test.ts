import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { app } from "../src/app";

describe("backup route authentication", () => {
  let previousMockUserId: string | undefined;

  beforeAll(() => {
    previousMockUserId = process.env.MOCK_USER_ID;
    process.env.MOCK_USER_ID = "must-not-authorize-backup-routes";
  });

  afterAll(() => {
    if (previousMockUserId === undefined) {
      delete process.env.MOCK_USER_ID;
    } else {
      process.env.MOCK_USER_ID = previousMockUserId;
    }
  });

  test("rejects a create request without a session cookie", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/servers/server-id/backups/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Unauthorized backup" }),
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Authentication required");
  });
});
