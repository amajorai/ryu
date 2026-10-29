// packages/services/src/webhooks/notify.ts
//
// Notify signs two kinds of outbound request (apps/notify/src/service.ts):
//
// - destination deliveries (a channel's webhook destination with a secret):
//   Standard Webhooks headers (apps/notify/src/http-conventions.ts
//   standardWebhookHeaders): `webhook-id` (the delivery id), `webhook-timestamp`
//   and `webhook-signature: v1,<base64 HMAC-SHA256 of "${id}.${timestamp}.${body}">`,
//   keyed with the UTF-8 bytes of the destination secret (not whsec_/base64
//   decoded). Alongside them, the older body-only
//   `x-ryu-notify-signature: sha256=<hex HMAC-SHA256 of the raw body>`, plus
//   `x-ryu-notify-event` and `x-ryu-notify-delivery`. The verifier prefers the
//   Standard Webhooks headers, which carry replay protection, and falls back
//   to the body-only signature (no timestamp) only when the caller opts in
//   with `allowBodyOnlySignature`: a captured delivery with the `webhook-*`
//   headers dropped would otherwise replay indefinitely.
// - response callbacks (`response.callbackUrl` on an approval request):
//   `x-ryu-notify-signature: sha256=<hex HMAC-SHA256 of "${timestamp}.${body}">`
//   with `x-ryu-notify-timestamp`, so the receiver can reject replays.

import {
	concatBytes,
	encodeBase64,
	encodeHex,
	hmacSha256,
	timingSafeEqual,
	toBytes,
} from "./crypto.ts";
import {
	assertWebCrypto,
	assertWebhookSecret,
	checkTimestamp,
	parseJsonPayload,
	readHeader,
	resolveToleranceSeconds,
	type WebhookHeaders,
	webhookError,
} from "./standard.ts";

const SIGNATURE_PREFIX = "sha256=";
const WHITESPACE_RE = /\s+/;
const TRAILING_COMMAS_RE = /,+$/;
const decoder = new TextDecoder();

/** Which Notify request is being verified. */
export type NotifyWebhookKind = "destination" | "callback";

/** Options for {@link verifyNotifyWebhook}. */
export interface VerifyNotifyWebhookOptions {
	/**
	 * Destination only: accept the body-only `x-ryu-notify-signature` when the
	 * `webhook-*` headers are absent. It carries **no timestamp, so a captured
	 * delivery can be replayed indefinitely** with those headers dropped
	 * (`replayProtected` is then false); dedupe on `deliveryId` if you set it.
	 * Notify sends both header families on every destination delivery, so most
	 * receivers never need this. Default false: such a delivery is refused with
	 * `webhook_missing_headers`. Ignored when `requireTimestamp` is true.
	 */
	allowBodyOnlySignature?: boolean;
	/** The request headers. */
	headers: WebhookHeaders;
	/**
	 * `destination`: a channel webhook destination delivery (Standard Webhooks
	 * signature with a timestamp). `callback`: an approval response callback
	 * (timestamped signature).
	 */
	kind: NotifyWebhookKind;
	/** Clock override for the timestamp check. */
	now?: Date;
	/** The raw request body (`await request.text()`), never re-serialized JSON. */
	payload: string | Uint8Array;
	/**
	 * Destination only: refuse a delivery without the Standard Webhooks
	 * headers (`webhook_missing_headers`) instead of falling back to the
	 * body-only signature, so a stripped-down replay cannot pass. Default true;
	 * `false` is the same opt-in as `allowBodyOnlySignature: true`. When true
	 * it wins over `allowBodyOnlySignature`.
	 */
	requireTimestamp?: boolean;
	/** The destination secret, or the response callback secret. */
	secret: string;
	/**
	 * Accepted clock skew in seconds, either direction, for a callback and for
	 * a destination delivery signed with Standard Webhooks headers. Default 300.
	 */
	toleranceSeconds?: number;
}

/** A verified Notify request. */
export interface NotifyWebhookDelivery {
	/**
	 * The parsed body. A JSON destination delivery is
	 * `{deliveryId, event, type:"notification"}` (`event` is the notification);
	 * a callback is `{type:"notification.response", eventId, response}`. A
	 * destination body that is not JSON (an ntfy-formatted delivery: the
	 * notification's body or title as plain text) is returned as the raw string.
	 */
	body: unknown;
	/**
	 * The delivery id: destination only. Dedupe on it. With Standard Webhooks
	 * headers it is the signed `webhook-id` (`dlv_…`, or `test_…` for a test
	 * delivery); otherwise the signed body's `deliveryId`, and null for a
	 * plain-text (ntfy) delivery, which then carries no signed id.
	 */
	deliveryId: string | null;
	/**
	 * The signed body's event id (`event.id` for a destination delivery,
	 * `eventId` for a callback). Null for a plain-text (ntfy) delivery.
	 */
	eventId: string | null;
	kind: NotifyWebhookKind;
	/**
	 * True when a signed timestamp was checked against `toleranceSeconds`: a
	 * callback, or a destination delivery with Standard Webhooks headers.
	 * False for a body-only destination signature, which can be replayed.
	 */
	replayProtected: boolean;
}

function objectField(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)[key]
		: undefined;
}

function stringField(value: unknown, key: string): string | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}
	const field = (value as Record<string, unknown>)[key];
	return typeof field === "string" ? field : null;
}

/**
 * The ids the signature covers, read from the verified body. The
 * `x-ryu-notify-delivery` and `x-ryu-notify-event` headers are not signed, so
 * they are never trusted: a header that disagrees with the body is a
 * tampered request.
 */
function signedIds(
	kind: NotifyWebhookKind,
	body: unknown,
	headers: WebhookHeaders,
	signedDeliveryId: string | null
): { deliveryId: string | null; eventId: string | null } {
	const bodyDeliveryId =
		kind === "callback" ? null : stringField(body, "deliveryId");
	if (
		signedDeliveryId !== null &&
		bodyDeliveryId !== null &&
		bodyDeliveryId !== signedDeliveryId
	) {
		throw webhookError(
			"notify",
			"webhook_invalid_signature",
			"webhook-id does not match the signed body's deliveryId."
		);
	}
	const ids =
		kind === "callback"
			? { deliveryId: null, eventId: stringField(body, "eventId") }
			: {
					deliveryId: signedDeliveryId ?? bodyDeliveryId,
					eventId: stringField(objectField(body, "event"), "id"),
				};
	const checks: [string, string | null][] = [
		["x-ryu-notify-event", ids.eventId],
		["x-ryu-notify-delivery", ids.deliveryId],
	];
	for (const [header, signed] of checks) {
		const sent = readHeader(headers, header);
		if (sent !== null && signed !== null && sent.trim() !== signed) {
			throw webhookError(
				"notify",
				"webhook_invalid_signature",
				`${header} does not match the signed body.`
			);
		}
	}
	return ids;
}

function destinationBody(payload: string | Uint8Array): unknown {
	const text = typeof payload === "string" ? payload : decoder.decode(payload);
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/** The `v1` entries of a space-separated Standard Webhooks signature list. */
function v1Signatures(list: string): string[] {
	const signatures: string[] = [];
	for (const raw of list.split(WHITESPACE_RE)) {
		// `Headers.get()` joins a repeated header with ", ".
		const entry = raw.replace(TRAILING_COMMAS_RE, "");
		const comma = entry.indexOf(",");
		if (comma > 0 && entry.slice(0, comma) === "v1") {
			signatures.push(entry.slice(comma + 1));
		}
	}
	return signatures;
}

interface StandardHeaders {
	id: string;
	signature: string;
	timestamp: string;
}

/**
 * The Standard Webhooks headers, or null when none of the three is present.
 * A partial set throws: falling back to the body-only signature would let a
 * replayed delivery downgrade the check by stripping one header.
 */
function standardHeaders(headers: WebhookHeaders): StandardHeaders | null {
	const id = readHeader(headers, "webhook-id");
	const timestamp = readHeader(headers, "webhook-timestamp");
	const signature = readHeader(headers, "webhook-signature", " ");
	if (id && timestamp && signature) {
		return { id: id.trim(), signature, timestamp: timestamp.trim() };
	}
	if (id || timestamp || signature) {
		throw webhookError(
			"notify",
			"webhook_missing_headers",
			"expected all of webhook-id, webhook-timestamp and webhook-signature; the delivery carries only some of them."
		);
	}
	return null;
}

/**
 * Checks a Standard Webhooks destination signature: the timestamp first,
 * then every `v1` entry in constant time (no early exit).
 */
async function verifyStandardDestination(
	options: VerifyNotifyWebhookOptions,
	found: StandardHeaders,
	toleranceSeconds: number
): Promise<void> {
	checkTimestamp(
		"notify",
		found.timestamp,
		options.now ?? new Date(),
		toleranceSeconds
	);
	const expected = encodeBase64(
		await hmacSha256(
			toBytes(options.secret),
			concatBytes(
				toBytes(`${found.id}.${found.timestamp}.`),
				toBytes(options.payload)
			)
		)
	);
	let matched = false;
	for (const candidate of v1Signatures(found.signature)) {
		matched = timingSafeEqual(candidate, expected) || matched;
	}
	if (!matched) {
		throw webhookError(
			"notify",
			"webhook_invalid_signature",
			"no v1 entry in webhook-signature matches the payload and secret."
		);
	}
}

/**
 * Whether a destination delivery without the Standard Webhooks headers may
 * verify on the replayable body-only signature: only on an explicit opt-in
 * (`allowBodyOnlySignature: true`, or `requireTimestamp: false`), and never
 * when `requireTimestamp` is true.
 */
function bodyOnlyAllowed(options: VerifyNotifyWebhookOptions): boolean {
	if (options.requireTimestamp === true) {
		return false;
	}
	return (
		options.allowBodyOnlySignature === true ||
		options.requireTimestamp === false
	);
}

/**
 * Verifies a request Notify signed and resolves to its ids and parsed body.
 *
 * `kind: "destination"` prefers the Standard Webhooks headers: it checks
 * `webhook-timestamp` against `toleranceSeconds` (default 300) and each `v1`
 * entry of `webhook-signature` over `${webhook-id}.${webhook-timestamp}.${body}`,
 * and returns `webhook-id` as `deliveryId`. Without those headers it refuses
 * the delivery (`webhook_missing_headers`) unless `allowBodyOnlySignature` is
 * set, which falls back to `x-ryu-notify-signature: sha256=<hex>` over the raw
 * body only: that carries **no timestamp, so a captured delivery can be
 * replayed**, and `replayProtected` is then false. Either way, record each
 * `deliveryId` and ignore repeats. Ids come from signed
 * content, never from the unsigned `x-ryu-notify-*` id headers; a header that
 * disagrees fails with `webhook_invalid_signature`. `kind: "callback"` checks
 * the signature over `${x-ryu-notify-timestamp}.${body}` and rejects
 * timestamps outside `toleranceSeconds`.
 *
 * @throws RyuWebhookVerificationError with `webhook_missing_headers`,
 *   `webhook_invalid_secret`, `webhook_timestamp_out_of_range`,
 *   `webhook_invalid_signature` or (callback) `webhook_payload_invalid`.
 */
export async function verifyNotifyWebhook(
	options: VerifyNotifyWebhookOptions
): Promise<NotifyWebhookDelivery> {
	assertWebCrypto("notify");
	const toleranceSeconds = resolveToleranceSeconds(
		"notify",
		options.toleranceSeconds
	);
	// Checked before the headers: a missing binding is the fix to make.
	assertWebhookSecret("notify", options.secret);
	const standard =
		options.kind === "destination" ? standardHeaders(options.headers) : null;
	if (standard) {
		await verifyStandardDestination(options, standard, toleranceSeconds);
		const body = destinationBody(options.payload);
		return {
			kind: options.kind,
			...signedIds(options.kind, body, options.headers, standard.id),
			body,
			replayProtected: true,
		};
	}
	const signature = readHeader(options.headers, "x-ryu-notify-signature");
	const timestamp =
		options.kind === "callback"
			? readHeader(options.headers, "x-ryu-notify-timestamp")
			: null;
	if (options.kind === "destination" && !bodyOnlyAllowed(options)) {
		throw webhookError(
			"notify",
			"webhook_missing_headers",
			options.requireTimestamp === true
				? "expected webhook-id, webhook-timestamp and webhook-signature (requireTimestamp is set)."
				: "expected webhook-id, webhook-timestamp and webhook-signature; a body-only signature is replayable, so it is refused unless allowBodyOnlySignature is set."
		);
	}
	if (!signature || (options.kind === "callback" && !timestamp)) {
		throw webhookError(
			"notify",
			"webhook_missing_headers",
			options.kind === "callback"
				? "expected x-ryu-notify-signature and x-ryu-notify-timestamp."
				: "expected webhook-id, webhook-timestamp and webhook-signature, or x-ryu-notify-signature."
		);
	}
	if (timestamp) {
		checkTimestamp(
			"notify",
			timestamp,
			options.now ?? new Date(),
			toleranceSeconds
		);
	}
	const signed = timestamp
		? concatBytes(toBytes(`${timestamp}.`), toBytes(options.payload))
		: toBytes(options.payload);
	const expected = `${SIGNATURE_PREFIX}${encodeHex(
		await hmacSha256(toBytes(options.secret), signed)
	)}`;
	if (!timingSafeEqual(signature.trim().toLowerCase(), expected)) {
		throw webhookError(
			"notify",
			"webhook_invalid_signature",
			"x-ryu-notify-signature does not match the payload and secret."
		);
	}
	const body =
		options.kind === "callback"
			? parseJsonPayload("notify", options.payload)
			: destinationBody(options.payload);
	return {
		kind: options.kind,
		...signedIds(options.kind, body, options.headers, null),
		body,
		replayProtected: timestamp !== null,
	};
}
