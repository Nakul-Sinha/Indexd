import { describe, expect, test } from "bun:test";

import {
  BillingConfigError,
  parseBillingConfig,
  planForProduct,
} from "../src/modules/billing/config";
import {
  highestEntitledPlan,
  isDefinitiveCheckoutFailure,
  latestWebhookTimestamp,
} from "../src/modules/billing/policy";

const standardPlan = {
  productId: "pdt_standard",
  serversLimit: 2,
  ramLimitMb: 4096,
  cpuLimit: 4,
  storageLimitGb: 20,
  backupsLimit: 6,
};

const completeEnv = {
  DODO_PAYMENTS_API_KEY: "test_key",
  DODO_PAYMENTS_WEBHOOK_KEY: "whsec_test",
  DODO_PAYMENTS_BUSINESS_ID: "bus_test",
  DODO_PAYMENTS_ENVIRONMENT: "test_mode",
  DODO_PAYMENTS_RETURN_URL: "http://localhost:3000/?billing=return",
  DODO_PAYMENTS_CANCEL_URL: "http://localhost:3000/?billing=cancel",
  DODO_PAYMENTS_PORTAL_RETURN_URL: "http://localhost:3000/",
  DODO_PAYMENTS_PLAN_CATALOG: JSON.stringify({ standard: standardPlan }),
};

describe("Dodo billing configuration", () => {
  test("is disabled when no Dodo setting is present", () => {
    expect(parseBillingConfig({})).toMatchObject({ enabled: false, plans: {} });
  });

  test("requires a complete, exact product catalog", () => {
    expect(() => parseBillingConfig(completeEnv)).not.toThrow();
    expect(() =>
      parseBillingConfig({ ...completeEnv, DODO_PAYMENTS_WEBHOOK_KEY: undefined }),
    ).toThrow(BillingConfigError);
    expect(() =>
      parseBillingConfig({
        ...completeEnv,
        DODO_PAYMENTS_PLAN_CATALOG: JSON.stringify({
          standard: {
            productId: "pdt_standard",
            serversLimit: 2,
            ramLimitMb: 4096,
            cpuLimit: 4,
            storageLimitGb: 20,
            backupsLimit: 6,
            price: 999,
          },
        }),
      }),
    ).toThrow(BillingConfigError);
  });

  test("maps only configured Dodo product ids", () => {
    const config = parseBillingConfig(completeEnv);
    expect(planForProduct(config, "pdt_standard")).toBe("standard");
    expect(planForProduct(config, "pdt_attacker_supplied")).toBeNull();
  });

  test("requires unique product ids and safe callback URLs", () => {
    expect(() =>
      parseBillingConfig({
        ...completeEnv,
        DODO_PAYMENTS_PLAN_CATALOG: JSON.stringify({
          standard: standardPlan,
          pro: {
            productId: "pdt_standard",
            serversLimit: 5,
            ramLimitMb: 16384,
            cpuLimit: 8,
            storageLimitGb: 80,
            backupsLimit: 10,
          },
        }),
      }),
    ).toThrow(BillingConfigError);
    expect(() =>
      parseBillingConfig({
        ...completeEnv,
        DODO_PAYMENTS_RETURN_URL: "ftp://localhost/billing-return",
      }),
    ).toThrow(BillingConfigError);
    expect(() =>
      parseBillingConfig({
        ...completeEnv,
        DODO_PAYMENTS_RETURN_URL: "http://billing.example.com/return",
      }),
    ).toThrow(BillingConfigError);
  });
});

describe("billing entitlement policy", () => {
  test("selects the highest active plan", () => {
    expect(
      highestEntitledPlan([
        { plan: "standard", status: "active" },
        { plan: "pro", status: "paused" },
      ]),
    ).toBe("standard");
    expect(highestEntitledPlan([{ plan: "pro", status: "active" }])).toBe("pro");
  });

  test("falls back to starter without an active subscription", () => {
    expect(highestEntitledPlan([{ plan: "pro", status: "on_hold" }])).toBe("starter");
  });
});

describe("billing delivery policy", () => {
  test("keeps the audit watermark monotonic without using it to order state", () => {
    const existing = new Date("2026-08-30T12:00:00Z");

    expect(latestWebhookTimestamp(existing, new Date("2026-08-30T11:59:59Z"))).toEqual(existing);
    expect(latestWebhookTimestamp(existing, new Date("2026-08-30T12:00:01Z"))).toEqual(
      new Date("2026-08-30T12:00:01Z"),
    );
    expect(latestWebhookTimestamp(undefined, existing)).toEqual(existing);
  });

  test("keeps ambiguous provider failures indeterminate", () => {
    expect(isDefinitiveCheckoutFailure(undefined)).toBe(false);
    for (const status of [408, 409, 425, 429, 500, 503]) {
      expect(isDefinitiveCheckoutFailure(status)).toBe(false);
    }
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isDefinitiveCheckoutFailure(status)).toBe(true);
    }
  });
});
