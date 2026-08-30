import { describe, expect, test } from "bun:test";

import { upstreamSessionCookie } from "./auth-cookie";

describe("upstreamSessionCookie", () => {
  test("builds one cookie from the already validated database token", () => {
    expect(upstreamSessionCookie("session-token")).toBe("better-auth.session_token=session-token");
  });

  test("encodes characters that are unsafe in a Cookie header", () => {
    expect(upstreamSessionCookie("token; injected=value")).toBe(
      "better-auth.session_token=token%3B%20injected%3Dvalue",
    );
  });

  test("rejects an empty validated token", () => {
    expect(() => upstreamSessionCookie("  ")).toThrow("validated session token");
  });
});
