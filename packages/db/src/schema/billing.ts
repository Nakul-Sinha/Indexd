import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { users } from "./auth";
import { planEnum } from "./enums";

/**
 * Stable Dodo customer ownership. The provider customer id is never accepted
 * from a browser request; it is learned from a verified webhook instead.
 */
export const billingCustomers = pgTable("billing_customers", {
  userId: text("user_id")
    .primaryKey()
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  dodoCustomerId: text("dodo_customer_id").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * Provider state is kept separately from user_quotas. Webhooks update this
 * ledger first, then project the highest active plan into user_quotas in the
 * same transaction.
 */
export const billingSubscriptions = pgTable(
  "billing_subscriptions",
  {
    dodoSubscriptionId: text("dodo_subscription_id").primaryKey().notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    dodoCustomerId: text("dodo_customer_id").notNull(),
    dodoProductId: text("dodo_product_id").notNull(),
    plan: planEnum("plan").notNull(),
    status: text("status").notNull(),
    cancelAtNextBillingDate: boolean("cancel_at_next_billing_date").notNull().default(false),
    trialPeriodDays: integer("trial_period_days").notNull().default(0),
    previousBillingDate: timestamp("previous_billing_date", { withTimezone: true }),
    nextBillingDate: timestamp("next_billing_date", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    lastPaymentAt: timestamp("last_payment_at", { withTimezone: true }),
    lastWebhookId: text("last_webhook_id").notNull(),
    lastEventTimestamp: timestamp("last_event_timestamp", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("billing_subscriptions_user_status_idx").on(table.userId, table.status),
    index("billing_subscriptions_customer_idx").on(table.dodoCustomerId),
  ],
);

/**
 * Dodo retries deliveries and does not guarantee their order. Claiming the
 * Standard Webhooks delivery id transactionally makes processing idempotent.
 * Raw payloads are deliberately not retained because they contain billing PII.
 */
export const billingWebhookEvents = pgTable(
  "billing_webhook_events",
  {
    webhookId: text("webhook_id").primaryKey().notNull(),
    eventType: text("event_type").notNull(),
    businessId: text("business_id").notNull(),
    eventTimestamp: timestamp("event_timestamp", { withTimezone: true }).notNull(),
    objectId: text("object_id"),
    payloadSha256: text("payload_sha256").notNull(),
    disposition: text("disposition").notNull().default("processing"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => [
    index("billing_webhook_events_type_received_idx").on(table.eventType, table.receivedAt),
  ],
);

/**
 * One checkout slot per user prevents parallel clicks from creating multiple
 * subscriptions. request_key makes a browser retry return the same hosted URL.
 */
export const billingCheckoutSessions = pgTable(
  "billing_checkout_sessions",
  {
    userId: text("user_id")
      .primaryKey()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requestKey: text("request_key").notNull(),
    plan: planEnum("plan").notNull(),
    status: text("status").notNull().default("creating"),
    dodoSessionId: text("dodo_session_id"),
    checkoutUrl: text("checkout_url"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex("billing_checkout_sessions_dodo_session_idx").on(table.dodoSessionId)],
);
