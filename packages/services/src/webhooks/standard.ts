// packages/services/src/webhooks/standard.ts
//
// Standard Webhooks verification (https://www.standardwebhooks.com/), the
// scheme hosted Mail (packages/api/src/lib/mail-webhooks.ts) and self-hosted
// Mail (apps-store/mail/backend/src/webhooks.rs) sign deliveries with:
//
// - headers `webhook-id`, `webhook-timestamp`, `webhook-signature`, repeated
//   as `svix-*` so Svix consumers keep working;
// - signed content `${id}.${timestamp}.${rawBody}`, HMAC-SHA256, base64;
// - `webhook-signature` is a space-separated list of `v1,<base64>` entries
//   (several during a secret rotation);
// - the key is the base64 decode of the part after `whsec_`.
//
// Webhooks created before Standard Webhooks signing ("legacy") key their
// `svix-signature` with the raw UTF-8 secret, prefix included; their
// `webhook-signature` still uses the standard decoded key.

import type { RyuService } from "../errors.ts";
import {
	RyuConfigurationError,
	type RyuWebhookVerificationCode,
	RyuWebhookVerificationError,
} from "../errors.ts";
import { SERVICE_TITLES } from "../service-titles.ts";
import {
	concatBytes,
	decodeBase64,
	encodeBase64,
	hasWebCrypto,
	hmacSha256,
	timingSafeEqual,
	toBytes,
} from "./crypto.ts";

/** The SDK docs page every verification error links to. */
export const WEBHOOKS_DOCS_URL =
	"https://docs.ryuhq.com/docs/standalone/sdk/webhooks";

/** Default accepted clock skew between the sender and this receiver, in seconds. */
export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;
/** The largest accepted `toleranceSeconds` (one day): more would disable replay protection. */
export const MAX_WEBHOOK_TOLERANCE_SECONDS = 86_400;

/**
 * `toleranceSeconds` checked: undefined gives the default; anything else must
 * be a finite number from 0 to {@link MAX_WEBHOOK_TOLERANCE_SECONDS}. NaN (what
 * `Number()` of an unset env var gives) or Infinity would accept any timestamp
 * and silently remove replay protection, so they throw RyuConfigurationError
 * (`invalid_tolerance`).
 */
export function resolveToleranceSeconds(
	service: RyuService,
	value: number | undefined
): number {
	if (value === undefined) {
		return DEFAULT_WEBHOOK_TOLERANCE_SECONDS;
	}
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value < 0 ||
		value > MAX_WEBHOOK_TOLERANCE_SECONDS
	) {
		throw new RyuConfigurationError({
			service,
			status: 0,
			code: "invalid_tolerance",
			message: `${SERVICE_TITLES[service]} webhook: toleranceSeconds must be a number from 0 to ${MAX_WEBHOOK_TOLERANCE_SECONDS} (got ${String(value)}).`,
			docs: WEBHOOKS_DOCS_URL,
		});
	}
	return value;
}

const SECRET_PREFIX = "whsec_";
const UNIX_SECONDS_RE = /^\d{1,12}$/;
const WHITESPACE_RE = /\s+/;
const TRAILING_COMMAS_RE = /,+$/;
const decoder = new TextDecoder();

/** Request headers as a Headers object or a plain record (Node `IncomingHttpHeaders`). */
export type WebhookHeaders =
	| Headers
	| Record<string, string | readonly string[] | undefined>;

/** How a Mail webhook's deliveries are keyed. */
export type StandardWebhookScheme = "standard" | "legacy";

/** Options for {@link verifyStandardWebhook}. */
export interface VerifyStandardWebhookOptions {
	/** The request headers. `webhook-*` is read first, then `svix-*`. */
	headers: WebhookHeaders;
	/** Clock override for the timestamp check. Defaults to the current time. */
	now?: Date;
	/** The raw request body (`await request.text()`), never re-serialized JSON. */
	payload: string | Uint8Array;
	/**
	 * `standard` (default) keys the HMAC on the base64 decode of the part after
	 * `whsec_`. `legacy` reads `svix-*` headers first and keys `svix-signature`
	 * on the raw UTF-8 secret, prefix included; when only `webhook-*` headers
	 * arrive it verifies them with the standard key, as the server signs them.
	 * Use it only for a webhook created before Standard Webhooks signing whose
	 * secret was never rotated.
	 */
	scheme?: StandardWebhookScheme;
	/** The webhook signing secret, `whsec_<base64>`. */
	secret: string;
	/** The service named on errors. Defaults to `mail`. */
	service?: RyuService;
	/** Accepted clock skew in seconds, either direction: 0 to 86 400. Default 300. */
	toleranceSeconds?: number;
}

/** Builds the verification error every verifier throws. */
export function webhookError(
	service: RyuService,
	code: RyuWebhookVerificationCode,
	message: string,
	cause?: unknown
): RyuWebhookVerificationError {
	return new RyuWebhookVerificationError({
		service,
		status: 0,
		code,
		message: `${SERVICE_TITLES[service]} webhook: ${message}`,
		docs: WEBHOOKS_DOCS_URL,
		cause,
	});
}

/**
 * Throws `webhook_invalid_secret` ("the signing secret is empty.") when
 * `secret` is not a non-empty string. An unset env var or binding gives
 * `undefined`, which would otherwise fail later with a raw TypeError and
 * answer 500, so the sender retries instead of seeing a 401.
 */
export function assertWebhookSecret(
	service: RyuService,
	secret: unknown
): asserts secret is string {
	if (typeof secret !== "string" || secret === "") {
		throw webhookError(
			service,
			"webhook_invalid_secret",
			"the signing secret is empty."
		);
	}
}

/** Throws a configuration error when the runtime has no WebCrypto. */
export function assertWebCrypto(service: RyuService): void {
	if (!hasWebCrypto()) {
		throw new RyuConfigurationError({
			service,
			status: 0,
			code: "webcrypto_unavailable",
			message: `${SERVICE_TITLES[service]} webhook: this runtime has no WebCrypto (globalThis.crypto.subtle); use Node 18+, Bun, Deno or an edge runtime.`,
			docs: WEBHOOKS_DOCS_URL,
		});
	}
}

/**
 * Reads one header case-insensitively. A repeated header (an array value, as
 * Node gives for duplicates) is joined with `separator`.
 */
export function readHeader(
	headers: WebhookHeaders,
	name: string,
	separator = ", "
): string | null {
	if (typeof Headers !== "undefined" && headers instanceof Headers) {
		return headers.get(name);
	}
	const wanted = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() !== wanted || value === undefined) {
			continue;
		}
		const joined = typeof value === "string" ? value : value.join(separator);
		return joined === "" ? null : joined;
	}
	return null;
}

/**
 * Parses a unix-seconds timestamp header and checks it is within
 * `toleranceSeconds` of `now`, in either direction.
 */
export function checkTimestamp(
	service: RyuService,
	raw: string,
	now: Date,
	toleranceSeconds: number
): void {
	const trimmed = raw.trim();
	if (!UNIX_SECONDS_RE.test(trimmed)) {
		throw webhookError(
			service,
			"webhook_timestamp_out_of_range",
			"the timestamp header is not unix seconds."
		);
	}
	const skew = Math.abs(now.getTime() / 1000 - Number(trimmed));
	// Written as "not within" so a NaN skew (an Invalid Date `now`) fails closed
	// instead of turning replay protection off.
	if (!(skew <= toleranceSeconds)) {
		throw webhookError(
			service,
			"webhook_timestamp_out_of_range",
			`the timestamp is ${Math.round(skew)}s from now, outside the ${toleranceSeconds}s tolerance.`
		);
	}
}

/** Decodes the raw payload as UTF-8 and parses it as JSON. */
export function parseJsonPayload(
	service: RyuService,
	payload: string | Uint8Array
): unknown {
	const text = typeof payload === "string" ? payload : decoder.decode(payload);
	try {
		return JSON.parse(text);
	} catch (error) {
		throw webhookError(
			service,
			"webhook_payload_invalid",
			"the verified payload is not JSON.",
			error
		);
	}
}

/** How one header family's signature is keyed. */
type SigningKeyKind = "standard" | "raw";

/** The HMAC key of `kind`, or null when a standard secret is not `whsec_<base64>`. */
function signingKey(secret: string, kind: SigningKeyKind): Uint8Array | null {
	if (kind === "raw") {
		return toBytes(secret);
	}
	const encoded = secret.startsWith(SECRET_PREFIX)
		? secret.slice(SECRET_PREFIX.length)
		: secret;
	return decodeBase64(encoded);
}

/**
 * The `v1` signatures in a space-separated Standard Webhooks signature list.
 * `Headers.get()` joins a repeated header with `", "`, so a trailing comma is
 * stripped from each entry (base64 never contains one).
 */
function v1Signatures(list: string): string[] {
	const signatures: string[] = [];
	for (const raw of list.split(WHITESPACE_RE)) {
		const entry = raw.replace(TRAILING_COMMAS_RE, "");
		const comma = entry.indexOf(",");
		if (comma > 0 && entry.slice(0, comma) === "v1") {
			signatures.push(entry.slice(comma + 1));
		}
	}
	return signatures;
}

interface SignatureHeaders {
	id: string;
	keyKind: SigningKeyKind;
	signature: string;
	timestamp: string;
}

/** Header families in lookup order, with the key each is signed with. */
const FAMILIES: Record<
	StandardWebhookScheme,
	readonly { family: string; keyKind: SigningKeyKind }[]
> = {
	standard: [
		{ family: "webhook", keyKind: "standard" },
		{ family: "svix", keyKind: "standard" },
	],
	// Both server signers key `webhook-signature` with the decoded key even
	// for legacy webhooks; only `svix-signature` uses the raw secret.
	legacy: [
		{ family: "svix", keyKind: "raw" },
		{ family: "webhook", keyKind: "standard" },
	],
};

/**
 * The id, timestamp and signature from the first complete header family, and
 * the key that family is signed with. Families are never mixed: a
 * `webhook-id` is only checked against a `webhook-signature`.
 */
function signatureHeaders(
	headers: WebhookHeaders,
	scheme: StandardWebhookScheme
): SignatureHeaders | null {
	for (const { family, keyKind } of FAMILIES[scheme]) {
		const id = readHeader(headers, `${family}-id`);
		const timestamp = readHeader(headers, `${family}-timestamp`);
		const signature = readHeader(headers, `${family}-signature`, " ");
		if (id && timestamp && signature) {
			return { id, keyKind, timestamp, signature };
		}
	}
	return null;
}

/**
 * Verifies a Standard Webhooks delivery and resolves to its parsed JSON body.
 *
 * Pass the raw body exactly as received (`await request.text()`); parsing and
 * re-serializing it changes the bytes and fails verification. The timestamp is
 * checked against `toleranceSeconds` (default 300) before the signature, and
 * every `v1` entry in the signature list is compared in constant time.
 *
 * @throws RyuWebhookVerificationError with `webhook_missing_headers`,
 *   `webhook_invalid_secret`, `webhook_timestamp_out_of_range`,
 *   `webhook_invalid_signature` or `webhook_payload_invalid`.
 * @throws RyuConfigurationError `webcrypto_unavailable` on a runtime without
 *   `crypto.subtle`.
 */
export async function verifyStandardWebhook(
	options: VerifyStandardWebhookOptions
): Promise<unknown> {
	const service = options.service ?? "mail";
	const scheme = options.scheme ?? "standard";
	assertWebCrypto(service);
	const toleranceSeconds = resolveToleranceSeconds(
		service,
		options.toleranceSeconds
	);
	assertWebhookSecret(service, options.secret);
	const found = signatureHeaders(options.headers, scheme);
	if (!found) {
		throw webhookError(
			service,
			"webhook_missing_headers",
			"expected webhook-id, webhook-timestamp and webhook-signature (or their svix-* aliases)."
		);
	}
	const key = signingKey(options.secret, found.keyKind);
	if (!key || key.byteLength === 0) {
		throw webhookError(
			service,
			"webhook_invalid_secret",
			"the signing secret must be whsec_ followed by base64."
		);
	}
	checkTimestamp(
		service,
		found.timestamp,
		options.now ?? new Date(),
		toleranceSeconds
	);
	const signed = concatBytes(
		toBytes(`${found.id}.${found.timestamp}.`),
		toBytes(options.payload)
	);
	const expected = encodeBase64(await hmacSha256(key, signed));
	let matched = false;
	for (const candidate of v1Signatures(found.signature)) {
		// No early exit: every entry is compared.
		matched = timingSafeEqual(candidate, expected) || matched;
	}
	if (!matched) {
		throw webhookError(
			service,
			"webhook_invalid_signature",
			"no v1 signature matches the payload and secret."
		);
	}
	return parseJsonPayload(service, options.payload);
}
