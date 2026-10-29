import { z } from "zod";
import { wireJsonSchema } from "./wire-json.ts";

// packages/client/src/request.ts
//
// Internal HTTP helper. Native fetch handles transport; endpoint codecs own decoded responses.
// All domain modules (agents, sessions, spaces) build on this so base-URL and
// bearer auth live in exactly one place.

import type { RyuClientOptions } from "./types.ts";

/** Matches one or more trailing slashes for base-URL normalization. */
const TRAILING_SLASHES = /\/+$/;

/** Join a base URL and an API path without doubling slashes. */
export function buildUrl(options: RyuClientOptions, path: string): string {
	const base = options.baseUrl.replace(TRAILING_SLASHES, "");
	const suffix = path.startsWith("/") ? path : `/${path}`;
	return `${base}${suffix}`;
}

/** Build request headers, attaching the bearer token when present. */
type RyuHeaderMap = Extract<HeadersInit, Record<string, string>>;
const jwtProviderSchema = z.function({
	input: [],
	output: z.string().nullable(),
});

export function buildHeaders(
	options: RyuClientOptions,
	extra?: RyuHeaderMap
): RyuHeaderMap {
	const headers: RyuHeaderMap = {
		"Content-Type": "application/json",
		...extra,
	};
	if (options.token) {
		headers.Authorization = `Bearer ${options.token}`;
	}
	const provider = jwtProviderSchema.safeParse(options.userJwt);
	const userJwt = provider.success
		? z.string().nullable().parse(provider.data.call(options))
		: z.string().optional().parse(options.userJwt);
	if (userJwt) {
		headers["x-ryu-user-jwt"] = userJwt;
	}
	return headers;
}

/**
 * Perform a JSON request against Core and parse the response.
 * Throws an Error with the status code on a non-2xx response.
 */
export function request<T>(
	options: RyuClientOptions,
	path: string,
	init: RequestInit | undefined,
	decode: z.ZodType<T>["parse"]
): Promise<T>;
export function request(
	options: RyuClientOptions,
	path: string,
	init?: RequestInit
): Promise<z.core.util.JSONType | undefined>;
export async function request<T>(
	options: RyuClientOptions,
	path: string,
	init?: RequestInit,
	decode?: z.ZodType<T>["parse"]
) {
	const url = buildUrl(options, path);
	const headers = new Headers(init?.headers);
	if (!headers.has("Content-Type")) {
		headers.set("Content-Type", "application/json");
	}
	const authentication = buildHeaders(options);
	if (options.token) {
		headers.set("Authorization", authentication.Authorization ?? "");
	}
	if (authentication["x-ryu-user-jwt"]) {
		headers.set("x-ryu-user-jwt", authentication["x-ryu-user-jwt"]);
	}
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const resp = await fetchImpl(url, { ...init, headers });
	if (!resp.ok) {
		const text = await resp.text().catch(() => resp.statusText);
		throw new Error(`RyuClient: ${path} failed (${resp.status}): ${text}`);
	}
	// Some endpoints (DELETE, no-content) return an empty body.
	const text = await resp.text();
	const data = text ? wireJsonSchema.parse(JSON.parse(text)) : undefined;
	return decode ? decode(data) : data;
}
