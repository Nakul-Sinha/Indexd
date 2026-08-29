import "./load-env";
import type { Elysia } from "elysia";
import { app } from "./app";
import { type RollupStore, telemetryPlugin } from "./modules/telemetry/index.ts";

export { app };

/**
 * The telemetry module's mount point, kept to one call so the shell owner can
 * move or rename it without reading the module. Pass the Drizzle-backed
 * RollupStore once the `world_events_rollup` migration lands; until then
 * InMemoryRollupStore from the same module is a working stand-in.
 */
export function registerTelemetry<T extends Elysia>(instance: T, store: RollupStore) {
  return instance.use(telemetryPlugin({ store }));
}

app.listen(process.env.PORT || 3001);

console.log(`🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`);
