// packages/services/src/errors.ts
//
// One error type for every Ryu service. Each service answers errors in its own
// envelope (problem+json on the control-plane host, `{ok:false,type:"notify.error",…}`
// from Notify and Box, OpenAI-style `{error:{message,type,code}}` from Gateway,
// `{code,error}` from Connect, and so on); `parseErrorResponse` reads all of
// them into a RyuError whose `code` is stable and safe to branch on.
//
// This module is also the `@ryuhq/services/errors` entry point, so it imports
// no client code: Managed Agents and Messaging errors are recognized by
// shape, not by class.

import { SERVICE_TITLES } from "./service-titles.ts";
import { describeStatus } from "./status-codes.ts";
import {
	parseDeprecation,
	type RyuDeprecation,
} from "./transport/deprecation.ts";
import {
	parseRetryAfter,
	type RyuRateLimit,
	readRateLimit,
} from "./transport/rate-limit.ts";
import { isRetryableFailure } from "./transport/retry.ts";

export type { RyuDeprecation } from "./transport/deprecation.ts";
export type { RyuRateLimit } from "./transport/rate-limit.ts";

/** The services this SDK talks to. */
export type RyuService =
	| "managedAgents"
	| "messaging"
	| "mail"
	| "notify"
	| "box"
	| "gateway"
	| "connect"
	| "passport"
	| "sites";

/**
 * Which error body shape the server answered with (or `client` when no server
 * was involved). `messaging` names the `{error:"<code>", message}` shape
 * (design §3.2); it can come from any service except Passport.
 */
export type RyuErrorEnvelope =
	| "problem+json"
	| "ryu-service"
	| "managed-agents"
	| "messaging"
	| "openai"
	| "nested-error"
	| "code-error"
	| "error-message"
	| "error-string"
	| "text"
	| "empty"
	| "client";

/** Everything a RyuError carries. Only `service`, `status`, `code` and `message` are required. */
export interface RyuErrorInit {
	attempts?: number;
	authChallenge?: string | null;
	cause?: unknown;
	code: string;
	deprecation?: RyuDeprecation | null;
	details?: unknown;
	docs?: string | null;
	envelope?: RyuErrorEnvelope;
	hint?: string | null;
	idempotencyKey?: string | null;
	message: string;
	method?: string;
	rateLimit?: RyuRateLimit | null;
	requestId?: string | null;
	retryAfterSeconds?: number | null;
	retryable?: boolean;
	service: RyuService;
	status: number;
	title?: string | null;
	type?: string | null;
	url?: string;
}

/** {@link RyuErrorInit} where the subclass supplies the default `code`. */
export type RyuErrorSubclassInit = Omit<RyuErrorInit, "code"> & {
	code?: string;
};

/** The JSON form of a RyuError: safe to log, never contains keys or headers. */
export interface RyuErrorJSON {
	attempts: number;
	authChallenge: string | null;
	code: string;
	deprecation: RyuDeprecation | null;
	details: unknown;
	docs: string | null;
	envelope: RyuErrorEnvelope;
	hint: string | null;
	idempotencyKey: string | null;
	message: string;
	method: string;
	name: string;
	rateLimit: RyuRateLimit | null;
	requestId: string | null;
	retryAfterSeconds: number | null;
	retryable: boolean;
	service: RyuService;
	status: number;
	title: string | null;
	type: string | null;
	url: string;
}

/** Drops the query string and fragment so tokens in URLs never reach logs. */
export function redactUrl(url: string): string {
	if (url === "") {
		return "";
	}
	try {
		const parsed = new URL(url);
		return `${parsed.origin}${parsed.pathname}`;
	} catch {
		return url.split(/[?#]/u)[0] ?? "";
	}
}

/** The label between a RyuError's own message and the hint appended to it. */
const HINT_LABEL = "Hint:";

/** Sentence-ending punctuation: a message ending in one takes the hint without an added period. */
const SENTENCE_END = /[.!?]$/u;

/** `text` without trailing whitespace and one trailing sentence-ending mark. */
function withoutSentenceEnd(text: string): string {
	return text.trimEnd().replace(SENTENCE_END, "");
}

/**
 * Whether `message` already ends with `hint` (on its own or after `Hint:`),
 * ignoring a final period on either. Only the end counts: a short hint such
 * as `key` that appears mid-message is still appended.
 */
function endsWithHint(message: string, hint: string): boolean {
	const tail = withoutSentenceEnd(hint);
	return tail !== "" && withoutSentenceEnd(message).endsWith(tail);
}

/**
 * `message` with `hint` appended as ` Hint: <hint>`, so the message alone
 * says what to do next (in a log line, `String(error)` or an uncaught-error
 * trace). The message is returned unchanged when there is no hint or when it
 * already ends with the hint. Only the `hint` field is added, never the
 * `docs` field, the URL, headers or a key (a hint's own text may name a docs
 * page).
 */
export function messageWithHint(
	message: string,
	hint: string | null | undefined
): string {
	const next = hint?.trim() ?? "";
	if (next === "" || endsWithHint(message, next)) {
		return message;
	}
	const base = message.trimEnd();
	if (base === "") {
		return `${HINT_LABEL} ${next}`;
	}
	return `${base}${SENTENCE_END.test(base) ? "" : "."} ${HINT_LABEL} ${next}`;
}

/** The message each RyuError was built with, before {@link messageWithHint}. */
const OWN_MESSAGES = new WeakMap<object, string>();

/**
 * A RyuError's message without the hint {@link messageWithHint} appended, for
 * output that prints the hint on its own line (the CLI) or in its own field.
 * A message that carried the hint in its own words is returned unchanged.
 * For the original error this is exactly the message it was built with. For
 * a plain copy of it (`JSON.parse(JSON.stringify(error))`, `structuredClone`,
 * `postMessage`) only the ` Hint: <hint>` suffix can be removed, so a period
 * {@link messageWithHint} added before it stays: `bad key` comes back as
 * `bad key.`.
 */
export function messageWithoutHint(
	error: Pick<RyuError, "hint" | "message">
): string {
	const own = OWN_MESSAGES.get(error);
	if (own !== undefined && messageWithHint(own, error.hint) === error.message) {
		return own;
	}
	const hint = error.hint?.trim() ?? "";
	if (hint === "") {
		return error.message;
	}
	const suffix = `${HINT_LABEL} ${hint}`;
	if (error.message === suffix) {
		return "";
	}
	return error.message.endsWith(` ${suffix}`)
		? error.message.slice(0, -(suffix.length + 1))
		: error.message;
}

/**
 * A failed call to a Ryu service. Branch on `code` (stable) and, for a code
 * you do not know, on `status`. `status` is 0 when no response arrived
 * (configuration, connection, timeout or abort). `message` ends with
 * ` Hint: <hint>` when the error has a hint the message does not already
 * contain; `hint` keeps the hint on its own.
 */
export class RyuError extends Error {
	readonly attempts: number;
	/** `WWW-Authenticate` from a 401. */
	readonly authChallenge: string | null;
	readonly code: string;
	readonly deprecation: RyuDeprecation | null;
	/** Service-specific extras: `details`, `fields`, or the rest of the body. */
	readonly details: unknown;
	readonly docs: string | null;
	readonly envelope: RyuErrorEnvelope;
	readonly hint: string | null;
	readonly idempotencyKey: string | null;
	readonly method: string;
	readonly rateLimit: RyuRateLimit | null;
	/** `X-Request-ID`, else the body's `requestId`. Quote it to support. */
	readonly requestId: string | null;
	/** Whether retrying the same request could succeed. The SDK already retried when it was safe. */
	readonly retryable: boolean;
	readonly retryAfterSeconds: number | null;
	readonly service: RyuService;
	readonly status: number;
	readonly title: string | null;
	/** Problem `type`, or the service envelope type such as `notify.error`. */
	readonly type: string | null;
	/** The request URL without its query string. */
	readonly url: string;

	constructor(init: RyuErrorInit) {
		super(
			messageWithHint(init.message, init.hint),
			init.cause === undefined ? undefined : { cause: init.cause }
		);
		this.name = "RyuError";
		OWN_MESSAGES.set(this, init.message);
		this.service = init.service;
		this.status = init.status;
		this.code = init.code;
		this.title = init.title ?? null;
		this.type = init.type ?? null;
		this.requestId = init.requestId ?? null;
		this.retryAfterSeconds = init.retryAfterSeconds ?? null;
		this.rateLimit = init.rateLimit ?? null;
		this.deprecation = init.deprecation ?? null;
		this.details = init.details ?? null;
		this.docs = init.docs ?? null;
		this.hint = init.hint ?? null;
		this.authChallenge = init.authChallenge ?? null;
		this.envelope = init.envelope ?? "client";
		this.method = init.method ?? "";
		this.url = redactUrl(init.url ?? "");
		this.idempotencyKey = init.idempotencyKey ?? null;
		this.retryable =
			init.retryable ?? isRetryableFailure(init.status, init.code);
		this.attempts = init.attempts ?? 0;
	}

	/** A plain object for logs and MCP results. Never contains keys or request headers. */
	toJSON(): RyuErrorJSON {
		return {
			name: this.name,
			message: this.message,
			service: this.service,
			status: this.status,
			code: this.code,
			title: this.title,
			type: this.type,
			requestId: this.requestId,
			retryAfterSeconds: this.retryAfterSeconds,
			rateLimit: this.rateLimit,
			deprecation: this.deprecation,
			details: this.details,
			docs: this.docs,
			hint: this.hint,
			authChallenge: this.authChallenge,
			envelope: this.envelope,
			method: this.method,
			url: this.url,
			idempotencyKey: this.idempotencyKey,
			retryable: this.retryable,
			attempts: this.attempts,
		};
	}
}

function subclassInit(init: RyuErrorSubclassInit, code: string): RyuErrorInit {
	return { ...init, code: init.code ?? code };
}

/** Missing or unsupported configuration. Returned, not thrown, in object mode. */
export class RyuConfigurationError extends RyuError {
	constructor(init: RyuErrorSubclassInit) {
		super(subclassInit({ retryable: false, ...init }, "configuration_error"));
		this.name = "RyuConfigurationError";
	}
}

/** The request never got a response (DNS, TCP, TLS, reset). */
export class RyuConnectionError extends RyuError {
	constructor(init: RyuErrorSubclassInit) {
		super(subclassInit(init, "connection_error"));
		this.name = "RyuConnectionError";
	}
}

/** `timeoutMs` elapsed before the response headers arrived. */
export class RyuTimeoutError extends RyuError {
	constructor(init: RyuErrorSubclassInit) {
		super(subclassInit(init, "timeout"));
		this.name = "RyuTimeoutError";
	}
}

/** The caller's AbortSignal fired. Never retried. */
export class RyuAbortError extends RyuError {
	constructor(init: RyuErrorSubclassInit) {
		super(subclassInit({ retryable: false, ...init }, "aborted"));
		this.name = "RyuAbortError";
	}
}

/** The server answered with a redirect. The SDK never follows one, so keys never change origin. */
export class RyuRedirectError extends RyuError {
	constructor(init: RyuErrorSubclassInit) {
		super(subclassInit({ retryable: false, ...init }, "redirect_refused"));
		this.name = "RyuRedirectError";
	}
}

/** 400, 413, 415 or 422: the request itself is wrong. */
export class RyuInvalidRequestError extends RyuError {
	constructor(init: RyuErrorSubclassInit) {
		super(subclassInit(init, describeStatus(init.status).code));
		this.name = "RyuInvalidRequestError";
	}
}

/** 401: the credential is missing, malformed or revoked. */
export class RyuAuthenticationError extends RyuError {
	constructor(init: RyuErrorSubclassInit) {
		super(subclassInit(init, "unauthenticated"));
		this.name = "RyuAuthenticationError";
	}
}

/** 402: billing refused the request. Never retried. */
export class RyuPaymentRequiredError extends RyuError {
	constructor(init: RyuErrorSubclassInit) {
		super(subclassInit(init, "payment_required"));
		this.name = "RyuPaymentRequiredError";
	}
}

/** 403: the credential is valid but lacks the permission or feature. */
export class RyuPermissionError extends RyuError {
	constructor(init: RyuErrorSubclassInit) {
		super(subclassInit(init, "forbidden"));
		this.name = "RyuPermissionError";
	}
}

/** 404. */
export class RyuNotFoundError extends RyuError {
	constructor(init: RyuErrorSubclassInit) {
		super(subclassInit(init, "not_found"));
		this.name = "RyuNotFoundError";
	}
}

/** 409, including idempotency conflicts and stale revisions. */
export class RyuConflictError extends RyuError {
	constructor(init: RyuErrorSubclassInit) {
		super(subclassInit(init, "conflict"));
		this.name = "RyuConflictError";
	}
}

/** 429: slow down. `retryAfterSeconds` says for how long when the server said so. */
export class RyuRateLimitError extends RyuError {
	constructor(init: RyuErrorSubclassInit) {
		super(subclassInit(init, "rate_limited"));
		this.name = "RyuRateLimitError";
	}
}

/** `quota_exceeded`: a persistent quota, not a burst limit. Never retried. */
export class RyuQuotaExceededError extends RyuRateLimitError {
	constructor(init: RyuErrorSubclassInit) {
		super({ retryable: false, ...init, code: init.code ?? "quota_exceeded" });
		this.name = "RyuQuotaExceededError";
	}
}

/** 503, or a feature that is off or not configured for this deployment. */
export class RyuUnavailableError extends RyuError {
	constructor(init: RyuErrorSubclassInit) {
		super(subclassInit(init, "service_unavailable"));
		this.name = "RyuUnavailableError";
	}
}

/** Any other 5xx. */
export class RyuServerError extends RyuError {
	constructor(init: RyuErrorSubclassInit) {
		super(subclassInit(init, describeStatus(init.status).code));
		this.name = "RyuServerError";
	}
}

/** A 2xx whose body was not the JSON the SDK expects. */
export class RyuResponseValidationError extends RyuError {
	constructor(init: RyuErrorSubclassInit) {
		super(subclassInit({ retryable: false, ...init }, "invalid_response"));
		this.name = "RyuResponseValidationError";
	}
}

/** The stable codes a webhook verifier fails with. */
export type RyuWebhookVerificationCode =
	| "webhook_missing_headers"
	| "webhook_invalid_secret"
	| "webhook_invalid_signature"
	| "webhook_timestamp_out_of_range"
	| "webhook_payload_invalid";

/** A webhook delivery failed verification. Answer it with 401 and do not process it. */
export class RyuWebhookVerificationError extends RyuError {
	constructor(
		init: Omit<RyuErrorSubclassInit, "code"> & {
			code: RyuWebhookVerificationCode;
		}
	) {
		super({ retryable: false, ...init });
		this.name = "RyuWebhookVerificationError";
	}
}

/** Codes that mean "this feature is off or not set up here", whatever the status. */
export const AVAILABILITY_CODES: ReadonlySet<string> = new Set([
	"managed_agents_disabled",
	"not_configured",
	"metering_unavailable",
]);

const INVALID_REQUEST_STATUSES: ReadonlySet<number> = new Set([
	400, 413, 415, 422,
]);

type RyuErrorClass = new (init: RyuErrorInit) => RyuError;

const STATUS_CLASSES: Readonly<Record<number, RyuErrorClass>> = {
	401: RyuAuthenticationError,
	402: RyuPaymentRequiredError,
	403: RyuPermissionError,
	404: RyuNotFoundError,
	409: RyuConflictError,
	429: RyuRateLimitError,
	503: RyuUnavailableError,
};

const STATUS_ZERO_CLASSES: Readonly<Record<string, RyuErrorClass>> = {
	aborted: RyuAbortError,
	configuration_error: RyuConfigurationError,
	connection_error: RyuConnectionError,
	// A path id refused before any request (`pathSegment`, the fetch shim, or a
	// wrapped `@ryuhq/client` client).
	invalid_id: RyuInvalidRequestError,
	invalid_response: RyuResponseValidationError,
	timeout: RyuTimeoutError,
};

function errorClassFor(status: number, code: string): RyuErrorClass {
	if (status === 0) {
		return STATUS_ZERO_CLASSES[code] ?? RyuError;
	}
	if ((status >= 300 && status < 400) || code === "redirect_refused") {
		return RyuRedirectError;
	}
	if (code === "quota_exceeded") {
		return RyuQuotaExceededError;
	}
	if (AVAILABILITY_CODES.has(code)) {
		return RyuUnavailableError;
	}
	const byStatus = STATUS_CLASSES[status];
	if (byStatus) {
		return byStatus;
	}
	if (INVALID_REQUEST_STATUSES.has(status)) {
		return RyuInvalidRequestError;
	}
	return status >= 500 ? RyuServerError : RyuError;
}

/** Builds the RyuError subclass that matches `init.status` and `init.code`. */
export function createRyuError(init: RyuErrorInit): RyuError {
	const ErrorClass = errorClassFor(init.status, init.code);
	return new ErrorClass(init);
}

/**
 * `error.toJSON()` without `name`, its message stripped of the appended hint
 * so a copy that replaces `hint` does not keep the old one in its message.
 */
function copyFields(error: RyuError): Omit<RyuErrorJSON, "name"> {
	const { name: _name, ...fields } = error.toJSON();
	return { ...fields, message: messageWithoutHint(error) };
}

/**
 * `overrides` with an override `message` equal to the error's own (hinted)
 * message replaced by the message without the hint, so a copy that also
 * replaces `hint` does not carry both hints.
 */
function overridesFor(
	error: RyuError,
	overrides: Partial<RyuErrorInit>
): Partial<RyuErrorInit> {
	return overrides.message === error.message
		? { ...overrides, message: messageWithoutHint(error) }
		: overrides;
}

/** The same error with some fields replaced; the subclass is chosen again from status and code. */
export function copyRyuError(
	error: RyuError,
	overrides: Partial<RyuErrorInit>
): RyuError {
	return createRyuError({
		...copyFields(error),
		cause: error.cause,
		...overridesFor(error, overrides),
	});
}

/** The same error with some fields replaced, keeping its subclass. */
export function withRyuErrorFields(
	error: RyuError,
	overrides: Partial<RyuErrorInit>
): RyuError {
	const fields = copyFields(error);
	const ErrorClass =
		error instanceof RyuError
			? (error.constructor as RyuErrorClass)
			: errorClassFor(fields.status, fields.code);
	return new ErrorClass({
		...fields,
		cause: error.cause,
		...overridesFor(error, overrides),
	});
}

/** Whether `value` is a RyuError (including errors from another copy of this package). */
export function isRyuError(value: unknown): value is RyuError {
	if (value instanceof RyuError) {
		return true;
	}
	return (
		value instanceof Error &&
		typeof (value as Partial<RyuError>).code === "string" &&
		typeof (value as Partial<RyuError>).service === "string" &&
		typeof (value as Partial<RyuError>).envelope === "string"
	);
}

// ---------------------------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------------------------

/** Error bodies are read once and capped here. */
export const MAX_ERROR_BODY_BYTES = 64 * 1024;
/** Characters of a non-JSON body kept as the message. */
const TEXT_MESSAGE_CHARS = 512;
const ERROR_TOKEN = /^[a-z][a-z0-9_]*$/u;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

/** Reads at most `limit` bytes of the body as text, then cancels the rest. */
async function readCappedText(
	response: Response,
	limit: number
): Promise<string> {
	if (!response.body) {
		return "";
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let total = 0;
	try {
		while (total < limit) {
			const chunk = await reader.read();
			if (chunk.done) {
				break;
			}
			const room = limit - total;
			const bytes =
				chunk.value.byteLength > room
					? chunk.value.subarray(0, room)
					: chunk.value;
			total += bytes.byteLength;
			text += decoder.decode(bytes, { stream: true });
		}
		text += decoder.decode();
	} catch {
		// A body that fails mid-read still yields what arrived.
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	return text;
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** The fields a body contributes, before headers are applied. */
interface BodyFields {
	code: string;
	details?: unknown;
	docs?: string;
	envelope: RyuErrorEnvelope;
	hint?: string;
	message: string;
	requestId?: string;
	retryAfterSeconds?: number;
	title?: string;
	type?: string;
}

function isProblem(body: JsonObject, contentType: string): boolean {
	return (
		contentType.includes("problem+json") ||
		(typeof body.type === "string" &&
			typeof body.title === "string" &&
			typeof body.status === "number")
	);
}

/**
 * RFC 9457 bodies. The standalone services keep their legacy members beside
 * the standard ones (`requestId`, a nested `error` with `code`, `details`,
 * `fields` or `requestId`, `retryAfterSeconds`), so those are read too.
 */
function problemFields(body: JsonObject, statusCode: string): BodyFields {
	const nested = isObject(body.error) ? body.error : undefined;
	let details: unknown = nested?.details ?? body.details;
	if (details === undefined && nested?.fields !== undefined) {
		details = { fields: nested.fields };
	}
	return {
		code: str(body.code) ?? str(nested?.code) ?? statusCode,
		details,
		docs: str(body.docs) ?? str(body.type),
		envelope: "problem+json",
		hint: str(body.hint),
		message:
			str(body.detail) ?? str(nested?.message) ?? str(body.title) ?? statusCode,
		requestId: str(body.requestId) ?? str(nested?.requestId),
		retryAfterSeconds: num(body.retryAfterSeconds) ?? num(nested?.retry_after),
		title: str(body.title),
		type: str(body.type),
	};
}

function nestedErrorFields(
	body: JsonObject,
	error: JsonObject,
	statusCode: string
): BodyFields {
	let envelope: RyuErrorEnvelope = "nested-error";
	if (typeof body.type === "string" && body.type.endsWith(".error")) {
		envelope = "ryu-service";
	} else if (typeof error.type === "string") {
		envelope = "openai";
	}
	let details: unknown = error.details;
	if (details === undefined && error.fields !== undefined) {
		details = { fields: error.fields };
	}
	return {
		code: str(error.code) ?? str(body.code) ?? str(error.type) ?? statusCode,
		details,
		envelope,
		message: str(error.message) ?? str(body.message) ?? statusCode,
		requestId: str(error.requestId) ?? str(body.requestId),
		retryAfterSeconds: num(error.retry_after) ?? num(body.retryAfterSeconds),
		type: envelope === "ryu-service" ? str(body.type) : undefined,
	};
}

function stringErrorFields(
	service: RyuService,
	body: JsonObject,
	error: string,
	statusCode: string
): BodyFields {
	const retryAfterSeconds = num(body.retryAfterSeconds);
	const code = str(body.code);
	if (code) {
		// Extra members (hosted Mail's `requiredScope`, Box's `retryable`/`hint`)
		// stay readable in `details`; `ok` only restates the failure.
		const {
			code: _code,
			error: _error,
			message: _message,
			ok: _ok,
			retryAfterSeconds: _retryAfterSeconds,
			...rest
		} = body;
		return {
			code,
			details: Object.keys(rest).length > 0 ? rest : undefined,
			envelope: "code-error",
			message: str(body.message) ?? error,
			retryAfterSeconds,
		};
	}
	const message = str(body.message);
	// `{error:"<code>", message}`. Passport's `error` is always prose, so it is never read as a code.
	if (message && ERROR_TOKEN.test(error) && service !== "passport") {
		const { error: _error, message: _message, ...rest } = body;
		return {
			code: error,
			details: Object.keys(rest).length > 0 ? rest : undefined,
			envelope: "messaging",
			message,
			retryAfterSeconds,
		};
	}
	return {
		code: statusCode,
		envelope: "error-string",
		message: error,
		retryAfterSeconds,
	};
}

function objectBodyFields(
	service: RyuService,
	body: JsonObject,
	contentType: string,
	statusCode: string
): BodyFields | null {
	if (isProblem(body, contentType)) {
		return problemFields(body, statusCode);
	}
	if (isObject(body.error)) {
		return nestedErrorFields(body, body.error, statusCode);
	}
	if (typeof body.error === "string") {
		return stringErrorFields(service, body, body.error, statusCode);
	}
	const code = str(body.code);
	if (code) {
		// Extra members (hosted Mail's `requiredScope`, Box's `retryable`/`hint`)
		// stay readable in `details`; `ok` only restates the failure.
		const {
			code: _code,
			error: _error,
			message: _message,
			ok: _ok,
			retryAfterSeconds: _retryAfterSeconds,
			...rest
		} = body;
		return {
			code,
			details: Object.keys(rest).length > 0 ? rest : undefined,
			envelope: "code-error",
			message: str(body.message) ?? code,
			retryAfterSeconds: num(body.retryAfterSeconds),
		};
	}
	const message = str(body.message);
	if (message) {
		return { code: statusCode, envelope: "error-message", message };
	}
	return null;
}

function bodyFields(
	service: RyuService,
	text: string,
	contentType: string,
	status: number
): BodyFields {
	const statusCode = describeStatus(status).code;
	if (text.trim() === "") {
		return {
			code: statusCode,
			envelope: "empty",
			message: describeStatus(status).title,
		};
	}
	const json = parseJson(text);
	if (isObject(json)) {
		const fields = objectBodyFields(service, json, contentType, statusCode);
		if (fields) {
			return fields;
		}
	}
	return {
		code: statusCode,
		envelope: "text",
		message: text.trim().slice(0, TEXT_MESSAGE_CHARS),
	};
}

/** Request facts the transport knows and the body does not. */
export interface ErrorRequestContext {
	attempts?: number;
	idempotencyKey?: string | null;
}

/**
 * A next step for a server error whose body carries none, keyed on the
 * service and the server's message. Servers that predate structured hints
 * (the self-hosted Mail server's bare `email transport is not configured`)
 * leave a newcomer at a dead end otherwise, and a 429 after failed
 * authentication (Notify's per-address backoff) looks like an ordinary rate
 * limit. The wording names server settings, not SDK calls, so the SDK, the
 * MCP tools and the CLI share it.
 */
export function knownServerHint(
	service: RyuService,
	status: number,
	message: string,
	problem: KnownHintProblem = {}
): { readonly docs: string; readonly hint: string } | null {
	const other = otherServiceNamed(service, problem);
	if (other !== null) {
		const urlEnv = SERVICE_URL_ENV[service];
		return {
			hint: `${urlEnv} points at ${HINT_SERVICE_TITLES[other]}, not ${HINT_SERVICE_TITLES[service]}: the error came from the other service. Set ${urlEnv} to the ${HINT_SERVICE_TITLES[service]} server's URL.`,
			docs: `${STANDALONE_DOCS_URL}/sdk/errors#default-hints`,
		};
	}
	if (
		service === "connect" &&
		status === 503 &&
		problem.code !== undefined &&
		problem.code !== null
	) {
		const lane = CONNECT_UNCONFIGURED_LANES[problem.code];
		if (lane !== undefined) {
			return {
				hint: `This Connect has no ${lane} configured. The operator sets it where Connect runs; a different key or URL, or a retry, will not help.`,
				docs: `${STANDALONE_DOCS_URL}/sdk/errors#default-hints`,
			};
		}
	}
	if (
		service === "connect" &&
		status === 403 &&
		problem.code !== undefined &&
		problem.code !== null
	) {
		const grant = CONNECT_DENIED_GRANTS[problem.code];
		if (grant !== undefined) {
			return {
				hint: `This Connect has not granted ${grant} to your tenant; Connect's tool search lists what it grants. The operator sets grants where Connect runs (allowedTools in RYU_CONNECT_MCP_SERVERS, or RYU_CONNECT_COMPOSIO_BINDINGS); a different key will not help.`,
				docs: `${STANDALONE_DOCS_URL}/sdk/errors#default-hints`,
			};
		}
	}
	if (
		service === "mail" &&
		status === 400 &&
		message.includes("email transport is not configured")
	) {
		return {
			hint: "The Mail server has no outbound email transport. Set RYU_SMTP_HOST and RYU_SMTP_PASSWORD (plus RYU_SMTP_PORT, RYU_SMTP_USERNAME and RYU_SMTP_FROM as needed) where the Mail server runs, restart it, and check that Mail status reports sendConfigured: true.",
			docs: `${STANDALONE_DOCS_URL}/mail#start-the-standalone-service`,
		};
	}
	if (status === 429 && FAILED_AUTHENTICATION.test(message)) {
		return {
			hint: "The service blocks an address for a while after repeated failed authentication, and refuses even a correct key until the block ends. Wait for the Retry-After delay, then fix the key before you retry, or the block starts again.",
			docs: `${STANDALONE_DOCS_URL}/sdk/errors#default-hints`,
		};
	}
	return null;
}

/** What {@link knownServerHint} reads from the error body besides its message. */
export interface KnownHintProblem {
	/** The error's stable code (`upstream_unconfigured`). */
	readonly code?: string | null;
	/** The body's docs URL. */
	readonly docs?: string | null;
	/** The problem `type` URI. */
	readonly type?: string | null;
}

/**
 * The service each standalone API reference page documents. A standalone
 * server's problem `type` and `docs` link to its own page, so a page for a
 * different service means the URL env var points at that service.
 */
const SERVICE_API_PAGES: Readonly<Record<string, RyuService>> = {
	"box-api": "box",
	"connect-api": "connect",
	"gateway-api": "gateway",
	"mail-api": "mail",
	"managed-agents-api": "managedAgents",
	"messaging-api": "messaging",
	"notify-api": "notify",
	"passport-api": "passport",
	"passport-fetch-api": "passport",
	"passport-mcp-api": "passport",
	"sites-api": "sites",
};

/** Services the control-plane host serves together; one naming another's page is not a wrong URL. */
const CONTROL_PLANE_SERVICES: ReadonlySet<RyuService> = new Set([
	"managedAgents",
	"messaging",
	"mail",
]);

/**
 * The env var holding each service's base URL. Module-private: config.ts
 * imports this module, so it cannot import config.ts ENV_VARS; config.test.ts
 * keeps the two in lockstep through knownServerHint.
 */
const SERVICE_URL_ENV: Readonly<Record<RyuService, string>> = {
	box: "RYU_BOX_URL",
	connect: "RYU_CONNECT_URL",
	gateway: "RYU_GATEWAY_URL",
	mail: "RYU_MAIL_URL",
	managedAgents: "RYU_API_URL",
	messaging: "RYU_API_URL",
	notify: "RYU_NOTIFY_URL",
	passport: "RYU_PASSPORT_URL",
	sites: "RYU_SITES_URL",
};

/** Product names for hints (kept in lockstep with config.ts SERVICE_TITLES). */
const HINT_SERVICE_TITLES: Readonly<Record<RyuService, string>> = {
	box: "Ryu Box",
	connect: "Ryu Connect",
	gateway: "Ryu Gateway",
	mail: "Ryu Mail",
	managedAgents: "Ryu Managed Agents",
	messaging: "Ryu Messaging",
	notify: "Ryu Notify",
	passport: "Ryu Passport",
	sites: "Ryu Sites",
};

const STANDALONE_API_PAGE_RE =
	/^https:\/\/docs\.ryuhq\.com\/docs\/standalone\/([a-z-]+-api)(?:[#?/]|$)/u;

/** The other service whose API page the error's `type` (then `docs`) names, or null. */
function otherServiceNamed(
	service: RyuService,
	problem: KnownHintProblem
): RyuService | null {
	for (const url of [problem.type, problem.docs]) {
		const page = url ? STANDALONE_API_PAGE_RE.exec(url)?.[1] : undefined;
		const named = page === undefined ? undefined : SERVICE_API_PAGES[page];
		if (named === undefined) {
			continue;
		}
		const sameHost =
			named === service ||
			(CONTROL_PLANE_SERVICES.has(named) &&
				CONTROL_PLANE_SERVICES.has(service));
		return sameHost ? null : named;
	}
	return null;
}

/**
 * Connect's 503 codes for a lane the operator has not configured, and the
 * lane each names. Retrying, or another key or URL, cannot fix them.
 */
const CONNECT_UNCONFIGURED_LANES: Readonly<Record<string, string>> = {
	upstream_unconfigured:
		"tool lane (native: RYU_CONNECT_MCP_SERVERS or RYU_CONNECT_COMPOSIO_BINDINGS; single-tenant compatibility mode: RYU_CONNECT_CORE_URL for search, RYU_CONNECT_GATEWAY_URL for execution)",
	upstream_invalid:
		"valid upstream URL (RYU_CONNECT_CORE_URL, RYU_CONNECT_GATEWAY_URL or RYU_CONNECT_MCP_UPSTREAM)",
	mcp_unconfigured: "MCP upstream (RYU_CONNECT_MCP_UPSTREAM)",
	native_composio_unavailable:
		"Composio lane (RYU_CONNECT_COMPOSIO_BINDINGS, or RYU_CONNECT_GATEWAY_URL in proxy mode)",
	skills_unavailable: "skill catalog (RYU_CONNECT_SKILLS_DIR)",
};

/**
 * Connect's 403 codes for a tool, toolkit or connection the operator has not
 * granted the tenant, and what each names. Connect runtime keys carry no
 * scopes, so another key cannot fix them.
 */
const CONNECT_DENIED_GRANTS: Readonly<Record<string, string>> = {
	connection_denied: "that Composio connection",
	tool_denied: "that tool (or its account)",
	toolkit_denied: "that toolkit",
};

/** A 429 whose message says it follows failed authentication (Notify's address backoff). */
const FAILED_AUTHENTICATION = /failed authentication/iu;

/** The public docs section the standalone service pages live under. */
const STANDALONE_DOCS_URL = "https://docs.ryuhq.com/docs/standalone";

/**
 * Reads a non-2xx (or 3xx) response into the matching RyuError subclass. The
 * body is read once (at most 64 KiB) and the detection order is: problem+json,
 * an object `error`, a string `error`, a bare `code`, a bare `message`, text,
 * then empty. `service` biases ambiguous shapes. Headers supply the request
 * id, `Retry-After`, RateLimit, deprecation and `WWW-Authenticate`.
 */
export async function parseErrorResponse(
	service: RyuService,
	response: Response,
	method: string,
	url: string,
	context: ErrorRequestContext = {}
): Promise<RyuError> {
	const text = await readCappedText(response, MAX_ERROR_BODY_BYTES);
	const { headers, status } = response;
	const fields = bodyFields(
		service,
		text,
		headers.get("content-type") ?? "",
		status
	);
	// A wrong-service hint replaces the other service's own hint, which
	// names that service's settings.
	const problem = { code: fields.code, docs: fields.docs, type: fields.type };
	const wrongService = otherServiceNamed(service, problem) !== null;
	const known =
		fields.hint && !wrongService
			? null
			: knownServerHint(service, status, fields.message, problem);
	return createRyuError({
		service,
		status,
		code: fields.code,
		message: fields.message,
		title: fields.title ?? describeStatus(status).title,
		type: fields.type ?? null,
		requestId: headers.get("x-request-id") ?? fields.requestId ?? null,
		retryAfterSeconds:
			parseRetryAfter(headers.get("retry-after")) ??
			fields.retryAfterSeconds ??
			null,
		rateLimit: readRateLimit(headers),
		deprecation: parseDeprecation(headers),
		details: fields.details,
		docs: wrongService
			? (known?.docs ?? null)
			: (fields.docs ?? known?.docs ?? null),
		hint: wrongService
			? (known?.hint ?? null)
			: (fields.hint ?? known?.hint ?? null),
		authChallenge: headers.get("www-authenticate"),
		envelope: fields.envelope,
		method: method.toUpperCase(),
		url,
		idempotencyKey: context.idempotencyKey ?? null,
		attempts: context.attempts ?? 1,
	});
}

// ---------------------------------------------------------------------------------------------
// Converting other errors
// ---------------------------------------------------------------------------------------------

/** What the facade knows about the call that failed, for errors raised inside a wrapped client. */
export interface ErrorCallContext {
	/** The call's own AbortSignal had fired when the error was raised. */
	aborted?: boolean;
	attempts?: number;
	deprecation?: RyuDeprecation | null;
	idempotencyKey?: string | null;
	/**
	 * The error the transport parsed from the call's last response, when that
	 * response failed. A client-raised error with the same status takes the
	 * `WWW-Authenticate` challenge from it, which the client's own error drops.
	 */
	lastFailure?: RyuError | null;
	method?: string;
	rateLimit?: RyuRateLimit | null;
	url?: string;
}

/** The fields of `@ryuhq/client`'s ManagedAgentsError, recognized without importing it. */
interface ManagedAgentsErrorLike extends Error {
	code: string;
	details: unknown;
	requestId: string | null;
	retryAfterSeconds: number | null;
	status: number;
}

/** Whether `value` is a `ManagedAgentsError` from `@ryuhq/client`. */
export function isManagedAgentsError(
	value: unknown
): value is ManagedAgentsErrorLike {
	return (
		value instanceof Error &&
		value.name === "ManagedAgentsError" &&
		typeof (value as Partial<ManagedAgentsErrorLike>).code === "string" &&
		typeof (value as Partial<ManagedAgentsErrorLike>).status === "number"
	);
}

/** The `@ryuhq/client` errors that carry its path-id refusal. */
const CLIENT_PATH_ID_ERRORS: ReadonlySet<string> = new Set([
	"ManagedAgentsError",
	"MessagingError",
	"RyuPathIdError",
]);

/**
 * `@ryuhq/client`'s refusal of an empty, `.` or `..` path id before any
 * request (`code: "invalid_id"`, `status: 0`): `RyuPathIdError` from Box,
 * Notify and Mail, or Messaging's and Managed Agents' own errors. Recognized
 * without importing them.
 */
function isClientPathIdError(value: unknown): value is Error {
	return (
		value instanceof Error &&
		CLIENT_PATH_ID_ERRORS.has(value.name) &&
		(value as { code?: unknown }).code === "invalid_id" &&
		(value as { status?: unknown }).status === 0
	);
}

/** `@ryuhq/client`'s code for a reply that did not carry the error envelope. */
const MANAGED_AGENTS_UNKNOWN_ERROR_CODE = "unknown_error";

/**
 * Converts a `ManagedAgentsError` (raised by the wrapped client in passthrough
 * mode) to the matching RyuError, keeping `requestId`, `details`,
 * `retryAfterSeconds` and the original as `cause`.
 */
export function fromManagedAgentsError(
	error: ManagedAgentsErrorLike,
	context: ErrorCallContext = {}
): RyuError {
	const code =
		error.code === MANAGED_AGENTS_UNKNOWN_ERROR_CODE
			? describeStatus(error.status).code
			: error.code;
	const failure = context.lastFailure ?? null;
	const sameResponse =
		failure !== null &&
		failure.status === error.status &&
		(error.requestId === null ||
			failure.requestId === null ||
			failure.requestId === error.requestId);
	return createRyuError({
		service: "managedAgents",
		status: error.status,
		code,
		message: error.message,
		title: error.status > 0 ? describeStatus(error.status).title : null,
		requestId: error.requestId,
		retryAfterSeconds: error.retryAfterSeconds,
		details: error.details,
		envelope: "managed-agents",
		cause: error,
		method: context.method,
		url: context.url,
		idempotencyKey: context.idempotencyKey,
		attempts: context.attempts,
		rateLimit: context.rateLimit,
		deprecation: context.deprecation,
		authChallenge: sameResponse ? failure.authChallenge : null,
	});
}

/** The fields of `@ryuhq/client`'s MessagingError, recognized without importing it. */
interface MessagingErrorLike extends Error {
	code: string;
	details: Record<string, unknown>;
	retryAfterSeconds: number | null;
	status: number;
}

/** Whether `value` is a `MessagingError` from `@ryuhq/client`. */
export function isMessagingError(value: unknown): value is MessagingErrorLike {
	return (
		value instanceof Error &&
		value.name === "MessagingError" &&
		typeof (value as Partial<MessagingErrorLike>).code === "string" &&
		typeof (value as Partial<MessagingErrorLike>).status === "number"
	);
}

/** `@ryuhq/client`'s Messaging code for a reply that did not carry the `{error, message}` body. */
const MESSAGING_UNKNOWN_ERROR_CODE = "unknown_error";

/**
 * Converts a `MessagingError` (raised by the wrapped client in passthrough
 * mode) to the matching RyuError: `code` is the server's `error` token,
 * `details` holds the rest of the body (`availableMicroUsd`, `limit` and
 * `window`, `messageRecord`, ...), and the original is kept as `cause`. The
 * request id and `WWW-Authenticate` come from the transport's parse of the
 * same response, which the client's own error drops.
 */
export function fromMessagingError(
	error: MessagingErrorLike,
	context: ErrorCallContext = {}
): RyuError {
	const code =
		error.code === MESSAGING_UNKNOWN_ERROR_CODE
			? describeStatus(error.status).code
			: error.code;
	const failure = context.lastFailure ?? null;
	const sameResponse = failure !== null && failure.status === error.status;
	const details =
		isObject(error.details) && Object.keys(error.details).length > 0
			? error.details
			: null;
	return createRyuError({
		service: "messaging",
		status: error.status,
		code,
		message: error.message,
		title: error.status > 0 ? describeStatus(error.status).title : null,
		requestId: sameResponse ? failure.requestId : null,
		retryAfterSeconds: error.retryAfterSeconds,
		details,
		envelope:
			error.code === MESSAGING_UNKNOWN_ERROR_CODE && sameResponse
				? failure.envelope
				: "messaging",
		cause: error,
		method: context.method,
		url: context.url,
		idempotencyKey: context.idempotencyKey,
		attempts: context.attempts,
		rateLimit: context.rateLimit,
		deprecation: context.deprecation,
		authChallenge: sameResponse ? failure.authChallenge : null,
	});
}

/** A DOMException or Error named `AbortError`, as fetch and body reads raise on abort. */
function isAbortError(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { name?: unknown }).name === "AbortError"
	);
}

function isNamedError(value: unknown, name: string): value is Error {
	return value instanceof Error && value.name === name;
}

/**
 * Any error a wrapped call raised, as a RyuError: RyuErrors pass through,
 * ManagedAgentsErrors and MessagingErrors convert, zod and JSON failures on a 2xx become
 * {@link RyuResponseValidationError}, an `AbortError` (or any error raised
 * once the call's signal fired) becomes {@link RyuAbortError}, and anything
 * else becomes a `client_error` with the original as `cause`.
 */
export function toRyuError(
	error: unknown,
	service: RyuService,
	context: ErrorCallContext = {}
): RyuError {
	if (isRyuError(error)) {
		return error;
	}
	const base = {
		service,
		status: 0,
		cause: error,
		method: context.method,
		url: context.url,
		idempotencyKey: context.idempotencyKey,
		attempts: context.attempts,
	};
	if (isClientPathIdError(error)) {
		return new RyuInvalidRequestError({
			...base,
			code: "invalid_id",
			envelope: "client",
			message: error.message,
			retryable: false,
		});
	}
	if (isManagedAgentsError(error)) {
		return fromManagedAgentsError(error, context);
	}
	if (isMessagingError(error)) {
		return fromMessagingError(error, context);
	}
	if (context.aborted === true || isAbortError(error)) {
		return new RyuAbortError({
			...base,
			message: `${SERVICE_TITLES[service]}: ${context.method ?? "the"} request was aborted by the caller.`,
		});
	}
	if (
		error instanceof SyntaxError ||
		isNamedError(error, "ZodError") ||
		isNamedError(error, "$ZodError")
	) {
		return new RyuResponseValidationError({
			...base,
			envelope: "client",
			message: `The ${service} response did not match the expected shape: ${error.message}`,
		});
	}
	return new RyuError({
		...base,
		code: "client_error",
		envelope: "client",
		message: error instanceof Error ? error.message : String(error),
		retryable: false,
	});
}
