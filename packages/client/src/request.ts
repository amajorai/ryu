// packages/client/src/request.ts
//
// Internal HTTP helper. No external dependencies: uses native fetch only.
// All domain modules (agents, sessions, spaces) build on this so base-URL and
// bearer auth live in exactly one place.

import type { RyuClientOptions } from "./types";

/** Matches one or more trailing slashes for base-URL normalization. */
const TRAILING_SLASHES = /\/+$/;

/** Join a base URL and an API path without doubling slashes. */
export function buildUrl(options: RyuClientOptions, path: string): string {
	const base = options.baseUrl.replace(TRAILING_SLASHES, "");
	const suffix = path.startsWith("/") ? path : `/${path}`;
	return `${base}${suffix}`;
}

/** Build request headers, attaching the bearer token when present. */
export function buildHeaders(
	options: RyuClientOptions,
	extra?: Record<string, string>
): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		...extra,
	};
	if (options.token) {
		headers.Authorization = `Bearer ${options.token}`;
	}
	return headers;
}

/**
 * Perform a JSON request against Core and parse the response.
 * Throws an Error with the status code on a non-2xx response.
 */
export async function request<T>(
	options: RyuClientOptions,
	path: string,
	init?: RequestInit
): Promise<T> {
	const url = buildUrl(options, path);
	const headers = buildHeaders(
		options,
		init?.headers as Record<string, string> | undefined
	);
	const resp = await fetch(url, { ...init, headers });
	if (!resp.ok) {
		const text = await resp.text().catch(() => resp.statusText);
		throw new Error(`RyuClient: ${path} failed (${resp.status}): ${text}`);
	}
	// Some endpoints (DELETE, no-content) return an empty body.
	const text = await resp.text();
	return (text ? JSON.parse(text) : undefined) as T;
}
