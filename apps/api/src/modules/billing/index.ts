import {
  BillingCheckoutRequest,
  BillingCheckoutResponse,
  BillingPortalResponse,
  BillingSummaryResponse,
} from "@farlands/contracts";
import { Elysia, status } from "elysia";

import { AuthService } from "../auth/service";
import { BillingConfigError } from "./config";
import { BillingService } from "./service";

const MAX_WEBHOOK_BYTES = 1024 * 1024;

class WebhookPayloadTooLargeError extends Error {}

async function readWebhookBody(request: Request): Promise<string> {
  const declaredBytes = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_WEBHOOK_BYTES) {
    throw new WebhookPayloadTooLargeError();
  }

  const reader = request.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_WEBHOOK_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new WebhookPayloadTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function unavailableOnConfigError(error: unknown): never {
  if (error instanceof BillingConfigError) throw status(503, "Billing is not configured");
  throw error;
}

export const billingWebhookModule = new Elysia({ name: "dodo-billing-webhook" }).post(
  "/api/webhooks/dodo",
  async ({ request, headers, set }) => {
    const webhookId = headers["webhook-id"];
    const webhookSignature = headers["webhook-signature"];
    const webhookTimestamp = headers["webhook-timestamp"];
    if (!webhookId || !webhookSignature || !webhookTimestamp) {
      set.status = 400;
      return { received: false, error: "Missing Standard Webhooks headers" };
    }

    let rawBody: string;
    try {
      rawBody = await readWebhookBody(request);
    } catch (error) {
      if (error instanceof WebhookPayloadTooLargeError) {
        set.status = 413;
        return { received: false, error: "Webhook payload is too large" };
      }
      throw error;
    }

    let event;
    try {
      event = BillingService.unwrapWebhook(rawBody, {
        "webhook-id": webhookId,
        "webhook-signature": webhookSignature,
        "webhook-timestamp": webhookTimestamp,
      });
    } catch (error) {
      if (error instanceof BillingConfigError) {
        set.status = 503;
        return { received: false, error: "Billing is not configured" };
      }
      set.status = 401;
      return { received: false, error: "Invalid webhook signature" };
    }

    try {
      return await BillingService.processWebhook({ webhookId, rawBody, event });
    } catch (error) {
      if (error instanceof BillingConfigError) {
        set.status = 503;
        return { received: false, error: "Billing is not configured" };
      }
      throw error;
    }
  },
  { parse: "none" },
);

export const billingModule = new Elysia({ prefix: "/api/billing" })
  .derive(async ({ headers }) => ({
    userId: await AuthService.requireUserId(headers.cookie ?? ""),
  }))
  .get(
    "/",
    async ({ userId }) => {
      try {
        return await BillingService.summary(userId);
      } catch (error) {
        return unavailableOnConfigError(error);
      }
    },
    { response: BillingSummaryResponse },
  )
  .post(
    "/checkout",
    async ({ userId, body }) => {
      try {
        return await BillingService.createCheckout(userId, body);
      } catch (error) {
        return unavailableOnConfigError(error);
      }
    },
    { body: BillingCheckoutRequest, response: BillingCheckoutResponse },
  )
  .post(
    "/portal",
    async ({ userId }) => {
      try {
        return await BillingService.createPortal(userId);
      } catch (error) {
        return unavailableOnConfigError(error);
      }
    },
    { response: BillingPortalResponse },
  );
