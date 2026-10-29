// packages/services/src/transport/request.ts
//
// The JSON helper the thin clients (Gateway, Connect, Passport, Sites) build
// on. It runs over the service-scoped fetch, so auth, retries and typed errors
// come from the shim; this helper only builds the URL, serializes the body and
// decodes the reply. A malformed 2xx body raises SyntaxError (or the decoder's
// error), which the facade maps to RyuResponseValidationError.

import type { RyuFetch } from "@ryuhq/client";
import { RyuInvalidRequestError, type RyuService } from "../errors.ts";
import { SERVICE_TITLES } from "../service-titles.ts";

const TRAILING_SLASHES = /\/+$/u;

/** Query values; `undefined` entries are dropped. */
export type QueryParams = Record<string, string | number | boolean | undefined>;

/** One JSON request. */
export interface JsonRequest<T> {
	/** JSON-serialized when present. */
	body?: unknown;
	/** Validates the parsed body; the default returns it unchecked. */
	decode?: (value: unknown) => T;
	headers?: Record<string, string>;
	method?: string;
	/** Path relative to the base URL, starting with `/`. */
	path: string;
	query?: QueryParams;
	signal?: AbortSignal;
}

/**
 * `value` as one encoded path segment. `encodeURIComponent` leaves `.` and
 * `..` as they are, and a URL parser resolves those as dot segments
 * (`/projects/..` becomes `/`), so they, an empty value and a non-string are
 * refused with RyuInvalidRequestError (`invalid_id`) before any request.
 */
export function pathSegment(
	service: RyuService,
	value: unknown,
	name: string
): string {
	if (
		typeof value !== "string" ||
		value === "" ||
		value === "." ||
		value === ".."
	) {
		throw new RyuInvalidRequestError({
			service,
			status: 0,
			code: "invalid_id",
			message: `${SERVICE_TITLES[service]}: ${name} must be a non-empty id other than "." or "..".`,
			retryable: false,
		});
	}
	return encodeURIComponent(value);
}

/** The usage window bounds, in the order errors name them. */
const USAGE_BOUNDS = Object.keys({
	from: true,
	to: true,
} satisfies Record<keyof UsageWindow, true>) as (keyof UsageWindow)[];

/** A usage window: both bounds required. */
export interface UsageWindow {
	from: string;
	to: string;
}

/**
 * Throws RyuInvalidRequestError naming `from` and `to` when a usage query is
 * missing or lacks either bound, instead of crashing on `undefined` or sending
 * a request the server rejects.
 */
export function requireUsageWindow<Q extends UsageWindow>(
	service: RyuService,
	query: Q | undefined
): Q {
	const missing = USAGE_BOUNDS.filter(
		(field) => typeof query?.[field] !== "string" || query[field] === ""
	);
	if (query === undefined || query === null || missing.length > 0) {
		throw new RyuInvalidRequestError({
			service,
			status: 0,
			code: "invalid_request",
			message: `Ryu ${service}.usage: pass { from, to }, ISO 8601 times on whole UTC hours (missing ${missing.join(" and ")}).`,
			details: { missing },
			retryable: false,
		});
	}
	return query;
}

/** Joins a base URL, a path and query parameters. */
export function buildRequestUrl(
	baseUrl: string,
	path: string,
	query?: QueryParams
): string {
	const base = baseUrl.replace(TRAILING_SLASHES, "");
	const suffix = path.startsWith("/") ? path : `/${path}`;
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query ?? {})) {
		if (value !== undefined) {
			params.set(key, String(value));
		}
	}
	const search = params.toString();
	return `${base}${suffix}${search ? `?${search}` : ""}`;
}

/** Sends one request and returns the raw Response (for streams and binary bodies). */
export function requestRaw(
	fetch: RyuFetch,
	baseUrl: string,
	request: Omit<JsonRequest<unknown>, "decode">
): Promise<Response> {
	const headers: Record<string, string> = { ...request.headers };
	if (request.body !== undefined) {
		headers["content-type"] ??= "application/json";
	}
	return fetch(buildRequestUrl(baseUrl, request.path, request.query), {
		body: request.body === undefined ? null : JSON.stringify(request.body),
		headers,
		method: request.method ?? (request.body === undefined ? "GET" : "POST"),
		signal: request.signal ?? null,
	});
}

/**
 * Sends one JSON request and decodes the reply. An empty body (204) decodes
 * `undefined`. Non-2xx replies never reach here: the shim throws first.
 */
export async function requestJson<T = unknown>(
	fetch: RyuFetch,
	baseUrl: string,
	request: JsonRequest<T>
): Promise<T> {
	const response = await requestRaw(fetch, baseUrl, request);
	const text = await response.text();
	const value: unknown = text === "" ? undefined : JSON.parse(text);
	return request.decode ? request.decode(value) : (value as T);
}
