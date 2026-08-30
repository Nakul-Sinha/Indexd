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
