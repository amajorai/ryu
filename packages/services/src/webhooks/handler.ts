// packages/services/src/webhooks/handler.ts
//
// A fetch-style `(Request) => Promise<Response>` webhook endpoint: Next.js
// route handlers, Hono (`app.post(path, (c) => handler(c.req.raw))`), Bun,
// Deno and Workers all accept it. It reads the raw body, verifies it, calls
// `onEvent`, and answers 200 `{"ok":true}`, 413 for a body over the size
// limit, 401 JSON when verification
// fails (so the sender does not count a forged delivery as handled), or 422
// when an authentic delivery's body cannot be parsed.

import {
	isRyuError,
	RyuConfigurationError,
	RyuWebhookVerificationError,
} from "../errors.ts";
import { SERVICE_TITLES } from "../service-titles.ts";
import { type MailWebhookEvent, verifyMailWebhook } from "./mail.ts";
import {
	type MessagingWebhookEvent,
	verifyMessagingWebhook,
} from "./messaging.ts";
import {
	type NotifyWebhookDelivery,
	type NotifyWebhookKind,
	verifyNotifyWebhook,
} from "./notify.ts";
import {
	resolveToleranceSeconds,
	type StandardWebhookScheme,
} from "./standard.ts";

const JSON_HEADERS = { "content-type": "application/json" } as const;

/** Default {@link HandlerCommon.maxBodyBytes}: 1 MiB. */
export const DEFAULT_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

interface HandlerCommon {
	/**
	 * The largest body read before verification, in bytes. A larger request
	 * gets 413 and is never buffered past the limit. Default 1 MiB.
	 */
	maxBodyBytes?: number;
	/** Clock override for timestamp checks (tests). */
	now?: () => Date;
	/**
	 * Called with whatever `onEvent` threw, before the 500 is answered, so the
	 * cause reaches your logs or error tracker. The response body never
	 * carries it. Without this hook the error is reported with `console.error`.
	 * A throw from `onError` itself is ignored.
	 */
	onError?(error: unknown, request: Request): void | Promise<void>;
	/** The webhook signing secret. */
	secret: string;
	/** Accepted clock skew in seconds; default 300. */
	toleranceSeconds?: number;
}

/** {@link webhookHandler} options for Mail deliveries. */
export interface MailWebhookHandlerOptions extends HandlerCommon {
	/**
	 * Runs once per verified event, including an event type newer than this
	 * SDK (see `isKnownMailWebhookEvent`). Throwing answers 500, and Mail
	 * retries the delivery.
	 */
	onEvent(event: MailWebhookEvent, request: Request): void | Promise<void>;
	/** `legacy` for a webhook created before Standard Webhooks signing. */
	scheme?: StandardWebhookScheme;
	service: "mail";
}

/** {@link webhookHandler} options for Notify destination deliveries or response callbacks. */
export interface NotifyWebhookHandlerOptions extends HandlerCommon {
	/**
	 * Destinations only: accept the replayable body-only signature when the
	 * `webhook-*` headers are absent. Default false: such a delivery answers 401.
	 */
	allowBodyOnlySignature?: boolean;
	/**
	 * Defaults to `destination`. A destination delivery signed with the
	 * Standard Webhooks `webhook-*` headers is replay-protected; the body-only
	 * fallback is not. Dedupe on `deliveryId` either way.
	 */
	kind?: NotifyWebhookKind;
	/**
	 * Runs once per verified request. Throwing answers 500: Notify retries a
	 * destination delivery, but attempts a response callback once and does not
	 * retry it.
	 */
	onEvent(
		delivery: NotifyWebhookDelivery,
		request: Request
	): void | Promise<void>;
	/**
	 * Destinations only: refuse a delivery without the `webhook-*` headers
	 * (401) instead of accepting the body-only signature. Default true; `false`
	 * is the same opt-in as `allowBodyOnlySignature`.
	 */
	requireTimestamp?: boolean;
	service: "notify";
}

/** {@link webhookHandler} options for Ryu Messaging deliveries. */
export interface MessagingWebhookHandlerOptions extends HandlerCommon {
	/**
	 * Runs once per verified event, including an event type newer than this
	 * SDK (see `isKnownMessagingWebhookEvent`). Throwing answers 500, and
	 * Messaging tries the delivery up to three times in all.
	 */
	onEvent(event: MessagingWebhookEvent, request: Request): void | Promise<void>;
	service: "messaging";
}

/** Options for {@link webhookHandler}. */
export type WebhookHandlerOptions =
	| MailWebhookHandlerOptions
	| NotifyWebhookHandlerOptions
	| MessagingWebhookHandlerOptions;

function json(status: number, body: unknown, extra?: HeadersInit): Response {
	const headers = new Headers(JSON_HEADERS);
	for (const [name, value] of new Headers(extra)) {
		headers.set(name, value);
	}
	return new Response(JSON.stringify(body), { status, headers });
}

/** Hands an `onEvent` failure to `onError`, or to `console.error` without one. */
async function reportHandlerError(
	options: WebhookHandlerOptions,
	error: unknown,
	request: Request
): Promise<void> {
	if (!options.onError) {
		console.error("Ryu webhook handler: onEvent threw.", error);
		return;
	}
	try {
		await options.onError(error, request);
	} catch {
		// The 500 is answered regardless; a failing reporter must not mask it.
	}
}

async function verifyAndDispatch(
	options: WebhookHandlerOptions,
	request: Request,
	payload: Uint8Array
): Promise<() => void | Promise<void>> {
	const now = options.now?.();
	if (options.service === "mail") {
		const event = await verifyMailWebhook({
			headers: request.headers,
			payload,
			secret: options.secret,
			scheme: options.scheme,
			now,
			toleranceSeconds: options.toleranceSeconds,
		});
		return () => options.onEvent(event, request);
	}
	if (options.service === "messaging") {
		const event = await verifyMessagingWebhook({
			headers: request.headers,
			payload,
			secret: options.secret,
			now,
			toleranceSeconds: options.toleranceSeconds,
		});
		return () => options.onEvent(event, request);
	}
	const delivery = await verifyNotifyWebhook({
		headers: request.headers,
		payload,
		secret: options.secret,
		kind: options.kind ?? "destination",
		now,
		allowBodyOnlySignature: options.allowBodyOnlySignature,
		requireTimestamp: options.requireTimestamp,
		toleranceSeconds: options.toleranceSeconds,
	});
	return () => options.onEvent(delivery, request);
}

/**
 * The raw body bytes, exactly as sent (no UTF-8 decoding, so a BOM or a
 * non-UTF-8 byte reaches the HMAC unchanged), or null once more than
 * `maxBytes` arrive. The stream is cancelled at the limit instead of being
 * buffered whole.
 */
async function readRawBody(
	request: Request,
	maxBytes: number
): Promise<Uint8Array | null> {
	const declared = Number(request.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes) {
		return null;
	}
	if (request.body === null) {
		return new Uint8Array(0);
	}
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel().catch(() => undefined);
			return null;
		}
		chunks.push(value);
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

function maxBodyBytesOf(options: WebhookHandlerOptions): number {
	const value = options.maxBodyBytes;
	if (value === undefined) {
		return DEFAULT_WEBHOOK_MAX_BODY_BYTES;
	}
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new RyuConfigurationError({
			service: options.service,
			status: 0,
			code: "invalid_max_body_bytes",
			message: `${SERVICE_TITLES[options.service]} webhook: maxBodyBytes must be a positive integer (got ${String(value)}).`,
		});
	}
	return value;
}

/**
 * Builds a webhook endpoint for `service`.
 *
 * - Non-POST requests get 405; a body over `maxBodyBytes` (default 1 MiB)
 *   gets 413 before it is verified.
 * - A delivery that fails verification gets 401
 *   `{"ok":false,"error":{"code","message"}}` and `onEvent` is not called.
 *   An unset or empty `secret` (a missing env var or Workers binding) is
 *   checked per delivery, not when the handler is built, and answers 401
 *   `webhook_invalid_secret`: a Worker builds the handler inside `fetch()`,
 *   and a throw there would answer 5xx, which the sender retries.
 * - An authentic delivery whose body is not JSON or not the service's
 *   envelope gets 422 with code `webhook_payload_invalid`; it is not reported
 *   as a forgery. A Mail event type newer than this SDK is not an error: it
 *   reaches `onEvent`.
 * - A verified delivery calls `onEvent`; on success the answer is 200
 *   `{"ok":true}`. If `onEvent` throws, `onError` (or `console.error`)
 *   receives the error and the answer is 500 with no error detail. Mail and
 *   Notify destination deliveries are retried on a 500; a Notify response
 *   callback is attempted once.
 */
export function webhookHandler(
	options: WebhookHandlerOptions
): (request: Request) => Promise<Response> {
	// Bad settings fail when the handler is built, not on the first delivery.
	resolveToleranceSeconds(options.service, options.toleranceSeconds);
	const maxBodyBytes = maxBodyBytesOf(options);
	return async (request) => {
		if (request.method !== "POST") {
			return json(
				405,
				{
					ok: false,
					error: { code: "method_not_allowed", message: "Use POST." },
				},
				{ allow: "POST" }
			);
		}
		const payload = await readRawBody(request, maxBodyBytes);
		if (payload === null) {
			return json(413, {
				ok: false,
				error: {
					code: "payload_too_large",
					message: `The body is larger than ${maxBodyBytes} bytes.`,
				},
			});
		}
		let dispatch: () => void | Promise<void>;
		try {
			dispatch = await verifyAndDispatch(options, request, payload);
		} catch (error) {
			if (
				error instanceof RyuWebhookVerificationError ||
				(isRyuError(error) && error.code.startsWith("webhook_"))
			) {
				// Only the post-verification body parse throws this code.
				const status = error.code === "webhook_payload_invalid" ? 422 : 401;
				return json(status, {
					ok: false,
					error: { code: error.code, message: error.message },
				});
			}
			throw error;
		}
		try {
			await dispatch();
		} catch (error) {
			await reportHandlerError(options, error, request);
			return json(500, {
				ok: false,
				error: {
					code: "handler_error",
					message: "The webhook handler failed.",
				},
			});
		}
		return json(200, { ok: true });
	};
}
