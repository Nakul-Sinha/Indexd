import type { AllayIntent } from "./allay-intent";
import { ApiError, api } from "./api";

export type AllayChatTurn = {
  role: "user" | "assistant";
  content: string;
};

type AllayChatResponse = {
  success: boolean;
  data: {
    reply: string;
  };
};

export function shouldUseAllayModel(intent: AllayIntent): boolean {
  return intent.kind === "greeting" || intent.kind === "help" || intent.kind === "unknown";
}

export function appendAllayExchange(
  history: AllayChatTurn[],
  message: string,
  reply: string,
): AllayChatTurn[] {
  return [
    ...history,
    { role: "user" as const, content: message },
    { role: "assistant" as const, content: reply },
  ].slice(-8);
}

export function allayFallbackMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 429) return `Luna is resting for a moment. ${fallback}`;
    if (error.status === 401)
      return `Luna needs an authenticated control-plane session. ${fallback}`;
    if (error.status === 503) return `Luna is not configured on this control plane. ${fallback}`;
  }
  return `Luna is unavailable right now, so I’m using my offline reply. ${fallback}`;
}

export async function askAllay(
  message: string,
  history: AllayChatTurn[],
  signal?: AbortSignal,
): Promise<string> {
  const result = await api<AllayChatResponse>("/api/allay/chat", {
    method: "POST",
    body: JSON.stringify({ message, history: history.slice(-8) }),
    signal,
  });
  const reply = result.data?.reply?.trim();
  if (!reply) throw new Error("Allay returned an empty reply.");
  return reply;
}
