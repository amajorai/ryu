// packages/services/src/webhooks/mail.ts
//
// Typed Mail event deliveries. Hosted Mail (packages/api/src/lib/mail-webhooks.ts)
// and self-hosted Mail (apps-store/mail/backend/src/webhooks.rs) post the same
// body, `{type:"event", event_type, event_id, data}`, signed with Standard
// Webhooks. MAIL_EVENT_TYPES is a copy of packages/mail/src/contract.ts, kept
// in lockstep by mail.test.ts; it is copied, not imported, so this edge-safe
// entry point loads no server code.
//
// Forward compatibility: a verified event whose `event_type` is newer than
// this copy is still returned (as an UnknownMailWebhookEvent), never
// rejected, so a server-side addition does not make older SDKs refuse, and
// the sender retry and drop, genuine deliveries.

import {
	type VerifyStandardWebhookOptions,
	verifyStandardWebhook,
	webhookError,
} from "./standard.ts";

/** Every Mail event type a webhook can receive (lockstep with packages/mail/src/contract.ts). */
export const MAIL_EVENT_TYPES = [
	"message.received",
	"message.received.spam",
	"message.received.blocked",
	"message.received.unauthenticated",
	"message.sent",
	"message.delivered",
	"message.bounced",
	"message.complained",
	"message.rejected",
	"message.opened",
	"domain.verified",
] as const;

/** One of {@link MAIL_EVENT_TYPES}. */
export type MailEventType = (typeof MAIL_EVENT_TYPES)[number];

/**
 * The event's `data`. Message events carry the serialized `message` plus
 * delivery details (`recipients`, `reason`, provider fields); `domain.verified`
 * carries the domain. Fields are left open because the server adds them.
 */
export interface MailWebhookEventData {
	message?: Record<string, unknown>;
	reason?: string;
	recipients?: string[];
	[field: string]: unknown;
}

/** A verified Mail delivery of a type this SDK knows, discriminated on `event_type`. */
export type KnownMailWebhookEvent = {
	[Type in MailEventType]: {
		data: MailWebhookEventData;
		/** The event id; also the `webhook-id` header. Dedupe on it: deliveries are retried. */
		event_id: string;
		event_type: Type;
		type: "event";
	};
}[MailEventType];

/**
 * A verified Mail delivery whose `event_type` is newer than this SDK's
 * {@link MAIL_EVENT_TYPES}. It is authentic; ignore it or upgrade
 * `@ryuhq/services` to get its type.
 */
export interface UnknownMailWebhookEvent {
	data: MailWebhookEventData;
	/** The event id; also the `webhook-id` header. Dedupe on it: deliveries are retried. */
	event_id: string;
	event_type: string;
	type: "event";
}

/**
 * A verified Mail delivery. Narrow it with {@link isKnownMailWebhookEvent}
 * before switching exhaustively on `event_type`.
 */
export type MailWebhookEvent = KnownMailWebhookEvent | UnknownMailWebhookEvent;

/** Options for {@link verifyMailWebhook}; `service` is always `mail`. */
export type VerifyMailWebhookOptions = Omit<
	VerifyStandardWebhookOptions,
	"service"
>;

const EVENT_TYPES: ReadonlySet<string> = new Set(MAIL_EVENT_TYPES);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when `event.event_type` is one of this SDK's {@link MAIL_EVENT_TYPES}. */
export function isKnownMailWebhookEvent(
	event: MailWebhookEvent
): event is KnownMailWebhookEvent {
	return EVENT_TYPES.has(event.event_type);
}

/**
 * Narrows a parsed body to a {@link MailWebhookEvent}, or throws
 * `webhook_payload_invalid` when the envelope is not
 * `{type:"event", event_type, event_id, data}`. An unknown `event_type` is
 * accepted (see {@link UnknownMailWebhookEvent}).
 */
export function parseMailWebhookEvent(body: unknown): MailWebhookEvent {
	if (
		!(
			isRecord(body) &&
			body.type === "event" &&
			typeof body.event_id === "string" &&
			typeof body.event_type === "string" &&
			isRecord(body.data)
		)
	) {
		throw webhookError(
			"mail",
			"webhook_payload_invalid",
			'expected {type:"event", event_type, event_id, data}.'
		);
	}
	return body as unknown as MailWebhookEvent;
}

/**
 * Verifies a Mail webhook delivery (Standard Webhooks, or `scheme: "legacy"`
 * for a webhook created before Standard Webhooks signing) and resolves to the
 * typed event. Pass the raw body (`await request.text()`). An event type
 * newer than this SDK resolves too; check {@link isKnownMailWebhookEvent}.
 *
 * @throws RyuWebhookVerificationError, including `webhook_payload_invalid`
 *   when the signed body is not JSON or not a Mail event envelope.
 */
export async function verifyMailWebhook(
	options: VerifyMailWebhookOptions
): Promise<MailWebhookEvent> {
	const body = await verifyStandardWebhook({ ...options, service: "mail" });
	return parseMailWebhookEvent(body);
}
