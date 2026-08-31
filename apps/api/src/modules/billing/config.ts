import { z } from "zod";

export const paidBillingPlans = ["standard", "pro"] as const;
export type PaidBillingPlan = (typeof paidBillingPlans)[number];
export type BillingPlan = "starter" | PaidBillingPlan;

export type BillingLimits = {
  serversLimit: number;
  ramLimitMb: number;
  cpuLimit: number;
  storageLimitGb: number;
  backupsLimit: number;
};

export type PaidPlanConfig = BillingLimits & {
  productId: string;
};

export const starterLimits: BillingLimits = {
  serversLimit: 1,
  ramLimitMb: 2048,
  cpuLimit: 2,
  storageLimitGb: 5,
  backupsLimit: 3,
};

const planConfigSchema = z
  .object({
    productId: z.string().min(1),
    serversLimit: z.number().int().positive(),
    ramLimitMb: z.number().int().positive(),
    cpuLimit: z.number().positive(),
    storageLimitGb: z.number().int().positive(),
    backupsLimit: z.number().int().nonnegative(),
  })
  .strict();

const planCatalogSchema = z
  .object({
    standard: planConfigSchema.optional(),
    pro: planConfigSchema.optional(),
  })
  .strict()
  .refine((catalog) => catalog.standard || catalog.pro, {
    message: "At least one paid plan must be configured",
  })
  .refine(
    (catalog) => {
      const productIds = Object.values(catalog)
        .filter((plan): plan is PaidPlanConfig => Boolean(plan))
        .map((plan) => plan.productId);
      return new Set(productIds).size === productIds.length;
    },
    { message: "Each paid plan must use a different Dodo product id" },
  );

const environmentSchema = z.enum(["test_mode", "live_mode"]);

type BillingEnvironment = z.infer<typeof environmentSchema>;

export type BillingConfig = {
  enabled: boolean;
  apiKey: string | null;
  webhookKey: string | null;
  businessId: string | null;
  environment: BillingEnvironment;
  returnUrl: string | null;
  cancelUrl: string | null;
  portalReturnUrl: string | null;
  plans: Partial<Record<PaidBillingPlan, PaidPlanConfig>>;
};

const billingKeys = [
  "DODO_PAYMENTS_API_KEY",
  "DODO_PAYMENTS_WEBHOOK_KEY",
  "DODO_PAYMENTS_BUSINESS_ID",
  "DODO_PAYMENTS_ENVIRONMENT",
  "DODO_PAYMENTS_RETURN_URL",
  "DODO_PAYMENTS_CANCEL_URL",
  "DODO_PAYMENTS_PORTAL_RETURN_URL",
  "DODO_PAYMENTS_PLAN_CATALOG",
] as const;

export class BillingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingConfigError";
  }
}

function requiredValue(env: NodeJS.ProcessEnv, key: (typeof billingKeys)[number]): string {
  const value = env[key]?.trim();
  if (!value) throw new BillingConfigError(`${key} is required when Dodo Payments is configured`);
  return value;
}

function absoluteUrl(value: string, key: string): string {
  try {
    const url = new URL(value);
    const isLocalHttp = url.protocol === "http:" && url.hostname === "localhost";
    if (url.protocol !== "https:" && !isLocalHttp) throw new Error();
    return url.toString();
  } catch {
    throw new BillingConfigError(`${key} must be an absolute HTTPS URL (localhost is allowed)`);
  }
}

export function parseBillingConfig(env: NodeJS.ProcessEnv): BillingConfig {
  const anyConfigured = billingKeys.some((key) => Boolean(env[key]?.trim()));
  if (!anyConfigured) {
    return {
      enabled: false,
      apiKey: null,
      webhookKey: null,
      businessId: null,
      environment: "test_mode",
      returnUrl: null,
      cancelUrl: null,
      portalReturnUrl: null,
      plans: {},
    };
  }

  const rawCatalog = requiredValue(env, "DODO_PAYMENTS_PLAN_CATALOG");
  let parsedCatalog: unknown;
  try {
    parsedCatalog = JSON.parse(rawCatalog);
  } catch {
    throw new BillingConfigError("DODO_PAYMENTS_PLAN_CATALOG must be valid JSON");
  }

  const catalog = planCatalogSchema.safeParse(parsedCatalog);
  if (!catalog.success) {
    throw new BillingConfigError(
      `Invalid DODO_PAYMENTS_PLAN_CATALOG: ${catalog.error.issues[0]?.message}`,
    );
  }

  const environment = environmentSchema.safeParse(requiredValue(env, "DODO_PAYMENTS_ENVIRONMENT"));
  if (!environment.success) {
    throw new BillingConfigError("DODO_PAYMENTS_ENVIRONMENT must be either test_mode or live_mode");
  }

  return {
    enabled: true,
    apiKey: requiredValue(env, "DODO_PAYMENTS_API_KEY"),
    webhookKey: requiredValue(env, "DODO_PAYMENTS_WEBHOOK_KEY"),
    businessId: requiredValue(env, "DODO_PAYMENTS_BUSINESS_ID"),
    environment: environment.data,
    returnUrl: absoluteUrl(
      requiredValue(env, "DODO_PAYMENTS_RETURN_URL"),
      "DODO_PAYMENTS_RETURN_URL",
    ),
    cancelUrl: absoluteUrl(
      requiredValue(env, "DODO_PAYMENTS_CANCEL_URL"),
      "DODO_PAYMENTS_CANCEL_URL",
    ),
    portalReturnUrl: absoluteUrl(
      requiredValue(env, "DODO_PAYMENTS_PORTAL_RETURN_URL"),
      "DODO_PAYMENTS_PORTAL_RETURN_URL",
    ),
    plans: catalog.data,
  };
}

export function planForProduct(config: BillingConfig, productId: string): PaidBillingPlan | null {
  for (const plan of paidBillingPlans) {
    if (config.plans[plan]?.productId === productId) return plan;
  }
  return null;
}

export function requireEnabledBillingConfig(): BillingConfig & {
  enabled: true;
  apiKey: string;
  webhookKey: string;
  businessId: string;
  returnUrl: string;
  cancelUrl: string;
  portalReturnUrl: string;
} {
  const config = parseBillingConfig(process.env);
  if (
    !config.enabled ||
    !config.apiKey ||
    !config.webhookKey ||
    !config.businessId ||
    !config.returnUrl ||
    !config.cancelUrl ||
    !config.portalReturnUrl
  ) {
    throw new BillingConfigError("Dodo Payments is not configured");
  }
  return config as BillingConfig & {
    enabled: true;
    apiKey: string;
    webhookKey: string;
    businessId: string;
    returnUrl: string;
    cancelUrl: string;
    portalReturnUrl: string;
  };
}
