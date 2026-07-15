// packages/core-client/src/client.ts
//
// Platform-agnostic HTTP plumbing for the typed Core/Gateway client modules.
// Every domain module (agents, system, engines, chat, ...) builds on these
// helpers so bearer auth and base-URL handling live in exactly one place. The
// base URL + token always come from the caller's active node ({ url, token }),
// never hardcoded — Core listens on :7980 but the active node may be remote.
//
// This module intentionally has NO platform dependencies (no localStorage, no
// Tauri, no React) so it is shared verbatim by the desktop (Tauri webview) and
// the mobile app (React Native / Expo). Surface-specific concerns (the desktop
// buyer-token / presence headers, the mobile secure-store token) are layered on
// top by each app, not here.

/** The subset of a node the api layer needs: base URL + optional bearer token. */
export interface ApiTarget {
	token: string | null;
	url: string;
}

/**
 * The request header naming the CALLING SURFACE so Core can filter its plugin
 * list/catalog/contributions to what actually runs there. The value is one of
 * Core's kebab-case `Surface` tokens (`gateway|core|desktop|island|mobile|
 * extension|web|cli`); a request WITHOUT it gets an UNFILTERED list. Kept here
 * (the base module) because every domain call routes through {@link makeHeaders}.
 */
export const SURFACE_HEADER = "X-Ryu-Surface";

/**
 * Surface-injected source of the calling surface's kebab-case token (see
 * {@link SURFACE_HEADER}). This one shared client serves BOTH native and tui, so
 * it must NOT hardcode a surface — each app wires it at entry (native →
 * `"mobile"`, tui → `"cli"`). Defaults to "no surface" so an unwired consumer
 * behaves exactly as before (unfiltered), never asserting a wrong surface.
 */
let surfaceProvider: () => string | null = () => null;

/** Wire the surface-token getter (mirrors {@link setBuyerTokenProvider}). */
export function setSurfaceProvider(fn: () => string | null): void {
	surfaceProvider = fn;
}

/** Build request headers, attaching the bearer token and surface when present. */
export function makeHeaders(token: string | null): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}
	// Every core-client call flows through here, so setting the provider once at
	// app entry makes ALL requests (incl. the direct-fetch fetchApps) carry the
	// surface filter — no per-call plumbing.
	const surface = surfaceProvider();
	if (surface) {
		headers[SURFACE_HEADER] = surface;
	}
	return headers;
}

/** Join a node base URL and an api path without doubling slashes. */
export function apiUrl(target: ApiTarget, path: string): string {
	const base = target.url.replace(/\/$/, "");
	const suffix = path.startsWith("/") ? path : `/${path}`;
	return `${base}${suffix}`;
}

export interface RequestOptions {
	/** JSON-serializable body; serialized and sent with a JSON content-type. */
	body?: unknown;
	/** Extra headers merged over the defaults (e.g. the marketplace buyer token). */
	headers?: Record<string, string>;
	method?: string;
	signal?: AbortSignal;
}

/**
 * The dedicated header carrying the user's CONTROL-PLANE (Better-Auth) session
 * bearer to Core on a marketplace install, so a PAID item's entitlement check
 * can resolve the buyer org + license. Kept distinct from `Authorization` (which
 * holds the Core node token, a machine secret the control plane does not
 * recognize as a user). Core forwards this to the marketplace install handoff.
 */
export const BUYER_TOKEN_HEADER = "X-Ryu-Buyer-Token";

/**
 * Surface-injected source of the control-plane (Better-Auth) session token used
 * for marketplace install entitlement. Desktop wires this to its localStorage
 * token; mobile wires it to its secure-store token. Defaults to "no token" so
 * the shared client never assumes a platform storage API.
 */
let buyerTokenProvider: () => string | null = () => null;

/** Wire the surface's control-plane session-token getter (see above). */
export function setBuyerTokenProvider(fn: () => string | null): void {
	buyerTokenProvider = fn;
}

/**
 * Build the buyer-token header from the injected control-plane session token, or
 * `{}` when not signed in (an anonymous install — fine for free items; a paid
 * item is denied with an actionable error).
 */
export function buyerTokenHeader(): Record<string, string> {
	const token = buyerTokenProvider();
	return token ? { [BUYER_TOKEN_HEADER]: token } : {};
}

/**
 * Perform a JSON request against a node and parse the response.
 *
 * Throws an {@link Error} with the status code on a non-2xx response so callers
 * can degrade gracefully (the status spine relies on this to flag Core as down).
 */
export async function request<T>(
	target: ApiTarget,
	path: string,
	options: RequestOptions = {}
): Promise<T> {
	const resp = await fetch(apiUrl(target, path), {
		method: options.method ?? "GET",
		headers: { ...makeHeaders(target.token), ...options.headers },
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
		signal: options.signal,
	});
	if (!resp.ok) {
		throw new Error(`${path} failed: ${resp.status}`);
	}
	// Some endpoints (DELETE, no-content) return an empty body.
	const text = await resp.text();
	return (text ? JSON.parse(text) : undefined) as T;
}
