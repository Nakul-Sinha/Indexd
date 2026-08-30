import type { BillingPlan } from "./config";

export const entitlementStatuses = new Set(["active"]);
export const checkoutBlockingStatuses = new Set(["pending", "active", "on_hold", "paused"]);

const planRank: Record<BillingPlan, number> = {
  starter: 0,
  standard: 1,
  pro: 2,
};

export type SubscriptionEntitlement = {
  plan: BillingPlan;
  status: string;
};

export function latestWebhookTimestamp(existing: Date | undefined, incoming: Date): Date {
  if (!existing || incoming > existing) return incoming;
  return existing;
}

export function isDefinitiveCheckoutFailure(status: number | undefined): boolean {
  return (
    typeof status === "number" &&
    status >= 400 &&
    status < 500 &&
    ![408, 409, 425, 429].includes(status)
  );
}

export function highestEntitledPlan(subscriptions: SubscriptionEntitlement[]): BillingPlan {
  let selected: BillingPlan = "starter";
  for (const subscription of subscriptions) {
    if (
      entitlementStatuses.has(subscription.status) &&
      planRank[subscription.plan] > planRank[selected]
    ) {
      selected = subscription.plan;
    }
  }
  return selected;
}
