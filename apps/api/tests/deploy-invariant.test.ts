import { describe, expect, test } from "bun:test";
import { AuthClient } from "../src/modules/deploy/invariant";
import { FREEZE_COMMANDS } from "../src/modules/rcon/client";

describe("invariant", () => {
  test("pre-cutover client cannot stop or delete A", () => {
    const client = new AuthClient("pre-cutover");
    client.assertCannotTouchA();
    expect(() => client.stopA()).toThrow(/INVARIANT/);
    expect(() => client.deleteA()).toThrow(/INVARIANT/);
  });

  test("draining client may retire A", () => {
    const client = new AuthClient("draining");
    expect(() => client.assertCanRetireA()).not.toThrow();
  });
});

describe("freeze command order", () => {
  test("save-off precedes save-all flush precedes save-on", () => {
    expect(FREEZE_COMMANDS).toEqual(["save-off", "save-all flush", "save-on"]);
    expect(FREEZE_COMMANDS.indexOf("save-off")).toBeLessThan(
      FREEZE_COMMANDS.indexOf("save-all flush"),
    );
  });
});
