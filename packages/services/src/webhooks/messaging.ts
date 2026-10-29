// packages/services/src/webhooks/messaging.ts
//
// Typed Ryu Messaging deliveries. The control plane
// (packages/api/src/lib/messaging-webhooks.ts) posts one body,
// `{type:"event", event_type, event_id, data}`, to the organization's webhook
// URL, signed exactly like hosted Mail: Standard Webhooks headers
// (`webhook-id`, `webhook-timestamp`, `webhook-signature`, repeated as
// `svix-*`) over `${id}.${timestamp}.${rawBody}`, keyed by the base64 part of
// the `whsec_` secret. MESSAGING_EVENT_TYPES is a copy of the server's
// MESSAGING_WEBHOOK_EVENT_TYPES, kept in lockstep by messaging.test.ts; it is
// copied, not imported, so this edge-safe entry point loads no server or
// client code. The message and number shapes are copies of `@ryuhq/client`'s
// MessagingMessage and MessagingNumber, checked equal by messaging.test.ts.
//
// Forward compatibility: a verified event whose `event_type` is newer than
// this copy is returned as an UnknownMessagingWebhookEvent, never rejected.
// Each event is delivered at most once per organization, with up to three
// attempts a few hundred milliseconds apart; dedupe on `event_id`, which
// equals `webhook-id`.

import {
	type VerifyStandardWebhookOptions,
	verifyStandardWebhook,
	webhookError,
} from "./standard.ts";

/** Every Messaging event type a webhook can receive (lockstep with the server). */
export const MESSAGING_EVENT_TYPES = [
	"message.received",
	"message.delivered",
	"message.failed",
	"number.suspended",
	"number.released",
] as const;

/** One of {@link MESSAGING_EVENT_TYPES}. */
export type MessagingEventType = (typeof MESSAGING_EVENT_TYPES)[number];

/** The message events, whose `data` is `{ message }`. */
export type MessagingMessageEventType =
	| "message.received"
	| "message.delivered"
	| "message.failed";

/** The number events, whose `data` is `{ number }`. */
export type MessagingNumberEventType = "number.suspended" | "number.released";

/** A message as webhooks carry it (`@ryuhq/client` MessagingMessage). Money is in micro-USD. */
export interface MessagingWebhookMessage {
	absorbedMicroUsd: number;
	body: string | null;
	bodyType: "text" | "ssml" | "template" | "media";
	channel: "sms" | "mms" | "voice" | "whatsapp";
	chargedMicroUsd: number;
	chargeState:
		| "none"
		| "held"
		| "settling"
		| "settled"
		| "released"
		| "absorbed";
	createdAt: string;
	direction: "outbound" | "inbound";
	encoding: "GSM" | "UCS2" | null;
	error: string | null;
	estimated: boolean;
	from: string;
	hasMedia: boolean;
	heldMicroUsd: number;
	id: string;
	isoCountryCode: string | null;
	metadata: Record<string, string>;
	numberId: string | null;
	organizationId: string;
	priceMicroUsd: number | null;
	providerMessageId: string | null;
	providerStatus: string | null;
	providerStatusDescription: string | null;
	segments: number;
	status:
		| "queued"
		| "sending"
		| "accepted"
		| "delivered"
		| "failed"
		| "unresolved"
		| "refused"
		| "received";
	template: { language: string | null; name: string | null } | null;
	to: string;
	ttlSeconds: number | null;
	updatedAt: string;
	whatsappSenderId: string | null;
}

/** A leased number as webhooks carry it (`@ryuhq/client` MessagingNumber). */
export interface MessagingWebhookNumber {
	capabilities: ("SMS" | "VOICE" | "MMS")[];
	createdAt: string;
	currentPeriodEndsAt: string | null;
	error: string | null;
	graceEndsAt: string | null;
	id: string;
	isoCountryCode: string;
	label: string | null;
	leasePeriod: number;
	messageType: "TRANSACTIONAL" | "PROMOTIONAL";
	monthlyLeaseMicroUsd: number;
	numberType: "LONG_CODE" | "TOLL_FREE" | "TEN_DLC" | "SIMULATOR";
	organizationId: string;
	phoneNumber: string | null;
	registrationId: string | null;
	releasedAt: string | null;
	status:
		| "pending"
		| "active"
		| "suspended"
		| "releasing"
		| "released"
		| "failed";
	suspendedAt: string | null;
	twoWayEnabled: boolean;
	updatedAt: string;
}

interface MessagingEventEnvelope {
	/** Deterministic per provider event; also the `webhook-id` header. Dedupe on it. */
	event_id: string;
	type: "event";
}

/** A verified delivery of a type this SDK knows, discriminated on `event_type`. */
export type KnownMessagingWebhookEvent =
	| (MessagingEventEnvelope & {
			data: { message: MessagingWebhookMessage };
			event_type: MessagingMessageEventType;
	  })
	| (MessagingEventEnvelope & {
			data: { number: MessagingWebhookNumber };
			event_type: MessagingNumberEventType;
	  });

/** A verified delivery whose `event_type` is newer than this SDK. Acknowledge it and ignore it. */
export interface UnknownMessagingWebhookEvent extends MessagingEventEnvelope {
	data: Record<string, unknown>;
	event_type: string;
}

/** A verified Messaging delivery; narrow it with {@link isKnownMessagingWebhookEvent}. */
export type MessagingWebhookEvent =
	| KnownMessagingWebhookEvent
	| UnknownMessagingWebhookEvent;

/** Options for {@link verifyMessagingWebhook}. Messaging has no legacy signing scheme. */
export type VerifyMessagingWebhookOptions = Omit<
	VerifyStandardWebhookOptions,
	"scheme" | "service"
>;

const EVENT_TYPES: ReadonlySet<string> = new Set(MESSAGING_EVENT_TYPES);
const MESSAGE_EVENT_TYPES: ReadonlySet<string> = new Set([
	"message.received",
	"message.delivered",
	"message.failed",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when `event.event_type` is one of this SDK's {@link MESSAGING_EVENT_TYPES}. */
export function isKnownMessagingWebhookEvent(
	event: MessagingWebhookEvent
): event is KnownMessagingWebhookEvent {
	return EVENT_TYPES.has(event.event_type);
}

function invalid(message: string): never {
	throw webhookError("messaging", "webhook_payload_invalid", message);
}

/**
 * Narrows a parsed body to a {@link MessagingWebhookEvent}, or throws
 * `webhook_payload_invalid` when the envelope is not
 * `{type:"event", event_type, event_id, data}`, or a known event's `data`
 * lacks its `message` or `number` object. An unknown `event_type` is accepted.
 */
export function parseMessagingWebhookEvent(
	body: unknown
): MessagingWebhookEvent {
	if (
		!(
			isRecord(body) &&
			body.type === "event" &&
			typeof body.event_id === "string" &&
			typeof body.event_type === "string" &&
			isRecord(body.data)
		)
	) {
		invalid('expected {type:"event", event_type, event_id, data}.');
	}
	const { data, event_type: eventType } = body;
	if (!EVENT_TYPES.has(eventType)) {
		return body as unknown as UnknownMessagingWebhookEvent;
	}
	const field = MESSAGE_EVENT_TYPES.has(eventType) ? "message" : "number";
	const resource = data[field];
	if (!(isRecord(resource) && typeof resource.id === "string")) {
		invalid(`the ${eventType} event has no data.${field} object.`);
	}
	return body as unknown as KnownMessagingWebhookEvent;
}

/**
 * Verifies a Ryu Messaging webhook delivery (Standard Webhooks, `whsec_`
 * secret) and resolves to the typed event. Pass the raw body
 * (`await request.text()`). An event type newer than this SDK resolves too;
 * check {@link isKnownMessagingWebhookEvent}.
 *
 * @throws RyuWebhookVerificationError, including `webhook_payload_invalid`
 *   when the signed body is not JSON or not a Messaging event envelope.
 */
export async function verifyMessagingWebhook(
	options: VerifyMessagingWebhookOptions
): Promise<MessagingWebhookEvent> {
	const body = await verifyStandardWebhook({
		...options,
		scheme: "standard",
		service: "messaging",
	});
	return parseMessagingWebhookEvent(body);
}
