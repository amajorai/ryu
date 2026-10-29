// packages/services/src/transport/idempotency.ts
//
// Idempotency keys and route matching for the fetch shim (design §4 rule 5).
// A UUID satisfies every server: Managed Agents `^[A-Za-z0-9_-]{16,128}$`,
// Notify and Box (at most 128 characters), Mail (non-empty) and the
// control-plane host's `parseIdempotencyKey` (printable ASCII, at most 255).

import type {
	CapabilityIdempotentRoute,
	IdempotentRoute,
	NonReplaySafeRoute,
	ServiceRouteTable,
} from "../routes.ts";

const TRAILING_SLASHES = /\/+$/u;

/**
 * A fresh idempotency key: `crypto.randomUUID()` where the runtime has it,
 * otherwise a random string in the same alphabet (some React Native runtimes
 * omit Web Crypto). The key must be unique per request, not secret.
 */
export function newIdempotencyKey(): string {
	const cryptoImpl = globalThis.crypto as Crypto | undefined;
	if (typeof cryptoImpl?.randomUUID === "function") {
		return cryptoImpl.randomUUID();
	}
	const random = () => Math.random().toString(36).slice(2, 12);
	return `${Date.now().toString(36)}-${random()}${random()}${random()}`;
}

function templateMatches(template: string, path: string): boolean {
	const expected = template.split("/");
	const actual = path.split("/");
	if (expected.length !== actual.length) {
		return false;
	}
	return expected.every((segment, index) => {
		const value = actual[index] ?? "";
		if (segment.startsWith("{") && segment.endsWith("}")) {
			return value !== "";
		}
		return segment === value;
	});
}

/**
 * The request path relative to the service mount, or null when the URL is
 * outside the service (another origin, or not under base path + mount).
 */
export function relativeServicePath(
	baseUrl: string,
	mount: string,
	requestUrl: string
): string | null {
	let base: URL;
	let request: URL;
	try {
		base = new URL(baseUrl);
		request = new URL(requestUrl);
	} catch {
		return null;
	}
	if (base.origin !== request.origin) {
		return null;
	}
	const prefix = `${base.pathname.replace(TRAILING_SLASHES, "")}${mount}`;
	const path = request.pathname.replace(TRAILING_SLASHES, "") || "/";
	if (prefix === "") {
		return path;
	}
	if (path === prefix) {
		return "/";
	}
	return path.startsWith(`${prefix}/`) ? path.slice(prefix.length) : null;
}

/** The first of `routes` that `method` + `requestUrl` hits, or null. */
function findRoute<R extends { method: string; path: string }>(
	routes: readonly R[] | undefined,
	table: ServiceRouteTable,
	baseUrl: string,
	method: string,
	requestUrl: string
): R | null {
	if (routes === undefined || routes.length === 0) {
		return null;
	}
	const upper = method.toUpperCase();
	const path = relativeServicePath(baseUrl, table.mount, requestUrl);
	if (path === null) {
		return null;
	}
	return (
		routes.find(
			(route) => route.method === upper && templateMatches(route.path, path)
		) ?? null
	);
}

function isKeyableMethod(method: string): boolean {
	const upper = method.toUpperCase();
	return upper === "POST" || upper === "PATCH";
}

/**
 * The idempotent route `method` + `requestUrl` hits, or null. Only POST and
 * PATCH can match; GET, HEAD, PUT and DELETE never get keys.
 */
export function matchRoute(
	table: ServiceRouteTable,
	baseUrl: string,
	method: string,
	requestUrl: string
): IdempotentRoute | null {
	return isKeyableMethod(method)
		? findRoute(table.idempotent, table, baseUrl, method, requestUrl)
		: null;
}

/**
 * The capability-gated idempotent route `method` + `requestUrl` hits, or
 * null. The caller decides whether the server advertised its capability.
 */
export function matchCapabilityRoute(
	table: ServiceRouteTable,
	baseUrl: string,
	method: string,
	requestUrl: string
): CapabilityIdempotentRoute | null {
	return isKeyableMethod(method)
		? findRoute(table.capabilityIdempotent, table, baseUrl, method, requestUrl)
		: null;
}

/** The route-table entry that forbids replaying `method` + `requestUrl`, or null. */
export function matchNonReplaySafeRoute(
	table: ServiceRouteTable,
	baseUrl: string,
	method: string,
	requestUrl: string
): NonReplaySafeRoute | null {
	return findRoute(table.nonReplaySafe, table, baseUrl, method, requestUrl);
}
