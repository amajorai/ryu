import { WebhookCustomerSeatAssignedPayload$inboundSchema } from "@polar-sh/sdk/models/components/webhookcustomerseatassignedpayload";
import { WebhookCustomerSeatClaimedPayload$inboundSchema } from "@polar-sh/sdk/models/components/webhookcustomerseatclaimedpayload";
import { WebhookCustomerSeatRevokedPayload$inboundSchema } from "@polar-sh/sdk/models/components/webhookcustomerseatrevokedpayload";
import { WebhookCustomerStateChangedPayload$inboundSchema } from "@polar-sh/sdk/models/components/webhookcustomerstatechangedpayload";
import { WebhookOrderPaidPayload$inboundSchema } from "@polar-sh/sdk/models/components/webhookorderpaidpayload";
import { WebhookOrderRefundedPayload$inboundSchema } from "@polar-sh/sdk/models/components/webhookorderrefundedpayload";
import { WebhookRefundCreatedPayload$inboundSchema } from "@polar-sh/sdk/models/components/webhookrefundcreatedpayload";
import { WebhookRefundUpdatedPayload$inboundSchema } from "@polar-sh/sdk/models/components/webhookrefundupdatedpayload";
import { WebhookSubscriptionActivePayload$inboundSchema } from "@polar-sh/sdk/models/components/webhooksubscriptionactivepayload";
import { WebhookSubscriptionCanceledPayload$inboundSchema } from "@polar-sh/sdk/models/components/webhooksubscriptioncanceledpayload";
import { WebhookSubscriptionCreatedPayload$inboundSchema } from "@polar-sh/sdk/models/components/webhooksubscriptioncreatedpayload";
import { WebhookSubscriptionRevokedPayload$inboundSchema } from "@polar-sh/sdk/models/components/webhooksubscriptionrevokedpayload";
import { WebhookSubscriptionUpdatedPayload$inboundSchema } from "@polar-sh/sdk/models/components/webhooksubscriptionupdatedpayload";
import {
	WebhookVerificationError as PolarSdkWebhookVerificationError,
	validateEvent as polarValidateEvent,
} from "@polar-sh/sdk/webhooks";
import {
	WebhookVerificationError as StandardWebhookVerificationError,
	Webhook,
} from "standardwebhooks";
import { z } from "zod";

/**
 * The one verification error type the API route handles as HTTP 400.
 *
 * Polar's SDK and `standardwebhooks` expose different error classes even though
 * both represent an invalid signature or timestamp. Keeping one class at this
 * boundary prevents the server route from depending on which secret format was
 * configured.
 */
export class UnifiedPolarWebhookVerificationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PolarWebhookVerificationError";
	}
}

export {
	UnifiedPolarWebhookVerificationError as PolarWebhookVerificationError,
};

/** The header shape emitted by Polar's Standard Webhooks delivery. */
export type PolarWebhookHeaders = Record<string, string>;

/**
 * Parse only event shapes consumed by the current billing handler, using the
 * generated Polar SDK schemas so snake_case wire fields are remapped to the
 * camelCase objects the interpreters already consume. Signed but unsupported
 * event types remain a parse error and are acknowledged by the existing route.
 */
const eventEnvelopeSchema = z.preprocess(
	(value) => value,
	z.object({ type: z.string() })
);
function parsePolarWebhookPayload(
	payload: z.input<typeof eventEnvelopeSchema>
) {
	const { type } = eventEnvelopeSchema.parse(payload);
	switch (type) {
		case "customer.state_changed":
			return WebhookCustomerStateChangedPayload$inboundSchema.parse(payload);
		case "customer_seat.assigned":
			return WebhookCustomerSeatAssignedPayload$inboundSchema.parse(payload);
		case "customer_seat.claimed":
			return WebhookCustomerSeatClaimedPayload$inboundSchema.parse(payload);
		case "customer_seat.revoked":
			return WebhookCustomerSeatRevokedPayload$inboundSchema.parse(payload);
		case "order.paid":
			return WebhookOrderPaidPayload$inboundSchema.parse(payload);
		case "order.refunded":
			return WebhookOrderRefundedPayload$inboundSchema.parse(payload);
		case "refund.created":
			return WebhookRefundCreatedPayload$inboundSchema.parse(payload);
		case "refund.updated":
			return WebhookRefundUpdatedPayload$inboundSchema.parse(payload);
		case "subscription.active":
			return WebhookSubscriptionActivePayload$inboundSchema.parse(payload);
		case "subscription.canceled":
			return WebhookSubscriptionCanceledPayload$inboundSchema.parse(payload);
		case "subscription.created":
			return WebhookSubscriptionCreatedPayload$inboundSchema.parse(payload);
		case "subscription.revoked":
			return WebhookSubscriptionRevokedPayload$inboundSchema.parse(payload);
		case "subscription.updated":
			return WebhookSubscriptionUpdatedPayload$inboundSchema.parse(payload);
		default:
			throw new Error(`Unsupported Polar webhook event type: ${String(type)}`);
	}
}

const isVerificationError = z
	.unknown()
	.transform(
		(error) =>
			error instanceof StandardWebhookVerificationError ||
			error instanceof PolarSdkWebhookVerificationError ||
			(error instanceof Error && error.name === "WebhookVerificationError")
	).parse;
const unifiedVerificationError = z
	.unknown()
	.transform(
		(error) =>
			new UnifiedPolarWebhookVerificationError(
				error instanceof Error
					? error.message
					: "Polar webhook verification failed"
			)
	).parse;

/**
 * Verify and parse a Polar delivery.
 *
 * New Polar API webhook secrets are `whsec_` keys whose suffix is already the
 * Standard Webhooks base64 key. The SDK's `validateEvent` treats every secret as
 * UTF-8 text and base64-encodes it again, which invalidates non-UTF-8 Polar keys.
 * Keep that SDK path for legacy raw secrets and use the Standard Webhooks
 * verifier directly for the new format.
 */
export function validatePolarEvent(
	body: string | Buffer,
	headers: PolarWebhookHeaders,
	secret: string
) {
	if (secret.startsWith("whsec_")) {
		try {
			const payload = new Webhook(secret).verify(body, headers);
			return parsePolarWebhookPayload(payload);
		} catch (error) {
			if (isVerificationError(error)) {
				throw unifiedVerificationError(error);
			}
			throw error;
		}
	}

	try {
		return polarValidateEvent(body, headers, secret);
	} catch (error) {
		if (isVerificationError(error)) {
			throw unifiedVerificationError(error);
		}
		throw error;
	}
}
