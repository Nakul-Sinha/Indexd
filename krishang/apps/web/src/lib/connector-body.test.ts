import { describe, expect, test } from "bun:test";
import {
  ConnectorBodyTooLargeError,
  MAX_CONNECTOR_BODY_BYTES,
  readConnectorBody,
} from "./connector-body";

describe("readConnectorBody", () => {
  test("passes a bounded request body through unchanged", async () => {
    const request = new Request("http://localhost/api/allay/chat", {
      method: "POST",
      body: JSON.stringify({ message: "hello", history: [] }),
    });

    const body = await readConnectorBody(request);
    expect(new TextDecoder().decode(body)).toBe('{"message":"hello","history":[]}');
  });

  test("rejects an oversized declared content length before reading", async () => {
    const request = new Request("http://localhost/api/allay/chat", {
      method: "POST",
      headers: { "content-length": String(MAX_CONNECTOR_BODY_BYTES + 1) },
      body: "small",
    });

    await expect(readConnectorBody(request)).rejects.toBeInstanceOf(ConnectorBodyTooLargeError);
  });

  test("rejects an oversized streamed body without a content length", async () => {
    const request = new Request("http://localhost/api/allay/chat", {
      method: "POST",
      body: "x".repeat(MAX_CONNECTOR_BODY_BYTES + 1),
    });

    await expect(readConnectorBody(request)).rejects.toBeInstanceOf(ConnectorBodyTooLargeError);
  });
});
