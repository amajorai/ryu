import { RefundReason } from "@polar-sh/sdk/models/components/refundreason";
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

/** The refund reasons the installed SDK lists, and where an event keeps one. */
const knownRefundReasons = new Set<string>(Object.values(RefundReason));
const refundReasonSchema = z.looseObject({
	type: z.enum(["refund.created", "refund.updated"]),
	data: z.looseObject({ id: z.string().optional(), reason: z.string() }),
});

/**
 * Polar sends refund reasons that the installed SDK's closed list refuses
 * (`tax_refund`, `vat_reverse_charge_correction`, and any value it adds later).
 * One such value fails the whole event, the route answers 400 on every retry,
 * and repeated failures make Polar switch the endpoint off. No reader in the
 * repo acts on the reason, so a reason the SDK does not list is read as
 * `other` and the raw value is logged. Every other field and every other event
 * type stays as strict as before.
 *
 * Call this only with a payload whose signature has already been verified.
 * Returns null when the payload is not a refund event with an unlisted reason.
 */
function unknownRefundReasonAsOther(payload: unknown) {
	const refund = refundReasonSchema.safeParse(payload);
	if (!refund.success || knownRefundReasons.has(refund.data.data.reason)) {
		return null;
	}
	const { data, type } = refund.data;
	console.warn("[polar-webhook] unknown refund reason read as other:", {
		type,
		refundId: data.id,
		rawReason: data.reason.slice(0, 80),
	});
	return { ...refund.data, data: { ...data, reason: RefundReason.Other } };
}

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
			return WebhookRefundCreatedPayload$inboundSchema.parse(
				unknownRefundReasonAsOther(payload) ?? payload
			);
		case "refund.updated":
			return WebhookRefundUpdatedPayload$inboundSchema.parse(
				unknownRefundReasonAsOther(payload) ?? payload
			);
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
 * The legacy path below hands verification and parsing to the SDK in one call,
 * so a refund the SDK refuses never reaches the parser above. That call stays
 * the first and deciding check, and a verification error from it ends the
 * request before this function runs. Only when it fails for another reason
 * does this function verify the same body again with the same key (the base64
 * of the raw secret, as the SDK builds it), so the object parsed here is one
 * whose signature this module checked itself. It accepts a refund event with
 * an unlisted reason and nothing else. For anything else, and on any error,
 * it returns null and the SDK's error stands.
 */
function legacyRefundWithUnknownReason(
	body: string | Buffer,
	headers: PolarWebhookHeaders,
	secret: string
) {
	try {
		const key = Buffer.from(secret, "utf-8").toString("base64");
		const refund = unknownRefundReasonAsOther(
			new Webhook(key).verify(body, headers)
		);
		return refund ? parsePolarWebhookPayload(refund) : null;
	} catch {
		return null;
	}
}

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
		const refund = legacyRefundWithUnknownReason(body, headers, secret);
		if (refund) {
			return refund;
		}
		throw error;
	}
}
