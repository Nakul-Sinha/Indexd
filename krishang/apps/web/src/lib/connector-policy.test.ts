import { describe, expect, test } from "bun:test";

import { connectorOriginAllowed, connectorPathAllowed } from "./connector-policy";

describe("connectorPathAllowed", () => {
  test("limits the connector to health and operator-owned server routes", () => {
    expect(connectorPathAllowed("/health")).toBe(true);
    expect(connectorPathAllowed("/api/servers")).toBe(true);
    expect(connectorPathAllowed("/api/servers/create")).toBe(true);
    expect(connectorPathAllowed("/api/servers/server-id/action")).toBe(true);
    expect(connectorPathAllowed("/api/allay/chat")).toBe(true);
    expect(connectorPathAllowed("/api/allay/execute")).toBe(true);
    expect(connectorPathAllowed("/api/quota")).toBe(false);
    expect(connectorPathAllowed("/api/allay")).toBe(false);
    expect(connectorPathAllowed("/api/allay/tools")).toBe(false);
  });

  test("never exposes the internal server inventory route", () => {
    expect(connectorPathAllowed("/api/servers/internal")).toBe(false);
    expect(connectorPathAllowed("/api/servers/internal/export")).toBe(false);
  });
});

describe("connectorOriginAllowed", () => {
  const policy = {
    requestOrigin: "https://control.example",
    configuredOrigin: "https://preview.example",
    production: true,
  };

  test("allows safe reads without an Origin header", () => {
    expect(connectorOriginAllowed({ ...policy, method: "GET", origin: null })).toBe(true);
  });

  test("requires an exact trusted origin for mutations", () => {
    expect(
      connectorOriginAllowed({ ...policy, method: "POST", origin: "https://control.example" }),
    ).toBe(true);
    expect(
      connectorOriginAllowed({ ...policy, method: "POST", origin: "https://preview.example" }),
    ).toBe(true);
    expect(connectorOriginAllowed({ ...policy, method: "POST", origin: null })).toBe(false);
    expect(
      connectorOriginAllowed({ ...policy, method: "POST", origin: "https://attacker.example" }),
    ).toBe(false);
  });
});
