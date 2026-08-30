import "./load-env";
import type { Elysia } from "elysia";
import { app } from "./app";
import { BillingService } from "./modules/billing/service";
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

void BillingService.reconcileAllEntitlements()
  .then((result) => {
    if (result.enabled) {
      console.info(`[billing] Reconciled ${result.reconciled} account entitlement(s)`);
    }
  })
  .catch((error) => {
    console.error("[billing] Startup entitlement reconciliation failed", error);
  });

console.log(`🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`);
