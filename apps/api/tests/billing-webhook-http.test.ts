import { describe, expect, test } from "bun:test";

import { billingModule, billingWebhookModule } from "../src/modules/billing";

describe("Dodo webhook HTTP boundary", () => {
  test("requires Standard Webhooks delivery headers before parsing a body", async () => {
    const response = await billingWebhookModule.handle(
      new Request("http://localhost/api/webhooks/dodo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "subscription.active" }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      received: false,
      error: "Missing Standard Webhooks headers",
    });
  });

  test("rejects oversized deliveries before signature verification", async () => {
    const response = await billingWebhookModule.handle(
      new Request("http://localhost/api/webhooks/dodo", {
        method: "POST",
        headers: {
          "webhook-id": "msg_test",
          "webhook-signature": "v1,test",
          "webhook-timestamp": "1700000000",
        },
        body: "x".repeat(1024 * 1024 + 1),
      }),
    );

    expect(response.status).toBe(413);
  });

  test("rejects a declared oversized delivery without buffering it", async () => {
    const response = await billingWebhookModule.handle(
      new Request("http://localhost/api/webhooks/dodo", {
        method: "POST",
        headers: {
          "content-length": String(1024 * 1024 + 1),
          "webhook-id": "msg_test",
          "webhook-signature": "v1,test",
          "webhook-timestamp": "1700000000",
        },
        body: "{}",
      }),
    );

    expect(response.status).toBe(413);
  });

  test("keeps billing account routes behind session authentication", async () => {
    const response = await billingModule.handle(
      new Request("http://localhost/api/billing/", { method: "GET" }),
    );

    expect(response.status).toBe(401);
  });
});
