import { type Static, Type } from "@sinclair/typebox";

export const BillingPlan = Type.Union([
  Type.Literal("starter"),
  Type.Literal("standard"),
  Type.Literal("pro"),
]);
export type BillingPlan = Static<typeof BillingPlan>;

export const PaidBillingPlan = Type.Union([Type.Literal("standard"), Type.Literal("pro")]);
export type PaidBillingPlan = Static<typeof PaidBillingPlan>;

export const BillingLimits = Type.Object({
  servers: Type.Integer({ minimum: 1 }),
  ram_mb: Type.Integer({ minimum: 1 }),
  cpu_cores: Type.Number({ exclusiveMinimum: 0 }),
  storage_gb: Type.Integer({ minimum: 1 }),
  backups: Type.Integer({ minimum: 0 }),
});
export type BillingLimits = Static<typeof BillingLimits>;

export const BillingPlanSummary = Type.Object({
  plan: BillingPlan,
  configured: Type.Boolean(),
  limits: BillingLimits,
});
export type BillingPlanSummary = Static<typeof BillingPlanSummary>;

export const BillingSubscriptionSummary = Type.Object({
  plan: PaidBillingPlan,
  status: Type.String(),
  cancel_at_next_billing_date: Type.Boolean(),
  next_billing_date: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
});
export type BillingSubscriptionSummary = Static<typeof BillingSubscriptionSummary>;

export const BillingSummaryResponse = Type.Object({
  provider: Type.Literal("dodo_payments"),
  enabled: Type.Boolean(),
  current_plan: BillingPlan,
  plans: Type.Array(BillingPlanSummary),
  subscription: Type.Union([BillingSubscriptionSummary, Type.Null()]),
  can_manage_billing: Type.Boolean(),
});
export type BillingSummaryResponse = Static<typeof BillingSummaryResponse>;

export const BillingCheckoutRequest = Type.Object({
  plan: PaidBillingPlan,
  request_key: Type.String({ minLength: 16, maxLength: 128 }),
});
export type BillingCheckoutRequest = Static<typeof BillingCheckoutRequest>;

export const BillingCheckoutResponse = Type.Object({
  checkout_url: Type.String({ format: "uri" }),
  session_id: Type.String(),
  reused: Type.Boolean(),
});
export type BillingCheckoutResponse = Static<typeof BillingCheckoutResponse>;

export const BillingPortalResponse = Type.Object({
  portal_url: Type.String({ format: "uri" }),
});
export type BillingPortalResponse = Static<typeof BillingPortalResponse>;
