// packages/services/src/transport/fetch-shim.ts
//
// The service-scoped fetch handed to every wrapped `@ryuhq/client` client and
// thin client (design §4). The clients keep building URLs, bodies and decoders;
// this shim adds, in order:
//
// 1. origin scoping: a request to another origin (a signed S3 attachment URL)
//    goes straight to the underlying fetch with credentials stripped and none
//    of the rules below;
// 2. auth translation (Bearer -> `x-gateway-key` or `x-api-key` for hosted
//    Mail, per-route key swaps), removing every other credential header;
// 3. `Accept`, the server-runtime `User-Agent`, and per-call headers;
// 4. `redirect: "manual"`, refusing every redirect so keys never change origin;
// 5. `Idempotency-Key` on route-table POST/PATCH, fixed before the retry loop
//    (on a capability-gated route the SDK generates a key, and counts the
//    request as keyed for replay, only once the server advertised the
//    capability; a caller-supplied key is always forwarded);
// 6. a per-attempt timeout cleared once headers arrive;
// 7. replay-safe retries honouring Retry-After, RateLimit and body hints
//    (never a network/5xx replay of a route the table lists as non-replay-safe);
// 8. typed errors (`throw` mode) or untouched responses (`passthrough` mode);
// 9. response metadata and the deprecation hook.

import { isSafeRequestPath, type RyuFetch } from "@ryuhq/client";
import {
	type RyuHooks,
	type ServiceAuthScheme,
	transportFailureHint,
} from "../config.ts";
import {
	copyRyuError,
	messageWithoutHint,
	parseErrorResponse,
	RyuAbortError,
	RyuConfigurationError,
	RyuConnectionError,
	type RyuError,
	RyuInvalidRequestError,
	RyuRedirectError,
	type RyuService,
	RyuTimeoutError,
	redactUrl,
} from "../errors.ts";
import type { RyuResponseMeta } from "../result.ts";
import type { IdempotentRoute, ServiceRouteTable } from "../routes.ts";
import { SERVICE_TITLES } from "../service-titles.ts";
import { parseDeprecation, type RyuDeprecation } from "./deprecation.ts";
import {
	matchCapabilityRoute,
	matchNonReplaySafeRoute,
	matchRoute,
	newIdempotencyKey,
	relativeServicePath,
} from "./idempotency.ts";
import {
	parseRetryAfter,
	type RyuRateLimit,
	readRateLimit,
} from "./rate-limit.ts";
import {
	computeDelay,
	isReplayableBody,
	isReplaySafe,
	isRetryableFailure,
	type RetryHints,
	shouldRetry,
} from "./retry.ts";

/**
 * Sent when the client set no `Accept`. Services that negotiate RFC 9457
 * (the control-plane host, Notify, Box, Connect, Sites, Passport) then answer
 * errors as `application/problem+json`; the others keep their JSON envelope.
 * The error parser reads both forms.
 */
export const DEFAULT_ACCEPT =
	"application/problem+json, application/json;q=0.9, */*;q=0.8";

/** Headers that carry a credential; at most one survives, the one the service scheme uses. */
const CREDENTIAL_HEADERS = [
	"authorization",
	"x-api-key",
	"x-gateway-key",
] as const;
const BEARER_PREFIX = /^Bearer\s+/iu;

/** `throw`: the shim raises RyuError. `passthrough`: non-2xx responses go back to the client untouched. */
export type ServiceErrorMode = "throw" | "passthrough";

/** Selects a different key for some routes (Connect management, Passport runtime). */
export type RouteKeySelector = (request: {
	method: string;
	/** Path relative to the service mount, or null when unknown. */
	path: string | null;
}) => string | null | undefined;

/** Everything the shim needs about the service; built once per call from resolved config. */
export interface ServiceFetchConfig {
	apiKey: string | null;
	auth: ServiceAuthScheme;
	autoIdempotency: boolean;
	baseUrl: string;
	/**
	 * Whether the server advertises a capability a route-table entry depends
	 * on (`capabilityIdempotent`). Resolves false when unknown; the shim then
	 * adds no key of its own and replays nothing on that route (a key the
	 * caller supplied is still forwarded). Absent: every gated route is off.
	 */
	capability?: (name: string) => Promise<boolean>;
	/** Per-Ryu-instance set of (method, route) pairs already reported to `onDeprecation`. */
	deprecationSeen?: Set<string>;
	errors: ServiceErrorMode;
	/** The underlying fetch; default `globalThis.fetch`. */
	fetch?: RyuFetch;
	hooks?: RyuHooks;
	maxRetries: number;
	maxRetryDelayMs: number;
	/** Clock for hook durations; injectable for tests. */
	now?: () => number;
	/** Jitter source; injectable for tests. */
	random?: () => number;
	/**
	 * Adjusts a parsed error from the raw JSON body (undefined when the body
	 * is not JSON) before the retry decision; a result with `retryable: false`
	 * is never retried. Gateway maps `error.upstream_status` here.
	 */
	refineError?: (error: RyuError, body: unknown) => RyuError;
	/** Refines `code` for prose-only errors before the retry decision. */
	refineErrorCode?: (status: number, message: string) => string | null;
	routes: ServiceRouteTable;
	selectKey?: RouteKeySelector;
	service: RyuService;
	/** Waits between attempts; injectable for tests. Rejects when `signal` aborts. */
	sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
	timeoutMs: number;
	/** The User-Agent to send, or null for none (browsers, `userAgent: false`). */
	userAgent: string | null;
}

/** Options that apply to one call. */
export interface CallOptions {
	/** Extra request headers for this call. */
	headers?: Record<string, string>;
	/**
	 * Used for the first idempotent-route write of the call, replacing any
	 * client-generated key. Bound with `.with()`, it is spent by the first
	 * call that writes with it: a later call through the same bound namespace
	 * fails with `idempotency_key_reused` instead of being replayed.
	 */
	idempotencyKey?: string;
	signal?: AbortSignal;
	/** Overrides the instance `timeoutMs` for this call. */
	timeoutMs?: number;
}

/** The last HTTP request a call made, for errors raised by a wrapped client. */
export interface CallRequestRecord {
	attempts: number;
	deprecation: RyuDeprecation | null;
	idempotencyKey: string | null;
	method: string;
	rateLimit: RyuRateLimit | null;
	url: string;
}

/** State shared by every request one facade call makes. */
export interface CallContext {
	/**
	 * Shared by every call made through one `.with({ idempotencyKey })`
	 * namespace: `spent` once a write has used the bound key, so a later
	 * write through it fails instead of being answered with the first write's
	 * stored result.
	 */
	readonly boundKey?: { spent: boolean };
	/** Whether `options.idempotencyKey` was already spent on a request. */
	callerKeyUsed: boolean;
	/**
	 * The error parsed from the last response when it failed (passthrough
	 * mode), so a client-raised error can recover what its own type drops
	 * (the `WWW-Authenticate` challenge). Null after a successful response.
	 */
	lastFailure: RyuError | null;
	lastRequest: CallRequestRecord | null;
	/** Metadata of the last response. */
	meta: RyuResponseMeta | null;
	readonly options: CallOptions;
}

/** A fresh context for one call. */
export function createCallContext(
	options: CallOptions = {},
	boundKey?: { spent: boolean }
): CallContext {
	return {
		boundKey,
		callerKeyUsed: false,
		lastFailure: null,
		lastRequest: null,
		meta: null,
		options,
	};
}

interface NormalizedRequest {
	body: BodyInit | null;
	headers: Headers;
	init: RequestInit;
	method: string;
	signal: AbortSignal | null;
	url: string;
}

function normalizeRequest(
	input: RequestInfo | URL,
	init: RequestInit | undefined
): NormalizedRequest {
	if (typeof Request !== "undefined" && input instanceof Request) {
		const headers = new Headers(input.headers);
		for (const [name, value] of new Headers(init?.headers)) {
			headers.set(name, value);
		}
		return {
			body: init?.body ?? input.body,
			headers,
			init: init ?? {},
			method: (init?.method ?? input.method).toUpperCase(),
			signal: init?.signal ?? input.signal,
			url: input.url,
		};
	}
	return {
		body: init?.body ?? null,
		headers: new Headers(init?.headers),
		init: init ?? {},
		method: (init?.method ?? "GET").toUpperCase(),
		signal: init?.signal ?? null,
		url: input instanceof URL ? input.href : String(input),
	};
}

const BASE_TRAILING_SLASHES = /\/+$/u;
/** The WHATWG URL parser (what `fetch` uses) separates path segments on both. */
const PATH_SEPARATOR = /[/\\]/u;
/** The URL parser drops these anywhere in a URL. */
const STRIPPED_CHARACTERS = /[\t\n\r]/gu;

/**
 * Whether the raw request URL holds a path segment that a URL parser would
 * collapse or that names no resource: `.`, `..` (also `%2e` spellings), or an
 * empty segment after the base URL. The wrapped clients build paths with
 * `encodeURIComponent`, which leaves `.` and `..` as they are, so an id of
 * `..` would turn `DELETE /v1/boxes/b/previews/..` into `DELETE /v1/boxes/b`.
 * The segment scan is @ryuhq/client's own `isSafeRequestPath` (`\`
 * separates, tab/CR/LF vanish, each segment's edge controls and spaces are
 * trimmed); this function only finds the path after the base URL. Only
 * string and URL inputs are checked; a Request's URL is already parsed.
 */
export function hasUnsafePathSegment(baseUrl: string, url: string): boolean {
	const base = baseUrl.replace(BASE_TRAILING_SLASHES, "");
	if (base === "" || !url.startsWith(base)) {
		return false;
	}
	const rest = (url.slice(base.length).split(/[?#]/u, 1)[0] ?? "").replace(
		STRIPPED_CHARACTERS,
		""
	);
	if (rest === "" || rest === "/" || !PATH_SEPARATOR.test(rest.charAt(0))) {
		return false;
	}
	return !isSafeRequestPath(rest);
}

function originOf(url: string): string | null {
	try {
		return new URL(url).origin;
	} catch {
		return null;
	}
}

function callHook<E>(hook: ((event: E) => void) | undefined, event: E): void {
	try {
		hook?.(event);
	} catch {
		// Hooks are observers; a throwing hook never fails the request.
	}
}

function stripCredentials(headers: Headers, keep: string | null): void {
	for (const name of CREDENTIAL_HEADERS) {
		if (name !== keep) {
			headers.delete(name);
		}
	}
}

/** Rule 2: present the key the way the service expects and drop every other credential. */
function applyAuth(
	headers: Headers,
	config: ServiceFetchConfig,
	method: string,
	path: string | null
): void {
	const bearer =
		headers.get("authorization")?.replace(BEARER_PREFIX, "") ?? null;
	switch (config.auth) {
		case "x-gateway-key": {
			const key = bearer || config.apiKey;
			stripCredentials(headers, null);
			if (key) {
				headers.set("x-gateway-key", key);
			}
			return;
		}
		case "x-api-key": {
			// Managed Agents' client sets x-api-key itself; Mail's sends a Bearer.
			const key = headers.get("x-api-key") || bearer || config.apiKey;
			stripCredentials(headers, null);
			if (key) {
				headers.set("x-api-key", key);
			}
			return;
		}
		default: {
			stripCredentials(headers, "authorization");
			const override = config.selectKey?.({ method, path });
			if (override) {
				headers.set("authorization", `Bearer ${override}`);
			}
		}
	}
}

/** Rule 3: Accept, User-Agent and the call's own headers. */
function applyHeaders(
	headers: Headers,
	config: ServiceFetchConfig,
	callHeaders: Record<string, string> | undefined
): void {
	if (!headers.has("accept")) {
		headers.set("accept", DEFAULT_ACCEPT);
	}
	if (config.userAgent) {
		headers.set("user-agent", config.userAgent);
	}
	for (const [name, value] of Object.entries(callHeaders ?? {})) {
		headers.set(name, value);
	}
}

/**
 * Rule 5: decide the key once, before any attempt. A key the caller supplied
 * (bound with `.with({ idempotencyKey })` or set as a header) is sent on any
 * matched route; an SDK-generated key only when the route is `supported`
 * (a capability-gated route whose capability is false or unknown is not).
 */
function chooseIdempotencyKey(
	headers: Headers,
	resolution: RouteResolution,
	config: ServiceFetchConfig,
	ctx: CallContext
): string | null {
	const existing = headers.get("idempotency-key");
	const { route, supported } = resolution;
	if (route === null) {
		return existing;
	}
	let key: string | null = existing;
	if (ctx.options.idempotencyKey && !ctx.callerKeyUsed) {
		if (ctx.boundKey?.spent) {
			throw new RyuConfigurationError({
				service: config.service,
				status: 0,
				code: "idempotency_key_reused",
				message: `${SERVICE_TITLES[config.service]}: the idempotency key bound with .with({ idempotencyKey }) was already used by a write through this namespace, and the server would answer this write with that write's stored result. Bind a new key per operation; to retry the same operation, call .with({ idempotencyKey }) again.`,
			});
		}
		key = ctx.options.idempotencyKey;
		ctx.callerKeyUsed = true;
		if (ctx.boundKey) {
			ctx.boundKey.spent = true;
		}
	} else if (key === null && supported && config.autoIdempotency) {
		key = newIdempotencyKey();
	}
	if (key !== null) {
		headers.set("Idempotency-Key", key);
	}
	return key;
}

function defaultSleep(
	ms: number,
	signal: AbortSignal | undefined
): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** One signal that fires when any input fires, plus a cleanup for the listeners it added. */
interface LinkedSignal {
	dispose(): void;
	signal: AbortSignal | undefined;
}

/**
 * Links `signals` without leaving listeners behind on long-lived inputs (an
 * app-wide shutdown signal shared by many calls). `AbortSignal.any` holds its
 * inputs weakly; the fallback for runtimes without it adds listeners that
 * `dispose` removes.
 */
export function linkSignals(signals: readonly AbortSignal[]): LinkedSignal {
	const noop = () => undefined;
	if (signals.length === 0) {
		return { dispose: noop, signal: undefined };
	}
	if (signals.length === 1) {
		return { dispose: noop, signal: signals[0] };
	}
	if (typeof AbortSignal.any === "function") {
		return { dispose: noop, signal: AbortSignal.any([...signals]) };
	}
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	const dispose = () => {
		for (const signal of signals) {
			signal.removeEventListener("abort", onAbort);
		}
	};
	for (const signal of signals) {
		if (signal.aborted) {
			controller.abort();
			return { dispose: noop, signal: controller.signal };
		}
		signal.addEventListener("abort", onAbort, { once: true });
	}
	return { dispose, signal: controller.signal };
}

/** Most distinct (method, route) pairs one Ryu instance remembers for `onDeprecation`. */
const DEPRECATION_SEEN_LIMIT = 256;
const DIGIT = /\d/u;
const VERSION_SEGMENT = /^v\d+$/u;
const ID_SEGMENT_MIN_LENGTH = 20;

/**
 * A request path with resource ids folded to `{id}`, so `onDeprecation` fires
 * once per route rather than once per resource. A segment counts as an id
 * when it carries a digit (other than a `v1`-style version), is long, or is
 * percent-encoded; route words in the services' APIs are short, digit-free
 * words.
 */
export function routeTemplate(path: string): string {
	return path
		.split("/")
		.map((segment) =>
			!VERSION_SEGMENT.test(segment) &&
			(DIGIT.test(segment) ||
				segment.length >= ID_SEGMENT_MIN_LENGTH ||
				segment.includes("%"))
				? "{id}"
				: segment
		)
		.join("/");
}

/** Remembers `key`, evicting the oldest entry past the limit. True when it was new. */
function rememberOnce(seen: Set<string>, key: string): boolean {
	if (seen.has(key)) {
		return false;
	}
	seen.add(key);
	if (seen.size > DEPRECATION_SEEN_LIMIT) {
		const oldest = seen.values().next().value;
		if (oldest !== undefined) {
			seen.delete(oldest);
		}
	}
	return true;
}

/** Reads `field === true` from a JSON response body without consuming it. */
async function readReplayedFlag(
	response: Response,
	field: string,
	value: string | boolean
): Promise<boolean> {
	if (
		response.body === null ||
		!(response.headers.get("content-type") ?? "").includes("json")
	) {
		return false;
	}
	try {
		const body: unknown = await response.clone().json();
		return (
			typeof body === "object" &&
			body !== null &&
			(body as Record<string, unknown>)[field] === value
		);
	} catch {
		return false;
	}
}

/**
 * A runtime's network error message with the request's query string and the
 * service key removed: some runtimes quote the full URL, and a query can carry
 * a token.
 */
function scrubMessage(
	message: string,
	url: string,
	apiKey: string | null
): string {
	let scrubbed = message.split(url).join(redactUrl(url));
	if (apiKey) {
		scrubbed = scrubbed.split(apiKey).join("[redacted]");
	}
	return scrubbed;
}

function isRedirect(response: Response): boolean {
	return (
		response.type === "opaqueredirect" ||
		(response.status >= 300 && response.status < 400)
	);
}

/** The origin of a `Location` header, never its path or query, which can carry login state. */
function locationOrigin(response: Response, url: string): string | null {
	const location = response.headers.get("location");
	if (location === null) {
		return null;
	}
	try {
		return new URL(location, url).origin;
	} catch {
		return null;
	}
}

/** Largest error body `refineError` sees; Gateway's JSON envelope is far smaller. */
const MAX_REFINE_BODY_BYTES = 64 * 1024;

/**
 * A response body parsed as JSON, or undefined when it is not JSON or larger
 * than {@link MAX_REFINE_BODY_BYTES}. Reads at most that many bytes (plus one
 * chunk) and cancels the rest, so an endless error body is never buffered.
 */
async function readJsonBody(response: Response): Promise<unknown> {
	if (!response.body) {
		return undefined;
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let total = 0;
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) {
				break;
			}
			total += chunk.value.byteLength;
			if (total > MAX_REFINE_BODY_BYTES) {
				return undefined;
			}
			text += decoder.decode(chunk.value, { stream: true });
		}
		text += decoder.decode();
		return JSON.parse(text);
	} catch {
		return undefined;
	} finally {
		await reader.cancel().catch(() => undefined);
	}
}

/** Whether the shim would send an `Idempotency-Key` on a keyed route for this request. */
function wouldSendKey(
	headers: Headers,
	config: ServiceFetchConfig,
	ctx: CallContext
): boolean {
	return (
		headers.has("idempotency-key") ||
		(ctx.options.idempotencyKey !== undefined && !ctx.callerKeyUsed) ||
		config.autoIdempotency
	);
}

/**
 * The route-table entry that keys this request, and whether the server is
 * known to deduplicate it.
 */
interface RouteResolution {
	route: IdempotentRoute | null;
	/**
	 * True for a plain idempotent route, and for a capability-gated one only
	 * once the server advertised the capability. Only a supported route gets
	 * an SDK-generated key and counts as keyed for the replay decision.
	 */
	supported: boolean;
}

const NO_ROUTE: RouteResolution = { route: null, supported: false };

/**
 * Resolves the request's route. A capability-gated route whose capability is
 * false or unknown (the probe failed) is unsupported: a caller-supplied key
 * is still forwarded (an older server ignores it, a newer one whose probe
 * failed still deduplicates the caller's own retry), but the SDK adds no key
 * of its own and never replays the request: fail closed.
 */
async function resolveRoute(
	config: ServiceFetchConfig,
	ctx: CallContext,
	request: NormalizedRequest
): Promise<RouteResolution> {
	const route = matchRoute(
		config.routes,
		config.baseUrl,
		request.method,
		request.url
	);
	if (route !== null) {
		return { route, supported: true };
	}
	const gated = matchCapabilityRoute(
		config.routes,
		config.baseUrl,
		request.method,
		request.url
	);
	if (gated === null || !wouldSendKey(request.headers, config, ctx)) {
		return NO_ROUTE;
	}
	let supported = false;
	try {
		supported = (await config.capability?.(gated.capability)) === true;
	} catch {
		supported = false;
	}
	return { route: gated, supported };
}

type AttemptOutcome = { error: RyuError } | { response: Response };

interface AttemptPlan {
	attempt: number;
	callerSignals: AbortSignal[];
	idempotencyKey: string | null;
	request: NormalizedRequest;
}

/**
 * Creates the fetch for one call to `config.service`. Every request the
 * wrapped client makes during the call goes through it and shares `ctx`.
 */
export function createServiceFetch(
	config: ServiceFetchConfig,
	ctx: CallContext
): RyuFetch {
	const underlying: RyuFetch =
		config.fetch ?? ((input, init) => globalThis.fetch(input, init));
	const sleep = config.sleep ?? defaultSleep;
	const now = config.now ?? Date.now;
	const serviceOrigin = originOf(config.baseUrl);

	const errorBase = (plan: AttemptPlan) => ({
		service: config.service,
		status: 0,
		method: plan.request.method,
		url: plan.request.url,
		idempotencyKey: plan.idempotencyKey,
		attempts: plan.attempt,
	});

	const attemptOnce = async (plan: AttemptPlan): Promise<AttemptOutcome> => {
		const { request } = plan;
		const timeout = new AbortController();
		const callerAborted = () =>
			plan.callerSignals.some((signal) => signal.aborted);
		// The fetch signal outlives the attempt (it must still cut a streamed body
		// off), so it is linked rather than wired up with listeners.
		const linked = linkSignals([...plan.callerSignals, timeout.signal]);
		const timeoutMs = ctx.options.timeoutMs ?? config.timeoutMs;
		let timedOut = false;
		const timer =
			timeoutMs > 0 && Number.isFinite(timeoutMs)
				? setTimeout(() => {
						timedOut = true;
						timeout.abort();
					}, timeoutMs)
				: undefined;
		let keepLinked = false;
		try {
			if (callerAborted()) {
				throw new Error("aborted before the request started");
			}
			const response = await underlying(request.url, {
				...request.init,
				body: request.body,
				headers: request.headers,
				method: request.method,
				redirect: "manual",
				signal: linked.signal,
			});
			// A body still streaming needs the caller's abort; anything else is done with it.
			keepLinked = response.body !== null;
			return { response };
		} catch (error) {
			if (callerAborted()) {
				return {
					error: new RyuAbortError({
						...errorBase(plan),
						cause: error,
						message: `${SERVICE_TITLES[config.service]}: ${request.method} request was aborted by the caller.`,
					}),
				};
			}
			if (timedOut) {
				return {
					error: new RyuTimeoutError({
						...errorBase(plan),
						cause: error,
						hint: transportFailureHint(config.service, "timeout", request.url),
						message: `${SERVICE_TITLES[config.service]}: ${request.method} got no response within ${timeoutMs} ms.`,
					}),
				};
			}
			return {
				error: new RyuConnectionError({
					...errorBase(plan),
					cause: error,
					hint: transportFailureHint(
						config.service,
						"connection_error",
						request.url
					),
					message: `${SERVICE_TITLES[config.service]}: ${request.method} request failed before a response: ${scrubMessage(
						error instanceof Error ? error.message : String(error),
						request.url,
						config.apiKey
					)}`,
				}),
			};
		} finally {
			// Headers arrived (or the attempt failed): a streamed body must not be cut off.
			clearTimeout(timer);
			if (!keepLinked) {
				linked.dispose();
			}
		}
	};

	const isReplayed = async (
		response: Response,
		route: IdempotentRoute | null
	): Promise<boolean> => {
		if (response.headers.get("idempotent-replayed") === "true") {
			return true;
		}
		const field = config.routes.replayedBodyField;
		return field !== undefined && route !== null && response.ok
			? await readReplayedFlag(
					response,
					field,
					config.routes.replayedBodyValue ?? true
				)
			: false;
	};

	const recordResponse = async (
		plan: AttemptPlan,
		response: Response,
		route: IdempotentRoute | null,
		path: string | null
	): Promise<void> => {
		const rateLimit = readRateLimit(response.headers);
		const deprecation = parseDeprecation(response.headers);
		ctx.lastFailure = null;
		// The idempotency facts stick for the whole call: a composite call that
		// writes and then reads (box.run, notify.requestApproval) still reports
		// the write's key and whether the server replayed it.
		const previous = ctx.meta;
		const replayed = await isReplayed(response, route);
		ctx.meta = {
			attempts: plan.attempt,
			deprecation,
			idempotencyKey: plan.idempotencyKey ?? previous?.idempotencyKey ?? null,
			rateLimit,
			replayed: replayed || (previous?.replayed ?? false),
			requestId: response.headers.get("x-request-id"),
			status: response.status,
		};
		ctx.lastRequest = {
			attempts: plan.attempt,
			deprecation,
			idempotencyKey: plan.idempotencyKey,
			method: plan.request.method,
			rateLimit,
			url: plan.request.url,
		};
		if (deprecation && config.hooks?.onDeprecation) {
			const template =
				route?.path ??
				routeTemplate(path ?? plan.request.url.split("?")[0] ?? "");
			const routeKey = `${plan.request.method} ${template}`;
			const seen = config.deprecationSeen;
			if (seen === undefined || rememberOnce(seen, routeKey)) {
				callHook(config.hooks.onDeprecation, {
					...deprecation,
					method: plan.request.method,
					service: config.service,
					url: plan.request.url.split("?")[0] ?? plan.request.url,
				});
			}
		}
	};

	return async (input, init) => {
		const request = normalizeRequest(input, init);
		// Rule 1: another origin gets the bare request, minus any credential.
		if (serviceOrigin === null || originOf(request.url) !== serviceOrigin) {
			stripCredentials(request.headers, null);
			return underlying(request.url, {
				...request.init,
				body: request.body,
				headers: request.headers,
				method: request.method,
			});
		}
		if (
			!(typeof Request !== "undefined" && input instanceof Request) &&
			hasUnsafePathSegment(config.baseUrl, request.url)
		) {
			// Refused before any request, in every error mode: the id would
			// collapse onto another route (or name none).
			throw new RyuInvalidRequestError({
				service: config.service,
				status: 0,
				code: "invalid_id",
				method: request.method,
				url: request.url,
				message: `${SERVICE_TITLES[config.service]}: a path id must be a non-empty id other than "." or "..".`,
				retryable: false,
			});
		}
		const path = relativeServicePath(
			config.baseUrl,
			config.routes.mount,
			request.url
		);
		applyAuth(request.headers, config, request.method, path);
		applyHeaders(request.headers, config, ctx.options.headers);
		const resolution = await resolveRoute(config, ctx, request);
		const { route } = resolution;
		const idempotencyKey = chooseIdempotencyKey(
			request.headers,
			resolution,
			config,
			ctx
		);
		const isStream = (request.headers.get("accept") ?? "").includes(
			"text/event-stream"
		);
		const replayableBody = isReplayableBody(request.body);
		const replaySafe =
			matchNonReplaySafeRoute(
				config.routes,
				config.baseUrl,
				request.method,
				request.url
			) === null &&
			isReplaySafe({
				body: request.body,
				hasRouteIdempotencyKey:
					resolution.supported && route !== null && idempotencyKey !== null,
				method: request.method,
			});
		const callerSignals = [request.signal, ctx.options.signal].filter(
			(signal): signal is AbortSignal => signal !== null && signal !== undefined
		);
		const maxAttempts = isStream ? 1 : 1 + Math.max(0, config.maxRetries);
		const redactedUrl = request.url.split("?")[0] ?? request.url;

		for (let attempt = 1; ; attempt += 1) {
			const plan: AttemptPlan = {
				attempt,
				callerSignals,
				idempotencyKey,
				request,
			};
			const event = {
				attempt,
				method: request.method,
				service: config.service,
				url: redactedUrl,
			};
			callHook(config.hooks?.onRequest, event);
			const started = now();
			const outcome = await attemptOnce(plan);
			let failure: RyuError;
			let hints: RetryHints = {
				bodyRetryAfterSeconds: null,
				rateLimitRemaining: null,
				rateLimitResetSeconds: null,
				retryAfterSeconds: null,
			};
			let failedResponse: Response | null = null;
			if ("error" in outcome) {
				failure = outcome.error;
				if (failure instanceof RyuAbortError) {
					throw failure;
				}
			} else {
				const { response } = outcome;
				callHook(config.hooks?.onResponse, {
					...event,
					durationMs: now() - started,
					requestId: response.headers.get("x-request-id"),
					status: response.status,
				});
				if (response.ok) {
					await recordResponse(plan, response, route, path);
					return response;
				}
				if (isRedirect(response)) {
					await recordResponse(plan, response, route, path);
					if (config.errors === "passthrough") {
						return response;
					}
					await response.body?.cancel().catch(() => undefined);
					throw new RyuRedirectError({
						...errorBase(plan),
						status: response.status,
						details: { location: locationOrigin(response, request.url) },
						envelope: "empty",
						message: `${SERVICE_TITLES[config.service]}: ${request.method} was redirected (${response.status}); the SDK never follows redirects, so check the base URL.`,
						requestId: response.headers.get("x-request-id"),
					});
				}
				const rawBody = config.refineError ? response.clone() : null;
				failure = await parseErrorResponse(
					config.service,
					config.errors === "passthrough" ? response.clone() : response,
					request.method,
					request.url,
					{ attempts: attempt, idempotencyKey }
				);
				const refined =
					config.refineErrorCode?.(
						failure.status,
						messageWithoutHint(failure)
					) ?? null;
				if (refined !== null && refined !== failure.code) {
					failure = copyRyuError(failure, {
						code: refined,
						retryable: isRetryableFailure(failure.status, refined),
					});
				}
				if (rawBody !== null && config.refineError) {
					failure = config.refineError(failure, await readJsonBody(rawBody));
				}
				const headerRetryAfter = parseRetryAfter(
					response.headers.get("retry-after")
				);
				hints = {
					bodyRetryAfterSeconds:
						headerRetryAfter === null ? failure.retryAfterSeconds : null,
					rateLimitRemaining: failure.rateLimit?.remaining ?? null,
					rateLimitResetSeconds: failure.rateLimit?.resetSeconds ?? null,
					retryAfterSeconds: headerRetryAfter,
				};
				failedResponse = response;
			}

			const retry =
				attempt < maxAttempts &&
				failure.retryable &&
				shouldRetry({
					...hints,
					code: failure.code,
					replayableBody,
					replaySafe,
					status: failure.status,
				});
			const delay = retry
				? computeDelay(attempt - 1, hints, config.random)
				: null;
			if (delay !== null && delay.delayMs <= config.maxRetryDelayMs) {
				await failedResponse?.body?.cancel().catch(() => undefined);
				callHook(config.hooks?.onRetry, {
					...event,
					code: failure.code,
					delayMs: delay.delayMs,
					status: failure.status,
				});
				// Any caller signal (the request's own or the call's) cuts the wait short.
				const waitSignal = linkSignals(callerSignals);
				try {
					await sleep(delay.delayMs, waitSignal.signal);
				} catch (error) {
					throw new RyuAbortError({
						...errorBase(plan),
						cause: error,
						message: `${SERVICE_TITLES[config.service]}: ${request.method} was aborted while waiting to retry.`,
					});
				} finally {
					waitSignal.dispose();
				}
				continue;
			}
			if (
				delay !== null &&
				delay.source !== "backoff" &&
				failure.retryAfterSeconds === null
			) {
				// The server asked for a longer wait than maxRetryDelayMs: surface it instead.
				// SDK backoff is never reported as if the server had asked for it.
				failure = copyRyuError(failure, {
					retryAfterSeconds: Math.ceil(delay.delayMs / 1000),
				});
			}
			if (failedResponse) {
				await recordResponse(plan, failedResponse, route, path);
				ctx.lastFailure = failure;
				if (config.errors === "passthrough") {
					return failedResponse;
				}
			} else {
				ctx.lastRequest = {
					attempts: attempt,
					deprecation: null,
					idempotencyKey,
					method: request.method,
					rateLimit: null,
					url: request.url,
				};
			}
			throw failure;
		}
	};
}
