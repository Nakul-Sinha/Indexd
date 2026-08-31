import { createHash } from "node:crypto";
import {
  billingCheckoutSessions,
  billingCustomers,
  billingSubscriptions,
  billingWebhookEvents,
  userQuotas,
  users,
} from "@repo/db";
import DodoPayments from "dodopayments";
import type { Payment } from "dodopayments/resources/payments";
import type { Subscription } from "dodopayments/resources/subscriptions";
import type { UnwrapWebhookEvent } from "dodopayments/resources/webhooks/webhooks";
import { and, desc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { status } from "elysia";

import { db, type TransactionType } from "../../db";
import {
  type BillingConfig,
  BillingConfigError,
  type BillingLimits,
  type BillingPlan,
  type PaidBillingPlan,
  paidBillingPlans,
  parseBillingConfig,
  planForProduct,
  requireEnabledBillingConfig,
  starterLimits,
} from "./config";
import {
  checkoutBlockingStatuses,
  highestEntitledPlan,
  isDefinitiveCheckoutFailure,
  latestWebhookTimestamp,
} from "./policy";

const CHECKOUT_CREATING_TTL_MS = 2 * 60 * 1000;
const WEBHOOK_RECONCILIATION_TIMEOUT_MS = 10_000;
// Dodo checkout sessions remain valid for 24 hours by default. Keep the local
// duplicate guard for the same window so two live subscription checkouts cannot
// exist for one account.
const CHECKOUT_READY_TTL_MS = 24 * 60 * 60 * 1000;
const checkoutSessionBlockingStatuses = new Set(["creating", "ready", "indeterminate"]);
const subscriptionEventTypes = new Set([
  "subscription.active",
  "subscription.renewed",
  "subscription.on_hold",
  "subscription.paused",
  "subscription.unpaused",
  "subscription.cancelled",
  "subscription.failed",
  "subscription.expired",
  "subscription.plan_changed",
  "subscription.updated",
  "subscription.update_payment_method",
]);

type CheckoutInput = {
  plan: PaidBillingPlan;
  request_key: string;
};

type WebhookDelivery = {
  webhookId: string;
  rawBody: string;
  event: UnwrapWebhookEvent;
};

type SubscriptionEvent = UnwrapWebhookEvent & {
  business_id: string;
  data: Subscription;
  timestamp: string;
};

type EnabledBillingConfig = ReturnType<typeof requireEnabledBillingConfig>;

function clientFor(
  config: ReturnType<typeof requireEnabledBillingConfig>,
  timeout = 60_000,
): DodoPayments {
  return new DodoPayments({
    bearerToken: config.apiKey,
    webhookKey: config.webhookKey,
    environment: config.environment,
    maxRetries: 0,
    timeout,
  });
}

function toPublicLimits(limits: BillingLimits) {
  return {
    servers: limits.serversLimit,
    ram_mb: limits.ramLimitMb,
    cpu_cores: limits.cpuLimit,
    storage_gb: limits.storageLimitGb,
    backups: limits.backupsLimit,
  };
}

function providerErrorSummary(error: unknown) {
  if (!error || typeof error !== "object") return { name: "unknown" };
  const value = error as { name?: string; status?: number; request_id?: string };
  return { name: value.name, status: value.status, requestId: value.request_id };
}

function providerHttpsUrl(value: string | null | undefined, label: string): string {
  try {
    if (!value) throw new Error();
    const url = new URL(value);
    if (url.protocol !== "https:") throw new Error();
    return url.toString();
  } catch {
    throw new Error(`Dodo returned an invalid ${label}`);
  }
}

function isSubscriptionEvent(event: UnwrapWebhookEvent): event is SubscriptionEvent {
  return subscriptionEventTypes.has(event.type);
}

function eventObjectId(event: UnwrapWebhookEvent): string | null {
  const data = event.data as unknown as Record<string, unknown>;
  for (const key of ["subscription_id", "payment_id", "refund_id", "dispute_id"]) {
    const value = data[key];
    if (typeof value === "string") return value;
  }
  return null;
}

async function ensureQuotaRow(tx: TransactionType, userId: string) {
  await tx.insert(userQuotas).values({ userId }).onConflictDoNothing();
}

async function lockQuotaRow(tx: TransactionType, userId: string) {
  await ensureQuotaRow(tx, userId);
  await tx
    .select({ userId: userQuotas.userId })
    .from(userQuotas)
    .where(eq(userQuotas.userId, userId))
    .for("update");
}

async function projectEntitlements(
  tx: TransactionType,
  userId: string,
  config: BillingConfig,
): Promise<BillingPlan> {
  // All webhook projections for one account serialize on this row. The ledger
  // read happens after the lock so a concurrent cancellation cannot be
  // overwritten by a calculation from an older snapshot.
  await lockQuotaRow(tx, userId);
  const subscriptions = await tx
    .select({
      plan: billingSubscriptions.plan,
      status: billingSubscriptions.status,
      productId: billingSubscriptions.dodoProductId,
    })
    .from(billingSubscriptions)
    .where(eq(billingSubscriptions.userId, userId));

  const eligible = subscriptions.filter(
    (subscription) => planForProduct(config, subscription.productId) === subscription.plan,
  );
  const plan = highestEntitledPlan(eligible);
  const limits = plan === "starter" ? starterLimits : config.plans[plan];
  if (!limits) {
    throw new BillingConfigError(`No quota limits are configured for the active ${plan} plan`);
  }

  await tx
    .update(userQuotas)
    .set({
      plan,
      serversLimit: limits.serversLimit,
      ramLimitMb: limits.ramLimitMb,
      cpuLimit: String(limits.cpuLimit),
      storageLimitGb: limits.storageLimitGb,
      backupsLimit: limits.backupsLimit,
      updatedAt: new Date(),
    })
    .where(eq(userQuotas.userId, userId));
  return plan;
}

function subscriptionState(
  subscription: Subscription,
  event: SubscriptionEvent,
  webhookId: string,
) {
  return {
    dodoCustomerId: subscription.customer.customer_id,
    dodoProductId: subscription.product_id,
    status: subscription.status,
    cancelAtNextBillingDate: subscription.cancel_at_next_billing_date,
    trialPeriodDays: subscription.trial_period_days,
    previousBillingDate: new Date(subscription.previous_billing_date),
    nextBillingDate: new Date(subscription.next_billing_date),
    expiresAt: subscription.expires_at ? new Date(subscription.expires_at) : null,
    cancelledAt: subscription.cancelled_at ? new Date(subscription.cancelled_at) : null,
    lastWebhookId: webhookId,
    lastEventTimestamp: new Date(event.timestamp),
    updatedAt: new Date(),
  };
}

async function completeCheckoutForSubscription(
  tx: TransactionType,
  userId: string,
  subscription: Subscription,
  expectedPlan?: PaidBillingPlan,
) {
  const metadataUserId = subscription.metadata.farlands_user_id;
  const requestKey = subscription.metadata.farlands_request_key;
  const metadataPlan = subscription.metadata.farlands_plan;
  if (
    metadataUserId !== userId ||
    typeof requestKey !== "string" ||
    (metadataPlan !== "standard" && metadataPlan !== "pro") ||
    (expectedPlan && metadataPlan !== expectedPlan)
  ) {
    return;
  }

  // A user has one mutable checkout slot. Match the server-authenticated
  // metadata so a delayed webhook from an older subscription cannot complete
  // a newer checkout that happens to occupy that user's slot.
  await tx
    .update(billingCheckoutSessions)
    .set({ status: "completed", updatedAt: new Date() })
    .where(
      and(
        eq(billingCheckoutSessions.userId, userId),
        eq(billingCheckoutSessions.requestKey, requestKey),
        eq(billingCheckoutSessions.plan, metadataPlan),
      ),
    );
}

async function syncSubscriptionEvent(
  tx: TransactionType,
  event: SubscriptionEvent,
  webhookId: string,
  config: EnabledBillingConfig,
  userId: string,
): Promise<{ disposition: string; userId: string }> {
  const delivered = event.data;

  // Checkout creation, payment events, and lifecycle events all lock this row
  // first. Besides keeping quota projection atomic, the shared lock serializes
  // subscription snapshots for one account without relying on webhook IDs as
  // an ordering signal (Standard Webhooks only promises that they are unique).
  await lockQuotaRow(tx, userId);
  const [known] = await tx
    .select({
      userId: billingSubscriptions.userId,
      customerId: billingSubscriptions.dodoCustomerId,
      lastEventTimestamp: billingSubscriptions.lastEventTimestamp,
    })
    .from(billingSubscriptions)
    .where(eq(billingSubscriptions.dodoSubscriptionId, delivered.subscription_id))
    .limit(1);
  if (known && (known.userId !== userId || known.customerId !== delivered.customer.customer_id)) {
    throw new Error("Dodo subscription ownership changed unexpectedly");
  }

  // Dodo documents that deliveries may arrive out of order, while webhook IDs
  // are unique but not chronological. Treat each signed delivery as a signal
  // to read the current provider object, never as an ordered state snapshot.
  const subscription = await clientFor(
    config,
    WEBHOOK_RECONCILIATION_TIMEOUT_MS,
  ).subscriptions.retrieve(delivered.subscription_id);
  if (
    subscription.subscription_id !== delivered.subscription_id ||
    subscription.customer.customer_id !== delivered.customer.customer_id
  ) {
    throw new Error("Dodo returned a mismatched subscription during reconciliation");
  }

  const state = subscriptionState(subscription, event, webhookId);
  // This timestamp is an audit watermark only. Entitlement state always comes
  // from the authoritative read above, so delivery time never orders state.
  state.lastEventTimestamp = latestWebhookTimestamp(
    known?.lastEventTimestamp,
    state.lastEventTimestamp,
  );
  const plan = planForProduct(config, subscription.product_id);
  if (plan) {
    const values = { userId, plan, ...state };
    await tx
      .insert(billingSubscriptions)
      .values({ dodoSubscriptionId: subscription.subscription_id, ...values })
      .onConflictDoUpdate({
        target: billingSubscriptions.dodoSubscriptionId,
        set: values,
      });
  } else {
    if (!known) {
      throw new BillingConfigError("A Farlands checkout uses an unconfigured Dodo product");
    }
    await tx
      .update(billingSubscriptions)
      .set(state)
      .where(eq(billingSubscriptions.dodoSubscriptionId, subscription.subscription_id));
  }

  await projectEntitlements(tx, userId, config);
  await completeCheckoutForSubscription(tx, userId, subscription, plan ?? undefined);
  return { disposition: plan ? "processed" : "processed_unconfigured_product", userId };
}

async function applyUnconfiguredProductEvent(
  tx: TransactionType,
  event: SubscriptionEvent,
  webhookId: string,
  config: EnabledBillingConfig,
): Promise<{ disposition: string; userId?: string }> {
  const subscription = event.data;
  const [known] = await tx
    .select({
      userId: billingSubscriptions.userId,
      customerId: billingSubscriptions.dodoCustomerId,
    })
    .from(billingSubscriptions)
    .where(eq(billingSubscriptions.dodoSubscriptionId, subscription.subscription_id))
    .limit(1);
  if (!known) {
    // Ignore unrelated products in a shared Dodo business, but make Dodo retry
    // a checkout that carries our authenticated ownership metadata. That lets
    // an operator repair a missing catalog entry without losing the event.
    const metadataUserId = subscription.metadata.farlands_user_id;
    if (typeof metadataUserId === "string" && metadataUserId) {
      const [metadataUser] = await tx
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, metadataUserId))
        .limit(1);
      if (metadataUser?.email.toLowerCase() === subscription.customer.email.toLowerCase()) {
        throw new BillingConfigError("A Farlands checkout uses an unconfigured Dodo product");
      }
    }
    return { disposition: "ignored_unknown_product" };
  }
  if (known.customerId !== subscription.customer.customer_id) {
    throw new Error("Dodo subscription customer ownership changed unexpectedly");
  }
  return syncSubscriptionEvent(tx, event, webhookId, config, known.userId);
}

async function resolveSubscriptionOwner(
  tx: TransactionType,
  subscription: Subscription,
): Promise<{
  userId: string;
}> {
  const [knownSubscription] = await tx
    .select({
      userId: billingSubscriptions.userId,
      customerId: billingSubscriptions.dodoCustomerId,
    })
    .from(billingSubscriptions)
    .where(eq(billingSubscriptions.dodoSubscriptionId, subscription.subscription_id))
    .limit(1);

  if (knownSubscription) {
    if (knownSubscription.customerId !== subscription.customer.customer_id) {
      throw new Error("Dodo subscription customer ownership changed unexpectedly");
    }
    return { userId: knownSubscription.userId };
  }

  const [knownCustomer] = await tx
    .select({ userId: billingCustomers.userId })
    .from(billingCustomers)
    .where(eq(billingCustomers.dodoCustomerId, subscription.customer.customer_id))
    .limit(1);
  if (knownCustomer) return { userId: knownCustomer.userId };

  // This metadata is written only by the authenticated server checkout route.
  // Once learned, the unique provider-customer binding becomes authoritative.
  const metadataUserId = subscription.metadata.farlands_user_id;
  if (typeof metadataUserId !== "string" || !metadataUserId) {
    throw new Error("Verified subscription has no Farlands owner binding");
  }

  const [user] = await tx
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, metadataUserId))
    .limit(1);
  if (!user || user.email.toLowerCase() !== subscription.customer.email.toLowerCase()) {
    throw new Error("Verified subscription owner does not match its checkout customer");
  }

  // Match checkout's lock order before creating the durable customer binding:
  // quota -> customer/subscription -> checkout session.
  await lockQuotaRow(tx, user.id);
  const [otherBinding] = await tx
    .select({ customerId: billingCustomers.dodoCustomerId })
    .from(billingCustomers)
    .where(eq(billingCustomers.userId, user.id))
    .limit(1);
  if (otherBinding && otherBinding.customerId !== subscription.customer.customer_id) {
    throw new Error("Farlands user is already bound to another Dodo customer");
  }

  const inserted = await tx
    .insert(billingCustomers)
    .values({ userId: user.id, dodoCustomerId: subscription.customer.customer_id })
    .onConflictDoNothing()
    .returning({ userId: billingCustomers.userId });
  if (!inserted.length) {
    const [binding] = await tx
      .select({ userId: billingCustomers.userId, customerId: billingCustomers.dodoCustomerId })
      .from(billingCustomers)
      .where(
        or(
          eq(billingCustomers.userId, user.id),
          eq(billingCustomers.dodoCustomerId, subscription.customer.customer_id),
        ),
      )
      .limit(1);
    if (binding?.userId !== user.id || binding.customerId !== subscription.customer.customer_id) {
      throw new Error("Dodo customer ownership conflicted with an existing binding");
    }
  }
  return { userId: user.id };
}

async function applySubscriptionEvent(
  tx: TransactionType,
  event: SubscriptionEvent,
  webhookId: string,
  config: EnabledBillingConfig,
): Promise<{ disposition: string; userId?: string }> {
  const subscription = event.data;
  const plan = planForProduct(config, subscription.product_id);
  if (!plan) return applyUnconfiguredProductEvent(tx, event, webhookId, config);

  const owner = await resolveSubscriptionOwner(tx, subscription);
  return syncSubscriptionEvent(tx, event, webhookId, config, owner.userId);
}

async function applyPaymentEvent(
  tx: TransactionType,
  event: UnwrapWebhookEvent,
  config: BillingConfig,
): Promise<{ disposition: string; userId?: string }> {
  if (!event.type.startsWith("payment.")) return { disposition: "ignored_event_type" };
  const payment = event.data as Payment;
  if (!payment.subscription_id) return { disposition: "processed_no_subscription" };

  const [subscription] = await tx
    .select({ userId: billingSubscriptions.userId })
    .from(billingSubscriptions)
    .where(eq(billingSubscriptions.dodoSubscriptionId, payment.subscription_id))
    .limit(1);
  if (!subscription) return { disposition: "processed_subscription_not_seen" };

  if (event.type === "payment.succeeded") {
    const paidAt = new Date(event.timestamp);
    await lockQuotaRow(tx, subscription.userId);
    await tx
      .update(billingSubscriptions)
      .set({ lastPaymentAt: paidAt, updatedAt: new Date() })
      .where(
        and(
          eq(billingSubscriptions.dodoSubscriptionId, payment.subscription_id),
          or(
            isNull(billingSubscriptions.lastPaymentAt),
            lte(billingSubscriptions.lastPaymentAt, paidAt),
          ),
        ),
      );
    await projectEntitlements(tx, subscription.userId, config);
  }
  return { disposition: "processed", userId: subscription.userId };
}

export abstract class BillingService {
  static async reconcileAllEntitlements() {
    const config = parseBillingConfig(process.env);
    if (!config.enabled) return { enabled: false as const, reconciled: 0 };

    const accounts = await db
      .selectDistinct({ userId: billingSubscriptions.userId })
      .from(billingSubscriptions);
    for (const account of accounts) {
      await db.transaction((tx) => projectEntitlements(tx, account.userId, config));
    }
    return { enabled: true as const, reconciled: accounts.length };
  }

  static async summary(userId: string) {
    const config = parseBillingConfig(process.env);

    const [quotaRows, subscriptionRows, customerRows] = await Promise.all([
      db.select({ plan: userQuotas.plan }).from(userQuotas).where(eq(userQuotas.userId, userId)),
      db
        .select({
          plan: billingSubscriptions.plan,
          status: billingSubscriptions.status,
          cancelAtNextBillingDate: billingSubscriptions.cancelAtNextBillingDate,
          nextBillingDate: billingSubscriptions.nextBillingDate,
        })
        .from(billingSubscriptions)
        .where(eq(billingSubscriptions.userId, userId))
        .orderBy(desc(billingSubscriptions.updatedAt)),
      db
        .select({ userId: billingCustomers.userId })
        .from(billingCustomers)
        .where(eq(billingCustomers.userId, userId)),
    ]);

    const planRows = [
      { plan: "starter" as const, configured: true, limits: toPublicLimits(starterLimits) },
      ...paidBillingPlans.flatMap((plan) => {
        const configured = config.plans[plan];
        return configured ? [{ plan, configured: true, limits: toPublicLimits(configured) }] : [];
      }),
    ];
    const subscription =
      subscriptionRows.find((row) => checkoutBlockingStatuses.has(row.status)) ??
      subscriptionRows[0];

    return {
      provider: "dodo_payments" as const,
      enabled: config.enabled,
      current_plan: quotaRows[0]?.plan ?? ("starter" as const),
      plans: planRows,
      subscription: subscription
        ? {
            plan: subscription.plan as PaidBillingPlan,
            status: subscription.status,
            cancel_at_next_billing_date: subscription.cancelAtNextBillingDate,
            next_billing_date: subscription.nextBillingDate?.toISOString() ?? null,
          }
        : null,
      can_manage_billing: customerRows.length > 0,
    };
  }

  static async createCheckout(userId: string, input: CheckoutInput) {
    const config = requireEnabledBillingConfig();
    const plan = config.plans[input.plan];
    if (!plan) throw status(404, "That billing plan is not configured");

    const now = new Date();
    const preparation = await db.transaction(async (tx) => {
      await ensureQuotaRow(tx, userId);
      await tx
        .select({ userId: userQuotas.userId })
        .from(userQuotas)
        .where(eq(userQuotas.userId, userId))
        .for("update");

      const active = await tx
        .select({ status: billingSubscriptions.status })
        .from(billingSubscriptions)
        .where(
          and(
            eq(billingSubscriptions.userId, userId),
            inArray(billingSubscriptions.status, [...checkoutBlockingStatuses]),
          ),
        )
        .limit(1);
      if (active.length) {
        throw status(409, "An existing subscription must be managed from the billing portal");
      }

      const [existing] = await tx
        .select()
        .from(billingCheckoutSessions)
        .where(eq(billingCheckoutSessions.userId, userId))
        .limit(1);
      if (
        existing?.requestKey === input.request_key &&
        existing?.plan === input.plan &&
        existing.status === "ready" &&
        existing.expiresAt > now &&
        existing.checkoutUrl &&
        existing.dodoSessionId
      ) {
        return {
          reused: true as const,
          checkoutUrl: existing.checkoutUrl,
          sessionId: existing.dodoSessionId,
        };
      }
      if (
        existing &&
        existing.expiresAt > now &&
        checkoutSessionBlockingStatuses.has(existing.status)
      ) {
        throw status(409, "A checkout is already in progress for this account");
      }

      const [user] = await tx
        .select({ id: users.id, email: users.email, name: users.name })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!user) throw status(404, "Account not found");
      const [customer] = await tx
        .select({ customerId: billingCustomers.dodoCustomerId })
        .from(billingCustomers)
        .where(eq(billingCustomers.userId, userId))
        .limit(1);

      await tx
        .insert(billingCheckoutSessions)
        .values({
          userId,
          requestKey: input.request_key,
          plan: input.plan,
          status: "creating",
          expiresAt: new Date(now.getTime() + CHECKOUT_CREATING_TTL_MS),
        })
        .onConflictDoUpdate({
          target: billingCheckoutSessions.userId,
          set: {
            requestKey: input.request_key,
            plan: input.plan,
            status: "creating",
            dodoSessionId: null,
            checkoutUrl: null,
            expiresAt: new Date(now.getTime() + CHECKOUT_CREATING_TTL_MS),
            updatedAt: now,
          },
        });
      return { reused: false as const, user, customerId: customer?.customerId };
    });

    if (preparation.reused) {
      return {
        checkout_url: preparation.checkoutUrl,
        session_id: preparation.sessionId,
        reused: true,
      };
    }

    try {
      const checkout = await clientFor(config).checkoutSessions.create({
        product_cart: [{ product_id: plan.productId, quantity: 1 }],
        customer: preparation.customerId
          ? { customer_id: preparation.customerId }
          : { email: preparation.user.email, name: preparation.user.name },
        return_url: config.returnUrl,
        cancel_url: config.cancelUrl,
        metadata: {
          farlands_user_id: userId,
          farlands_plan: input.plan,
          farlands_request_key: input.request_key,
        },
        subscription_data: { trial_period_days: 0 },
        feature_flags: {
          redirect_immediately: true,
          allow_customer_editing_email: false,
          allow_customer_editing_name: false,
          always_create_new_customer: false,
        },
      });
      const checkoutUrl = providerHttpsUrl(checkout.checkout_url, "checkout URL");

      const stored = await db
        .update(billingCheckoutSessions)
        .set({
          status: "ready",
          dodoSessionId: checkout.session_id,
          checkoutUrl,
          expiresAt: new Date(Date.now() + CHECKOUT_READY_TTL_MS),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(billingCheckoutSessions.userId, userId),
            eq(billingCheckoutSessions.requestKey, input.request_key),
            eq(billingCheckoutSessions.status, "creating"),
          ),
        )
        .returning({ userId: billingCheckoutSessions.userId });
      if (!stored.length) throw new Error("Billing checkout lease was lost");

      return {
        checkout_url: checkoutUrl,
        session_id: checkout.session_id,
        reused: false,
      };
    } catch (error) {
      const providerError = providerErrorSummary(error);
      const isDefinitiveFailure = isDefinitiveCheckoutFailure(providerError.status);
      await db
        .update(billingCheckoutSessions)
        .set({
          status: isDefinitiveFailure ? "failed" : "indeterminate",
          expiresAt: isDefinitiveFailure
            ? new Date()
            : new Date(Date.now() + CHECKOUT_READY_TTL_MS),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(billingCheckoutSessions.userId, userId),
            eq(billingCheckoutSessions.requestKey, input.request_key),
            eq(billingCheckoutSessions.status, "creating"),
          ),
        );
      console.error("Dodo checkout creation failed", providerError);
      throw status(502, "Billing checkout is temporarily unavailable");
    }
  }

  static async createPortal(userId: string) {
    const config = requireEnabledBillingConfig();
    const [customer] = await db
      .select({ customerId: billingCustomers.dodoCustomerId })
      .from(billingCustomers)
      .where(eq(billingCustomers.userId, userId))
      .limit(1);
    if (!customer) throw status(409, "No billing account exists yet");

    try {
      const portal = await clientFor(config).customers.customerPortal.create(customer.customerId, {
        return_url: config.portalReturnUrl,
        send_email: false,
      });
      return { portal_url: providerHttpsUrl(portal.link, "customer portal URL") };
    } catch (error) {
      console.error("Dodo customer portal creation failed", providerErrorSummary(error));
      throw status(502, "Billing portal is temporarily unavailable");
    }
  }

  static unwrapWebhook(rawBody: string, headers: Record<string, string>) {
    const config = requireEnabledBillingConfig();
    return clientFor(config).webhooks.unwrap(rawBody, { headers, key: config.webhookKey });
  }

  static async processWebhook({ webhookId, rawBody, event }: WebhookDelivery) {
    const config = requireEnabledBillingConfig();
    if (event.business_id !== config.businessId) throw status(403, "Webhook business mismatch");
    const eventTimestamp = new Date(event.timestamp);
    if (Number.isNaN(eventTimestamp.getTime())) throw status(400, "Invalid webhook timestamp");

    return db.transaction(async (tx) => {
      const claimed = await tx
        .insert(billingWebhookEvents)
        .values({
          webhookId,
          eventType: event.type,
          businessId: event.business_id,
          eventTimestamp,
          objectId: eventObjectId(event),
          payloadSha256: createHash("sha256").update(rawBody).digest("hex"),
        })
        .onConflictDoNothing()
        .returning({ webhookId: billingWebhookEvents.webhookId });
      if (!claimed.length) return { received: true as const, duplicate: true as const };

      const result = isSubscriptionEvent(event)
        ? await applySubscriptionEvent(tx, event, webhookId, config)
        : await applyPaymentEvent(tx, event, config);
      await tx
        .update(billingWebhookEvents)
        .set({ disposition: result.disposition, processedAt: new Date() })
        .where(eq(billingWebhookEvents.webhookId, webhookId));
      return { received: true as const, duplicate: false as const };
    });
  }
}
