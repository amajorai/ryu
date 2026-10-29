// packages/services/src/webhooks/index.ts
//
// `@ryuhq/services/webhooks`: edge-safe webhook verification. WebCrypto only:
// no client code and no `node:*`, so it runs on Node 18+, Bun, Deno,
// Cloudflare Workers and Vercel Edge. `ryu.webhooks.verify` dispatches to
// {@link verifyWebhook}.
//
// Always verify the raw request body (`await request.text()`).

import { type MailWebhookEvent, verifyMailWebhook } from "./mail.ts";
import {
	type MessagingWebhookEvent,
	verifyMessagingWebhook,
} from "./messaging.ts";
import { type NotifyWebhookDelivery, verifyNotifyWebhook } from "./notify.ts";
import type { StandardWebhookScheme, WebhookHeaders } from "./standard.ts";

export {
	type RyuWebhookVerificationCode,
	RyuWebhookVerificationError,
} from "../errors.ts";
export {
	DEFAULT_WEBHOOK_MAX_BODY_BYTES,
	type MailWebhookHandlerOptions,
	type MessagingWebhookHandlerOptions,
	type NotifyWebhookHandlerOptions,
	type WebhookHandlerOptions,
	webhookHandler,
} from "./handler.ts";
export {
	isKnownMailWebhookEvent,
	type KnownMailWebhookEvent,
	MAIL_EVENT_TYPES,
	type MailEventType,
	type MailWebhookEvent,
	type MailWebhookEventData,
	parseMailWebhookEvent,
	type UnknownMailWebhookEvent,
	type VerifyMailWebhookOptions,
	verifyMailWebhook,
} from "./mail.ts";
export {
	isKnownMessagingWebhookEvent,
	type KnownMessagingWebhookEvent,
	MESSAGING_EVENT_TYPES,
	type MessagingEventType,
	type MessagingMessageEventType,
	type MessagingNumberEventType,
	type MessagingWebhookEvent,
	type MessagingWebhookMessage,
	type MessagingWebhookNumber,
	parseMessagingWebhookEvent,
	type UnknownMessagingWebhookEvent,
	type VerifyMessagingWebhookOptions,
	verifyMessagingWebhook,
} from "./messaging.ts";
export {
	type NotifyWebhookDelivery,
	type NotifyWebhookKind,
	type VerifyNotifyWebhookOptions,
	verifyNotifyWebhook,
} from "./notify.ts";
export {
	DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
	MAX_WEBHOOK_TOLERANCE_SECONDS,
	type StandardWebhookScheme,
	type VerifyStandardWebhookOptions,
	verifyStandardWebhook,
	type WebhookHeaders,
} from "./standard.ts";

/** Services whose deliveries {@link verifyWebhook} verifies. */
export type WebhookService = "mail" | "notify" | "messaging";

/** Options for {@link verifyWebhook}. */
export interface VerifyWebhookOptions {
	/**
	 * Notify destinations only: accept the replayable body-only
	 * `x-ryu-notify-signature` when the `webhook-*` headers are absent. Default
	 * false: such a delivery is refused. See `VerifyNotifyWebhookOptions`.
	 */
	allowBodyOnlySignature?: boolean;
	headers: WebhookHeaders;
	/** Notify only: a channel destination delivery (default) or a response callback. */
	kind?: "destination" | "callback";
	/** Clock override for timestamp checks. */
	now?: Date;
	/** The raw request body (`await request.text()`), never re-serialized JSON. */
	payload: string | Uint8Array;
	/**
	 * Notify destinations only: refuse a delivery without the Standard Webhooks
	 * `webhook-*` headers instead of falling back to the body-only signature.
	 * Default true; `false` is the same opt-in as `allowBodyOnlySignature`.
	 */
	requireTimestamp?: boolean;
	/** Mail only: `legacy` for a webhook created before Standard Webhooks signing. */
	scheme?: StandardWebhookScheme;
	secret: string;
	service: WebhookService;
	/** Accepted clock skew; default 300 seconds. */
	toleranceSeconds?: number;
}

/**
 * Verifies a delivery from `service` and resolves to its parsed body: a
 * {@link MailWebhookEvent} for Mail, a {@link NotifyWebhookDelivery} for
 * Notify, a {@link MessagingWebhookEvent} for Messaging. Rejects with
 * RyuWebhookVerificationError on any failure.
 */
export function verifyWebhook(
	options: VerifyWebhookOptions & { service: "mail" }
): Promise<MailWebhookEvent>;
export function verifyWebhook(
	options: VerifyWebhookOptions & { service: "notify" }
): Promise<NotifyWebhookDelivery>;
export function verifyWebhook(
	options: VerifyWebhookOptions & { service: "messaging" }
): Promise<MessagingWebhookEvent>;
export function verifyWebhook(
	options: VerifyWebhookOptions
): Promise<MailWebhookEvent | NotifyWebhookDelivery | MessagingWebhookEvent>;
export function verifyWebhook(
	options: VerifyWebhookOptions
): Promise<MailWebhookEvent | NotifyWebhookDelivery | MessagingWebhookEvent> {
	const { headers, now, payload, secret, toleranceSeconds } = options;
	if (options.service === "messaging") {
		return verifyMessagingWebhook({
			headers,
			now,
			payload,
			secret,
			toleranceSeconds,
		});
	}
	if (options.service === "mail") {
		return verifyMailWebhook({
			headers,
			now,
			payload,
			secret,
			toleranceSeconds,
			scheme: options.scheme,
		});
	}
	return verifyNotifyWebhook({
		headers,
		now,
		payload,
		secret,
		toleranceSeconds,
		kind: options.kind ?? "destination",
		allowBodyOnlySignature: options.allowBodyOnlySignature,
		requireTimestamp: options.requireTimestamp,
	});
}
