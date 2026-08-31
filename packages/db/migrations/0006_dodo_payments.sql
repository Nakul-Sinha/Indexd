CREATE TABLE "billing_checkout_sessions" (
	"user_id" text PRIMARY KEY NOT NULL,
	"request_key" text NOT NULL,
	"plan" "plan" NOT NULL,
	"status" text DEFAULT 'creating' NOT NULL,
	"dodo_session_id" text,
	"checkout_url" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_customers" (
	"user_id" text PRIMARY KEY NOT NULL,
	"dodo_customer_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_customers_dodo_customer_id_unique" UNIQUE("dodo_customer_id")
);
--> statement-breakpoint
CREATE TABLE "billing_subscriptions" (
	"dodo_subscription_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"dodo_customer_id" text NOT NULL,
	"dodo_product_id" text NOT NULL,
	"plan" "plan" NOT NULL,
	"status" text NOT NULL,
	"cancel_at_next_billing_date" boolean DEFAULT false NOT NULL,
	"trial_period_days" integer DEFAULT 0 NOT NULL,
	"previous_billing_date" timestamp with time zone,
	"next_billing_date" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"last_payment_at" timestamp with time zone,
	"last_webhook_id" text NOT NULL,
	"last_event_timestamp" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_webhook_events" (
	"webhook_id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"business_id" text NOT NULL,
	"event_timestamp" timestamp with time zone NOT NULL,
	"object_id" text,
	"payload_sha256" text NOT NULL,
	"disposition" text DEFAULT 'processing' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "billing_checkout_sessions" ADD CONSTRAINT "billing_checkout_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_customers" ADD CONSTRAINT "billing_customers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_checkout_sessions_dodo_session_idx" ON "billing_checkout_sessions" USING btree ("dodo_session_id");--> statement-breakpoint
CREATE INDEX "billing_subscriptions_user_status_idx" ON "billing_subscriptions" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "billing_subscriptions_customer_idx" ON "billing_subscriptions" USING btree ("dodo_customer_id");--> statement-breakpoint
CREATE INDEX "billing_webhook_events_type_received_idx" ON "billing_webhook_events" USING btree ("event_type","received_at");
