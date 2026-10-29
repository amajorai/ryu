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

import { z } from "zod";
import { appResponseValueSchema } from "./app-request-json.ts";

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

/** String-valued node authentication and caller identity headers. */
export interface CoreRequestHeaders {
	"Content-Type": string;
	[header: string]: string;
}

/**
 * Build request headers. A node bearer wins; an org-bound managed node may use
 * its short-lived user JWT as the admission bearer when no node bearer exists.
 * The same JWT is also sent in its explicit identity header for downstream RBAC.
 */
export function makeHeaders(
	token: string | null,
	userJwt?: string | null
): CoreRequestHeaders {
	const headers: CoreRequestHeaders = {
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
	signal?: AbortSignal | undefined;
}

/** Binding requested when exchanging HTTP authentication for a WS ticket. */
export interface WebSocketTicketRequest {
	appId?: string;
	kind?: "conversation" | "document" | "application";
	path?: string;
	roomId?: string;
	route: "realtime" | "voice" | "ext" | "session-box";
}

const webSocketTicketSchema = z.object({
	ticket: z.string().refine((ticket) => ticket.trim().length > 0),
});
/** Core answers `{ error: "text" }`, the structured
 * `{ error: { code, message } }` contract, or (passing a control-plane
 * refusal through) `{ code, error: "text" }`. */
const serverErrorSchema = z.object({
	code: z.string().optional().catch(undefined),
	error: z
		.union([
			z.string(),
			z.object({
				code: z.string().optional().catch(undefined),
				message: z.string().optional().catch(undefined),
			}),
		])
		.optional(),
});

/** Exchange normal HTTP credentials for a short-lived, one-use WS ticket. */
export async function requestWebSocketTicket(
	target: ApiTarget,
	binding: WebSocketTicketRequest
): Promise<string> {
	const response = await request(
		target,
		"/api/ws/ticket",
		{
			method: "POST",
			body: binding,
		},
		appResponseValueSchema
	);
	const parsed = webSocketTicketSchema.safeParse(response);
	if (!parsed.success) {
		throw new Error("Core returned an invalid WebSocket ticket");
	}
	return parsed.data.ticket;
}

/** Add an opaque ticket to a WS URL without ever adding bearer credentials. */
export function appendWebSocketTicket(url: string, ticket: string): string {
	if (ticket.trim() === "") {
		throw new Error("WebSocket ticket cannot be empty");
	}
	const parsed = new URL(url);
	parsed.searchParams.set("ticket", ticket);
	return parsed.toString();
}

/** A structured non-2xx response from Core. The message intentionally keeps the
 * historical status-only shape while typed callers inspect the status/body. */
export class ApiError extends Error {
	readonly status: number;
	readonly serverMessage?: string | undefined;
	/** The machine code of a structured `{ error: { code, message } }` reply. */
	readonly code?: string | undefined;

	constructor(
		path: string,
		status: number,
		serverMessage?: string,
		code?: string
	) {
		super(`${path} failed: ${status}`);
		this.name = "ApiError";
		this.status = status;
		this.serverMessage = serverMessage;
		this.code = code;
	}
}

/** Read Core's error text (and code, when structured) from a failed reply. */
function serverErrorFromBody(text: string): {
	code?: string | undefined;
	message?: string | undefined;
} {
	if (!text) {
		return {};
	}
	try {
		const parsed = serverErrorSchema.safeParse(JSON.parse(text));
		if (!parsed.success) {
			return {};
		}
		const { code, error } = parsed.data;
		if (typeof error === "string" || error === undefined) {
			return { code, message: error };
		}
		return { code: error.code ?? code, message: error.message };
	} catch {
		return {};
	}
}

/** The {@link ApiError} for a non-2xx reply whose body text is `text`. */
export function apiErrorFromBody(
	path: string,
	status: number,
	text: string
): ApiError {
	const { code, message } = serverErrorFromBody(text);
	return new ApiError(path, status, message, code);
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
	...[options = {}, responseCodec]: [RequestOptions | undefined, z.ZodType<T>]
): Promise<T> {
	const fetchImpl = fetchForTarget(target);
	const resp = await fetchImpl(apiUrl(target, path), {
		method: options.method ?? "GET",
		headers: {
			...makeHeaders(target.token, target.userJwt),
			...options.headers,
		},
		...(options.body === undefined
			? {}
			: { body: JSON.stringify(options.body) }),
		...(options.signal === undefined ? {} : { signal: options.signal }),
	});
	const text = await resp.text();
	if (!resp.ok) {
		throw apiErrorFromBody(path, resp.status, text);
	}
	// Some endpoints (DELETE, no-content) return an empty body.
	const decoded = text ? JSON.parse(text) : undefined;
	return responseCodec.parse(decoded);
}
