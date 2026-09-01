// packages/core-client/src/client.ts
//
// Platform-agnostic HTTP plumbing for the typed Core/Gateway client modules.
// Every domain module (agents, system, engines, chat, ...) builds on these
// helpers so bearer auth and base-URL handling live in exactly one place. The
// base URL + credentials always come from the caller's active node
// ({ url, token, userJwt }),
// never hardcoded — Core listens on :7980 but the active node may be remote.
//
// This module intentionally has NO platform dependencies (no localStorage, no
// Tauri, no React) so it is shared verbatim by the desktop (Tauri webview) and
// the mobile app (React Native / Expo). Surface-specific concerns (the desktop
// buyer-token / presence headers, the mobile secure-store token) are layered on
// top by each app, not here.

/** The subset of a node the api layer needs: base URL + scoped credentials. */
export type RyuFetch = (
	input: RequestInfo | URL,
	init?: RequestInit
) => Promise<Response>;

export interface ApiTarget {
	/**
	 * HTTP implementation for this target. Expo apps can pass `expo/fetch` when
	 * they need streaming response bodies; global fetch is used by default.
	 */
	fetch?: RyuFetch;
	token: string | null;
	url: string;
	/** Verified end-user JWT for per-user/team tenancy on an org-bound Core. */
	userJwt?: string | null;
}

/** Resolve the HTTP implementation for a target without adding a platform dependency. */
export function fetchForTarget(target: Pick<ApiTarget, "fetch">): RyuFetch {
	return target.fetch ?? globalThis.fetch;
}

export const USER_JWT_HEADER = "x-ryu-user-jwt";

let userJwtProvider: () => string | null = () => null;

/** Wire a rotating end-user JWT source independently from the node bearer. */
export function setUserJwtProvider(fn: () => string | null): void {
	userJwtProvider = fn;
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

/**
 * Build request headers. A node bearer wins; an org-bound managed node may use
 * its short-lived user JWT as the admission bearer when no node bearer exists.
 * The same JWT is also sent in its explicit identity header for downstream RBAC.
 */
export function makeHeaders(
	token: string | null,
	userJwt?: string | null
): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	const identityJwt = userJwt ?? userJwtProvider();
	const admissionBearer = token ?? (userJwt?.trim() ? userJwt : null);
	if (admissionBearer) {
		headers.Authorization = `Bearer ${admissionBearer}`;
	}
	if (identityJwt) {
		headers[USER_JWT_HEADER] = identityJwt;
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

/** A structured non-2xx response from Core. The message intentionally keeps the
 * historical status-only shape while typed callers inspect the status/body. */
export class ApiError extends Error {
	readonly status: number;
	readonly serverMessage?: string;

	constructor(path: string, status: number, serverMessage?: string) {
		super(`${path} failed: ${status}`);
		this.name = "ApiError";
		this.status = status;
		this.serverMessage = serverMessage;
	}
}

function serverErrorFromBody(text: string): string | undefined {
	if (!text) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(text) as { error?: unknown };
		return typeof parsed.error === "string" ? parsed.error : undefined;
	} catch {
		return undefined;
	}
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

/** Only a Core running on this machine may receive the control-plane session. */
function isLoopbackTarget(url: string): boolean {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return false;
		}
		if (parsed.username || parsed.password) {
			return false;
		}
		const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
		if (hostname === "localhost" || hostname === "::1") {
			return true;
		}
		const octets = hostname.split(".");
		return (
			octets.length === 4 &&
			octets.every(
				(octet) => /^(?:0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255
			) &&
			octets[0] === "127"
		);
	} catch {
		return false;
	}
}

/**
 * Build the buyer-token header from the injected control-plane session token,
 * but only for a loopback Core target. A remote or malformed target gets no
 * session credential; the node token remains the only credential sent there.
 */
export function buyerTokenHeader(
	target: Pick<ApiTarget, "url">
): Record<string, string> {
	if (!isLoopbackTarget(target.url)) {
		return {};
	}
	const token = buyerTokenProvider();
	return token ? { [BUYER_TOKEN_HEADER]: token } : {};
}

/**
 * Perform a JSON request against a node and parse the response.
 *
 * Throws an {@link ApiError} with the status code and Core's structured error
 * message, when present, while preserving the historical message string.
 */
export async function request<T>(
	target: ApiTarget,
	path: string,
	options: RequestOptions = {}
): Promise<T> {
	const fetchImpl = fetchForTarget(target);
	const resp = await fetchImpl(apiUrl(target, path), {
		method: options.method ?? "GET",
		headers: {
			...makeHeaders(target.token, target.userJwt),
			...options.headers,
		},
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
		signal: options.signal,
	});
	const text = await resp.text();
	if (!resp.ok) {
		throw new ApiError(path, resp.status, serverErrorFromBody(text));
	}
	// Some endpoints (DELETE, no-content) return an empty body.
	return (text ? JSON.parse(text) : undefined) as T;
}
