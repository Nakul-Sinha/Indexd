import { describe, expect, test } from "bun:test";
import {
  API_BASE_URL_ENV,
  API_BASE_URL_ENV_LEGACY,
  DEFAULT_API_BASE_URL,
  resolveApiBaseUrl,
} from "../src/endpoints.ts";

/**
 * These exist because the defaults were the one piece of configuration nothing
 * exercised: every test harness injects a base URL, so three clients drifted to
 * three different ports and two environment variable names without any suite
 * noticing.
 */

describe("resolveApiBaseUrl", () => {
  test("prefers the current environment variable", () => {
    expect(resolveApiBaseUrl({ [API_BASE_URL_ENV]: "http://api.example" })).toBe(
      "http://api.example",
    );
  });

  test("still reads the legacy name, so existing shells keep working", () => {
    expect(resolveApiBaseUrl({ [API_BASE_URL_ENV_LEGACY]: "http://old.example" })).toBe(
      "http://old.example",
    );
  });

  test("the current name wins when both are set", () => {
    expect(
      resolveApiBaseUrl({
        [API_BASE_URL_ENV]: "http://new.example",
        [API_BASE_URL_ENV_LEGACY]: "http://old.example",
      }),
    ).toBe("http://new.example");
  });

  test("falls back to the shared default", () => {
    expect(resolveApiBaseUrl({})).toBe(DEFAULT_API_BASE_URL);
  });

  test("the default points at the port the mock actually listens on", () => {
    // The mock is the only server that exists. If this stops matching
    // MOCK_API_PORT in tools/mock-api, starting the mock and running a client
    // fails to connect, which is the bug this file exists to prevent.
    expect(DEFAULT_API_BASE_URL).toContain("4010");
  });
});
