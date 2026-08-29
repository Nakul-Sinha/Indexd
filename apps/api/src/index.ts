/**
 * The control plane.
 *
 * Scaffold only. Engineer 3 owns the application shell; Engineer 1 owns
 * src/modules/telemetry and src/modules/director inside it.
 */

import type { Elysia } from "elysia";
import { type RollupStore, telemetryPlugin } from "./modules/telemetry/index.ts";

export const PLACEHOLDER = true;

/**
 * The telemetry module's mount point, kept to one call so the shell owner can
 * move or rename it without reading the module. Pass the Drizzle-backed
 * RollupStore once the `world_events_rollup` migration lands; until then
 * InMemoryRollupStore from the same module is a working stand-in.
 */
export function registerTelemetry<T extends Elysia>(app: T, store: RollupStore) {
  return app.use(telemetryPlugin({ store }));
}
