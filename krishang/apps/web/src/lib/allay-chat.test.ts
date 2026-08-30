import { describe, expect, test } from "bun:test";
import {
  type AllayChatTurn,
  allayFallbackMessage,
  appendAllayExchange,
  shouldUseAllayModel,
} from "./allay-chat";
import { parseAllayIntent } from "./allay-intent";
import { ApiError } from "./api";

describe("Allay model boundary", () => {
  test("uses Luna only for conversational turns", () => {
    expect(shouldUseAllayModel(parseAllayIntent("hello Allay"))).toBe(true);
    expect(shouldUseAllayModel(parseAllayIntent("tell me a joke"))).toBe(true);
    expect(shouldUseAllayModel(parseAllayIntent("help"))).toBe(true);

    expect(shouldUseAllayModel(parseAllayIntent("start Survival"))).toBe(false);
    expect(shouldUseAllayModel(parseAllayIntent("create a Paper server named Survival"))).toBe(
      false,
    );
    expect(shouldUseAllayModel(parseAllayIntent("show my realms"))).toBe(false);
  });

  test("keeps a separate bounded conversational history", () => {
    let history: AllayChatTurn[] = [];
    for (let index = 0; index < 6; index++) {
      history = appendAllayExchange(history, `user ${index}`, `allay ${index}`);
    }

    expect(history).toHaveLength(8);
    expect(history[0]).toEqual({ role: "user", content: "user 2" });
    expect(history.at(-1)).toEqual({ role: "assistant", content: "allay 5" });
  });

  test("makes model degradation visible without affecting deterministic controls", () => {
    expect(allayFallbackMessage(new ApiError(429, "rate limited"), "Offline help.")).toBe(
      "Luna is resting for a moment. Offline help.",
    );
    expect(allayFallbackMessage(new ApiError(503, "missing key"), "Offline help.")).toBe(
      "Luna is not configured on this control plane. Offline help.",
    );
    expect(allayFallbackMessage(new TypeError("network"), "Offline help.")).toContain(
      "Luna is unavailable right now",
    );
  });
});
