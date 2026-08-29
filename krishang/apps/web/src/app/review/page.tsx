"use client";

import { useState } from "react";

export default function ReviewPage() {
  const [decision, setDecision] = useState<"approved" | "rejected" | null>(null);
  const changes = [
    [
      "Join greeting",
      "Welcome back, {player}!",
      "A green welcome message greets every new player.",
    ],
    ["Starter kit", "16 × Bread • Stone tools", "New explorers receive a small survival kit."],
    ["Achievement", "First Steps", "Plays a chime when a player breaks their first block."],
  ];

  return (
    <div className="mx-auto max-w-4xl">
      <p className="eyebrow">Approval gate • Mock mode</p>
      <h1 className="mt-1 text-3xl font-black">Review a world change</h1>
      <p className="mt-2 text-[var(--muted)]">
        Read what will happen in-game before granting a short-lived deployment approval.
      </p>
      <div className="mt-6 grid gap-5 lg:grid-cols-[1fr_280px]">
        <section className="panel overflow-hidden">
          <div className="border-b border-[var(--line)] bg-black/15 p-5">
            <p className="font-black">
              Emerald SMP{" "}
              <span className="ml-2 rounded bg-[var(--gold)]/20 px-2 py-1 text-xs text-[var(--gold)]">
                v12 → v13
              </span>
            </p>
            <p className="mt-1 text-sm text-[var(--muted)]">
              Proposed by Realm Director • 2 minutes ago
            </p>
          </div>
          <div className="divide-y divide-[var(--line)]">
            {changes.map(([title, value, description]) => (
              <div className="p-5" key={title}>
                <p className="font-bold text-[var(--lime)]">+ {title}</p>
                <p className="mt-2 font-semibold">{value}</p>
                <p className="mt-1 text-sm text-[var(--muted)]">{description}</p>
              </div>
            ))}
          </div>
        </section>
        <aside className="panel h-fit p-5">
          <p className="eyebrow">Impact check</p>
          <h2 className="mt-1 text-lg font-black">Safe to ship?</h2>
          <div className="mt-4 space-y-3 text-sm">
            <p className="rounded bg-black/20 p-3">
              <b className="text-[var(--lime)]">✓ No downtime</b>
              <br />
              <span className="text-[var(--muted)]">Applied during the next safe window.</span>
            </p>
            <p className="rounded bg-black/20 p-3">
              <b className="text-[var(--lime)]">✓ Reversible</b>
              <br />
              <span className="text-[var(--muted)]">Previous rule version remains ready.</span>
            </p>
          </div>
          <button
            className="mc-button mt-5 w-full"
            onClick={() => setDecision("approved")}
            type="button"
          >
            ✓ Approve & deploy
          </button>
          <button
            className="mc-button danger mt-3 w-full"
            onClick={() => setDecision("rejected")}
            type="button"
          >
            Reject change
          </button>
        </aside>
      </div>
      {decision ? (
        <div
          className={`mt-5 rounded border p-4 font-bold ${decision === "approved" ? "border-[var(--lime)] bg-[var(--lime)]/10 text-[var(--lime)]" : "border-[var(--redstone)] bg-[var(--redstone)]/10 text-[var(--redstone)]"}`}
        >
          {decision === "approved"
            ? "Approval created. The deployment is queued."
            : "Proposal rejected. Your feedback will help shape the next proposal."}
        </div>
      ) : null}
    </div>
  );
}
