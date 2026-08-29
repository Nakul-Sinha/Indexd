import type { Deployment, DeploymentState } from "@farlands/contracts";
import { DEPLOYMENT_ORDER, deployments, nextEventId, publish } from "./state.ts";

/**
 * Scripted deployment runs.
 *
 * Four scenarios, because the interesting paths are the ones that do not
 * succeed. A CLI that follows a happy deployment proves very little; a CLI that
 * detects a stall and calls abort is the thing worth testing before the real
 * controller exists.
 */

export type ScenarioName = "happy" | "stall" | "abort_at_verifying" | "fail_at_building";

export const SCENARIOS: readonly ScenarioName[] = [
  "happy",
  "stall",
  "abort_at_verifying",
  "fail_at_building",
];

export function isScenario(value: string): value is ScenarioName {
  return (SCENARIOS as readonly string[]).includes(value);
}

const DETAIL: Partial<Record<DeploymentState, string>> = {
  queued: "waiting for a deployment slot",
  building: "built JAR from template",
  staging: "candidate pod provisioned, Paper not started",
  presync: "world copied 412 MB",
  freezing: "save-off, flush, delta 1.8 MB",
  verifying: "Paper up, rules loaded, no startup exceptions",
  cutover: "players moved lobby to candidate",
  draining: "original stopped, snapshot retained",
  idle: "candidate is the server of record",
};

function emit(deployment: Deployment, state: DeploymentState, detail: string | null): void {
  const updated: Deployment = {
    ...deployment,
    state,
    queue_position: state === "queued" ? 0 : null,
    finished_at:
      state === "idle" || state === "aborted" || state === "failed"
        ? new Date().toISOString()
        : null,
    player_visible_ms: state === "idle" ? 31_500 : null,
    error:
      state === "failed"
        ? "candidate failed its health check: 3 startup exceptions"
        : state === "aborted"
          ? "aborted before cutover; players returned to the original server"
          : null,
  };
  deployments.set(deployment.deployment_id, updated);

  publish({
    id: nextEventId(),
    type: "deployment_state",
    server_id: deployment.server_id,
    ts: new Date().toISOString(),
    data: {
      deployment_id: deployment.deployment_id,
      state,
      detail,
      queue_position: state === "queued" ? 0 : null,
    },
  });
}

/**
 * Drive a deployment through its scripted states.
 *
 * stepMs is deliberately short. The mock is a development target, not a
 * simulation: nothing here is a claim about how long a real freeze takes, and
 * the estimated player-visible window stays unmeasured until M1 reports.
 */
export function runScenario(deployment: Deployment, scenario: ScenarioName, stepMs = 600): void {
  const stopAfter: Record<ScenarioName, DeploymentState | null> = {
    happy: null,
    stall: "presync",
    abort_at_verifying: "verifying",
    fail_at_building: "building",
  };

  let index = 0;

  const tick = () => {
    const state = DEPLOYMENT_ORDER[index];
    if (!state) return;

    emit(deployment, state, DETAIL[state] ?? null);

    const halt = stopAfter[scenario];
    if (halt === state) {
      if (scenario === "stall") {
        // Emit nothing further. The CLI watch loop should notice the missing
        // transition against its per-state budget and call abort.
        return;
      }
      const terminal: DeploymentState = scenario === "fail_at_building" ? "failed" : "aborted";
      setTimeout(() => {
        emit(
          deployment,
          terminal,
          terminal === "failed"
            ? "candidate deleted, original untouched"
            : "candidate deleted, players returned from the lobby, no trace left",
        );
      }, stepMs);
      return;
    }

    index += 1;
    if (index < DEPLOYMENT_ORDER.length) setTimeout(tick, stepMs);
  };

  setTimeout(tick, 0);
}
