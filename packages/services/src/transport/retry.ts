// packages/services/src/transport/retry.ts
//
// Retry policy for the service fetch shim (design §4 rule 7). Pure functions so
// the rules can be tested without a transport:
//
// - a request is replay-safe when its method is idempotent by definition, or it
//   carries an `Idempotency-Key` on a route-table route, and its body can be
//   sent twice;
// - 408/425/500/502/503/504 and network failures are retried only when
//   replay-safe; a 429 is retried for any method (the server refused before
//   processing) but only when the server said how long to wait; a 409
//   `idempotency_in_progress` is retried;
// - the codes in NON_RETRYABLE_CODES and every 402 are never retried.

/** Codes that a retry cannot fix: quota, billing, availability, configuration and stream limits. */
export const NON_RETRYABLE_CODES: ReadonlySet<string> = new Set([
	"quota_exceeded",
	"insufficient_credits",
	"spend_limit_reached",
	"managed_agents_disabled",
	"feature_disabled",
	"not_configured",
	"metering_unavailable",
	"outcome_unknown",
	// Ryu Messaging: AWS refused the request (a deterministic AWS 4xx). On a
	// send the server releases the idempotency claim, so a same-key retry would
	// run a whole new send instead of replaying the first answer.
	"provider_refused",
	"too_many_streams",
	"stream_limit_reached",
	"address_change_cooldown",
	// Deployment configuration states (Managed Agents, Box, Connect) that a
	// retry cannot change.
	"backend_disabled",
	"secrets_unavailable",
	"driver_not_safe",
	"upstream_unconfigured",
	"upstream_invalid",
	"skills_unavailable",
	// Box: the Box an Idempotency-Key created was deleted; the key stays
	// spent, so only a new key can create another Box.
	"idempotency_key_resource_deleted",
]);

/** Statuses retried when the request is replay-safe. */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([
	408, 425, 500, 502, 503, 504,
]);

/** Methods that are safe to replay by definition (RFC 9110 §9.2.2). */
const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set([
	"GET",
	"HEAD",
	"OPTIONS",
	"PUT",
	"DELETE",
]);

/** The code a server sends while the first request with the same key is still running. */
export const IDEMPOTENCY_IN_PROGRESS = "idempotency_in_progress";

/** Longest computed backoff (8 s) before jitter. */
const MAX_BACKOFF_MS = 8000;
/** First backoff step (0.5 s). */
const BASE_BACKOFF_MS = 500;

/**
 * Whether `body` can be sent again unchanged. Streams cannot; FormData can,
 * because its entries are strings and Blobs, which fetch re-reads.
 */
export function isReplayableBody(body: BodyInit | null | undefined): boolean {
	if (body === null || body === undefined || typeof body === "string") {
		return true;
	}
	if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) {
		return false;
	}
	return (
		body instanceof ArrayBuffer ||
		ArrayBuffer.isView(body) ||
		(typeof Blob !== "undefined" && body instanceof Blob) ||
		(typeof URLSearchParams !== "undefined" &&
			body instanceof URLSearchParams) ||
		(typeof FormData !== "undefined" && body instanceof FormData)
	);
}

/** Inputs to {@link isReplaySafe}. */
export interface ReplaySafetyInput {
	body: BodyInit | null | undefined;
	/** The request carries an `Idempotency-Key` on a route the service table lists. */
	hasRouteIdempotencyKey: boolean;
	method: string;
}

/** Whether sending this request twice cannot have a different effect from sending it once. */
export function isReplaySafe(input: ReplaySafetyInput): boolean {
	const method = input.method.toUpperCase();
	return (
		(IDEMPOTENT_METHODS.has(method) || input.hasRouteIdempotencyKey) &&
		isReplayableBody(input.body)
	);
}

/** Server hints that say how long to wait. */
export interface RetryHints {
	/** Body hint: `retryAfterSeconds` (Connect) or `error.retry_after` (Gateway). */
	bodyRetryAfterSeconds: number | null;
	/** `RateLimit` `r`. */
	rateLimitRemaining: number | null;
	/** `RateLimit` `t`, only meaningful when `r` is 0. */
	rateLimitResetSeconds: number | null;
	/** `Retry-After`, in seconds. */
	retryAfterSeconds: number | null;
}

/** What {@link shouldRetry} needs about one failed attempt. */
export interface RetryDecisionInput extends RetryHints {
	code: string | null;
	/** The body can be sent again unchanged ({@link isReplayableBody}). */
	replayableBody: boolean;
	/** The whole request is replay-safe ({@link isReplaySafe}). */
	replaySafe: boolean;
	/** HTTP status, or 0 for a network failure or timeout. */
	status: number;
}

/** The `RateLimit` reset when the window is exhausted (`r=0`), else null. */
function exhaustedResetSeconds(hints: RetryHints): number | null {
	return hints.rateLimitRemaining === 0 ? hints.rateLimitResetSeconds : null;
}

/** Whether the status and code describe a failure worth retrying at all (ignoring replay safety). */
export function isRetryableFailure(
	status: number,
	code: string | null
): boolean {
	if (code !== null && NON_RETRYABLE_CODES.has(code)) {
		return false;
	}
	if (status === 402) {
		return false;
	}
	if (status === 0 || status === 429 || RETRYABLE_STATUSES.has(status)) {
		return true;
	}
	return status === 409 && code === IDEMPOTENCY_IN_PROGRESS;
}

/** Whether the shim should send this request again. */
export function shouldRetry(input: RetryDecisionInput): boolean {
	if (!isRetryableFailure(input.status, input.code)) {
		return false;
	}
	if (input.status === 429) {
		const hinted =
			input.retryAfterSeconds !== null ||
			exhaustedResetSeconds(input) !== null ||
			input.bodyRetryAfterSeconds !== null;
		// A 429 is refused before processing, so any method may retry, but the body must replay.
		return hinted && input.replayableBody;
	}
	return input.replaySafe;
}

/** How long to wait before the next attempt, and which signal decided it. */
export interface RetryDelay {
	delayMs: number;
	source: "retry-after" | "ratelimit" | "body" | "backoff";
}

/**
 * The delay before retry number `retryIndex` (0 for the first retry). First
 * match wins: `Retry-After`, then the `RateLimit` reset when `r=0`, then the
 * body hint, then `min(8s, 0.5s * 2^n)` with jitter in [0.5, 1].
 */
export function computeDelay(
	retryIndex: number,
	hints: RetryHints,
	random: () => number = Math.random
): RetryDelay {
	if (hints.retryAfterSeconds !== null) {
		return { delayMs: hints.retryAfterSeconds * 1000, source: "retry-after" };
	}
	const reset = exhaustedResetSeconds(hints);
	if (reset !== null) {
		return { delayMs: reset * 1000, source: "ratelimit" };
	}
	if (hints.bodyRetryAfterSeconds !== null) {
		return { delayMs: hints.bodyRetryAfterSeconds * 1000, source: "body" };
	}
	const base = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** retryIndex);
	const jitter = 0.5 + random() * 0.5;
	return { delayMs: Math.round(base * jitter), source: "backoff" };
}
