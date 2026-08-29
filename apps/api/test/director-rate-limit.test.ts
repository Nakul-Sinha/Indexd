import { describe, expect, test } from "bun:test";
import type { WorldEventsRollup } from "@farlands/contracts";
import {
  Director,
  InMemoryProposalStore,
  PROPOSAL_INTERVAL_SECONDS,
  proposalWindow,
} from "../src/modules/director/index.ts";
import {
  brief,
  fixedClock,
  scriptedProposalModel,
  scriptedRuleModel,
  serverContext,
  VALID_DOCUMENT,
} from "./director-support.ts";

/**
 * One proposal per server per hour, enforced server side.
 *
 * The reason is a product truth rather than a cost control, and the tests follow
 * it: a suppressed run must cost nothing and leave nothing behind, and a
 * rejected proposal must start the hour just as an accepted one does, because
 * the thing being rationed is how often an owner is interrupted rather than how
 * often the Director is right.
 */

const START = Date.parse("2026-08-29T18:00:00.000Z");
const HOUR_MS = PROPOSAL_INTERVAL_SECONDS * 1000;

function window(serverId: string): WorldEventsRollup {
  return {
    server_id: serverId,
    window_start: "2026-08-29T17:55:00.000Z",
    window_end: "2026-08-29T18:00:00.000Z",
    metrics: {
      joins: 6,
      leaves: 5,
      deaths: 11,
      blocks_placed: 40,
      blocks_broken: 62,
      chat_messages: 18,
      unique_players: 6,
      mean_session_seconds: 1800,
      seconds_in_region: { spawn: 900 },
    },
  };
}

interface Fixture {
  director: Director;
  proposals: InMemoryProposalStore;
  briefCalls: () => number;
  advance: (ms: number) => void;
}

function build(briefs: readonly unknown[]): Fixture {
  const clock = fixedClock(START);
  const proposals = new InMemoryProposalStore({ now: clock.now });
  const proposalModel = scriptedProposalModel(briefs);
  const ruleModel = scriptedRuleModel(briefs.map(() => VALID_DOCUMENT));

  const director = new Director({
    rollups: {
      async list(serverId: string) {
        return [window(serverId)];
      },
    },
    proposals,
    model: proposalModel.model,
    ruleModel: ruleModel.model,
    now: clock.now,
  });

  return {
    director,
    proposals,
    briefCalls: () => proposalModel.calls.length,
    advance: clock.advance,
  };
}

describe("the window itself", () => {
  test("a server that has never been proposed to is eligible", () => {
    expect(proposalWindow(null, START)).toEqual({
      allowed: true,
      interval_seconds: 3600,
      retry_after_seconds: 0,
    });
  });

  test("a proposal one second old suppresses, and says how long to wait", () => {
    const verdict = proposalWindow(new Date(START).toISOString(), START + 1000);
    expect(verdict.allowed).toBe(false);
    expect(verdict.retry_after_seconds).toBe(3599);
  });

  test("the boundary is inclusive, so a caller that waits exactly the interval is served", () => {
    const at = new Date(START).toISOString();
    expect(proposalWindow(at, START + HOUR_MS - 1).allowed).toBe(false);
    expect(proposalWindow(at, START + HOUR_MS).allowed).toBe(true);
  });

  test("an unreadable timestamp does not wedge the server shut forever", () => {
    expect(proposalWindow("not a date", START).allowed).toBe(true);
  });
});

describe("a second proposal within the hour", () => {
  test("is suppressed, and the run never reaches the model", async () => {
    const fixture = build([brief(), brief()]);

    const first = await fixture.director.run({ context: serverContext });
    expect(first.status).toBe("proposed");
    expect(fixture.briefCalls()).toBe(1);

    fixture.advance(60_000);
    const second = await fixture.director.run({ context: serverContext });

    expect(second.status).toBe("rate_limited");
    if (second.status === "rate_limited") {
      expect(second.interval_seconds).toBe(3600);
      expect(second.retry_after_seconds).toBe(3540);
    }

    // The limit is a bound on how often the world changes, so it is checked
    // before anything is generated. A run that produced a proposal and then
    // dropped it would still have spent the tokens.
    expect(fixture.briefCalls()).toBe(1);
    expect(Object.values(fixture.proposals.contents()).flat()).toHaveLength(1);
  });

  test("is served once the hour is up", async () => {
    const fixture = build([brief(), brief()]);

    await fixture.director.run({ context: serverContext });
    fixture.advance(HOUR_MS);
    const second = await fixture.director.run({ context: serverContext });

    expect(second.status).toBe("proposed");
    expect(Object.values(fixture.proposals.contents()).flat()).toHaveLength(2);
  });

  test("a rejected proposal still holds the hour", async () => {
    const fixture = build([brief(), brief()]);

    const first = await fixture.director.run({ context: serverContext });
    expect(first.status).toBe("proposed");
    if (first.status !== "proposed") return;

    await fixture.proposals.review({
      proposal_id: first.proposal.proposal_id,
      status: "rejected",
      reviewed_by: "usr_owner",
      rejection_reason: "Spawn is meant to be dangerous.",
    });

    // The owner has already spent a decision on this server this hour. Being
    // told no is not an invitation to ask again immediately.
    fixture.advance(60_000);
    expect((await fixture.director.run({ context: serverContext })).status).toBe("rate_limited");
  });
});

describe("the limit is per server", () => {
  test("a proposal on one server does not silence another", async () => {
    const fixture = build([brief(), brief()]);
    const other = { server_id: "srv_9a1", regions: ["spawn"] };

    expect((await fixture.director.run({ context: serverContext })).status).toBe("proposed");
    expect((await fixture.director.run({ context: other })).status).toBe("proposed");

    const contents = fixture.proposals.contents();
    expect(Object.keys(contents).sort()).toEqual(["srv_7f2", "srv_9a1"]);
  });
});

describe("the limit is enforced against the rows, not against a counter", () => {
  test("a fresh Director over the same store still suppresses", async () => {
    const clock = fixedClock(START);
    const proposals = new InMemoryProposalStore({ now: clock.now });

    const first = build([brief()]);
    // Seed the store directly, standing in for a row written by a process that
    // has since restarted. An in-memory counter would have gone with it.
    await proposals.insertPending({
      server_id: serverContext.server_id,
      suggested_rules: VALID_DOCUMENT,
      rationale: "Written by an earlier process.",
      confidence: 0.4,
      observed: null,
    });
    expect(first.briefCalls()).toBe(0);

    const proposalModel = scriptedProposalModel([]);
    const director = new Director({
      rollups: {
        async list(serverId: string) {
          return [window(serverId)];
        },
      },
      proposals,
      model: proposalModel.model,
      ruleModel: scriptedRuleModel([]).model,
      now: clock.now,
    });

    clock.advance(60_000);
    expect((await director.run({ context: serverContext })).status).toBe("rate_limited");
    expect(proposalModel.calls).toHaveLength(0);
  });
});
