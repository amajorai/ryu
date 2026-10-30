import {
	type AppResponseValue,
	appResponseValueSchema,
} from "@ryuhq/core-client/app-request-json";
import type { z } from "zod";
// apps/desktop/src/lib/api/client.ts
//
// Shared HTTP plumbing for the typed Core/Gateway client modules. Every domain
// module (agents, system, engines, chat, ...) builds on these helpers so bearer
// auth and base-URL handling live in exactly one place. The base URL + token
// always come from the node store (`getActiveNode()` -> { url, token, userJwt }), never
// hardcoded — Core listens on :7980 but the active node may be remote.

import {
	isDevMetricsEnabled,
	normalizePath,
	recordHttpSample,
} from "@/src/lib/dev-metrics.ts";
import { getRealtimeJwt } from "@/src/lib/realtime/jwt.ts";
import type { Node } from "@/src/store/useNodeStore.ts";
import { ApiError, appDisabledFromBody } from "./client-api-error.ts";
import { parseApiErrorBody } from "./client-errors.ts";
import { identityHeaders } from "./client-identity.ts";
import { hasConfidentialTransport } from "./client-transport.ts";

export { ApiError, AppDisabledError } from "./client-api-error.ts";
export { currentClientId, identityHeaders } from "./client-identity.ts";
export { type JsonBody, readJsonBody } from "./client-json-body.ts";
export { BUYER_TOKEN_HEADER, buyerTokenHeader } from "./client-transport.ts";

export const USER_JWT_HEADER = "x-ryu-user-jwt";

/** The subset of a node the api layer needs: base URL + scoped credentials. */
export interface ApiTarget {
	token: string | null;
	url: string;
	/** Managed-node delegation, retained under the legacy field name. */
	userJwt?: string | null;
}

/** Never send a general account JWT to a target with no admission credential. */
export function maySendUserIdentity(target: ApiTarget): boolean {
	return Boolean(target.token?.trim() || target.userJwt?.trim());
}

/**
 * Whether the signed-in, account-wide JWT may be attached for `target`. The
 * node must hold an admission credential ({@link maySendUserIdentity}) and be
 * reached over a confidential transport: `https:`, or plain `http:` only to this
 * machine. Over cleartext `http:` to another host, anyone on the path could read
 * the token and replay it. A managed delegation in `target.userJwt` is a
 * separate, node-bound credential that this check does not govern.
 *
 * Residual: this cannot tell an attacker's node from the user's own. A node
 * saved with any token, including one a `ryu://nodes/connect` link supplied,
 * still receives the account JWT over `https:`, and Core still admits that JWT
 * as a bearer on the user's managed nodes. Closing that needs a node-audience
 * bound credential checked by Core.
 */
export function mayAttachAccountJwt(target: ApiTarget): boolean {
	return maySendUserIdentity(target) && hasConfidentialTransport(target.url);
}

/**
 * The signed-in account JWT for a transport that attaches it as an extra header
 * instead of through {@link requestHeaders} (chat streams), or `null` when
 * {@link mayAttachAccountJwt} refuses the target. Realtime joins and WebSocket
 * tickets use {@link realtimeJwtForTarget}.
 */
export async function accountJwtForTarget(
	target: ApiTarget
): Promise<string | null> {
	if (!mayAttachAccountJwt(target)) {
		return null;
	}
	return await getRealtimeJwt();
}

/** The target's own node-bound managed delegation, or `null`. */
export function managedDelegationFor(target: ApiTarget): string | null {
	return target.userJwt?.trim() ? target.userJwt : null;
}

/**
 * The identity JWT a realtime join or WebSocket ticket carries for `target`.
 * Realtime replaces the target's `userJwt` with this value, so where
 * {@link mayAttachAccountJwt} withholds the account JWT the target's own
 * managed delegation is kept instead of being stripped.
 */
export async function realtimeJwtForTarget(
	target: ApiTarget
): Promise<string | null> {
	if (!mayAttachAccountJwt(target)) {
		return managedDelegationFor(target);
	}
	return await getRealtimeJwt();
}

/** Narrow a full node (or any url/token pair) down to an {@link ApiTarget}. */
export function toTarget(
	node: Pick<Node, "url" | "token" | "userJwt">
): ApiTarget {
	return {
		url: node.url,
		token: node.token ?? null,
		userJwt: node.userJwt ?? null,
	};
}

/**
 * Build request headers for a direct-fetch call site. A node bearer wins; a
 * managed target may fall back to its short-lived node delegation and carries it
 * in the explicit identity header as well.
 */
export function makeHeaders(
	token: string | null,
	userJwt: string | null = null
) {
	const headers: RequestInit["headers"] = {
		"Content-Type": "application/json",
	};
	const admissionBearer = token ?? userJwt;
	if (admissionBearer) {
		headers.Authorization = `Bearer ${admissionBearer}`;
	}
	if (userJwt) {
		headers[USER_JWT_HEADER] = userJwt;
	}
	return headers;
}

/** Join a node base URL and an api path without doubling slashes. */
export function apiUrl(target: ApiTarget, path: string): string {
	const base = target.url.replace(/\/$/, "");
	const suffix = path.startsWith("/") ? path : `/${path}`;
	// An empty base silently produced a SAME-ORIGIN relative URL. On the webapp
	// that is app.ryuhq.com, whose nginx SPA fallback answers any unknown path
	// with index.html and a 200 — so the caller parsed HTML as JSON and surfaced
	// "JSON.parse: unexpected character at line 1 column 1" instead of anything
	// pointing at the real problem (no node URL). Fail loudly instead.
	if (!base) {
		throw new Error(
			`No node URL configured — cannot call ${suffix}. Pick a node in the node selector.`
		);
	}
	return `${base}${suffix}`;
}

export interface RequestOptions {
	/** JSON-serializable body; serialized and sent with a JSON content-type. */
	body?: unknown;
	/** Extra headers merged over the defaults (e.g. the marketplace buyer token). */
	headers?: Record<string, string>;
	method?: string;
	signal?: AbortSignal;
	/** Send no bearer or identity headers for public endpoints such as /api/health. */
	skipAuthentication?: boolean;
	/** Skip the control-plane JWT exchange for node-local liveness probes. */
	skipUserJwt?: boolean;
}

/** Header overrides for authenticated raw requests. `null`/`undefined` removes
 * a default header, which is required for FormData and binary bodies whose
 * content type must be supplied by the browser (including its multipart boundary). */
export type RequestHeaderOverrides = Record<string, string | null | undefined>;

/** Fetch options whose body is passed through untouched instead of JSON encoded. */
export type AuthenticatedFetchOptions = Omit<RequestInit, "headers"> & {
	headers?: RequestHeaderOverrides;
	/** Standalone local bootstrap has no control-plane session to exchange. */
	skipUserJwt?: boolean;
	/** Send no bearer or identity headers for public endpoints such as /api/health. */
	skipAuthentication?: boolean;
};

/**
 * The header carrying the signed-in human's VERIFIED identity to Core on every
 * REST call. Unlike {@link identityHeaders} (attribution-only display labels),
 * this is a JWKS-verifiable Better-Auth JWT that Core checks offline (see
 * apps/core/src/identity_verify) to resolve the caller's org role and effective
 * permissions, so a config / workflow / space write can be gated per-user. It
 * rides alongside a node-token `Authorization` header when one exists. For a
 * managed node with no node secret, the same short-lived JWT is also the scoped
 * admission bearer; this header keeps downstream handlers on the same identity.
 */
/** Authentication and attribution are host-owned; raw callers may add transport
 * headers, but cannot replace or remove the identity attached by this module. */
const PROTECTED_REQUEST_HEADERS = new Set([
	"authorization",
	"x-ryu-client-id",
	"x-ryu-client-label",
	"x-ryu-surface",
	"x-ryu-user-id",
	"x-ryu-user-name",
	USER_JWT_HEADER,
]);

/**
 * Build the verified-user JWT header from the current session, minting/refreshing
 * via the cached, single-flight {@link getRealtimeJwt}. Returns `{}` when signed
 * out or the control plane is unreachable, so a local-first single-user node
 * keeps working with just its node token (Core then falls back to full trust).
 * A managed delegation is sent as is; the account JWT only where
 * {@link mayAttachAccountJwt} allows it.
 */
async function verifiedUserHeader(
	target: ApiTarget
): Promise<Record<string, string>> {
	const managedUserJwt = target.userJwt;
	if (managedUserJwt?.trim()) {
		return { [USER_JWT_HEADER]: managedUserJwt };
	}
	if (!mayAttachAccountJwt(target)) {
		return {};
	}
	try {
		const jwt = await getRealtimeJwt();
		if (jwt) {
			return { [USER_JWT_HEADER]: jwt };
		}
	} catch {
		// Signed out / offline — proceed with attribution + node token only.
	}
	return {};
}

/**
 * The complete header set {@link request} sends: node token, client attribution,
 * and the verified-user JWT.
 *
 * Exported for the one caller that cannot go through {@link request} — a
 * progress-reporting upload needs `XMLHttpRequest.upload.onprogress`, which
 * `fetch` has no equivalent for. Composing the headers here rather than
 * re-listing them at that call site is what stops the two paths from drifting on
 * auth the next time a header is added.
 */
export async function requestHeaders(
	target: ApiTarget,
	extra?: RequestHeaderOverrides,
	options: { skipUserJwt?: boolean; skipAuthentication?: boolean } = {}
): Promise<Record<string, string>> {
	const headers: RequestInit["headers"] = {
		...(options.skipAuthentication
			? undefined
			: makeHeaders(target.token, target.userJwt ?? null)),
		...(options.skipAuthentication ? undefined : identityHeaders()),
		...(options.skipAuthentication ||
		options.skipUserJwt ||
		!maySendUserIdentity(target)
			? undefined
			: await verifiedUserHeader(target)),
	};
	for (const [name, value] of Object.entries(extra ?? {})) {
		if (PROTECTED_REQUEST_HEADERS.has(name.toLowerCase())) {
			continue;
		}
		const existingName = Object.keys(headers).find(
			(candidate) => candidate.toLowerCase() === name.toLowerCase()
		);
		if (existingName) {
			delete headers[existingName];
		}
		if (value !== null && value !== undefined) {
			headers[name] = value;
		}
	}
	return headers;
}

/**
 * Perform a raw-body request against Core with the complete authenticated header
 * set. Unlike {@link request}, this never serializes or parses the body: streams,
 * blobs, FormData, and callers with custom response handling keep their semantics.
 * Browser HTTP caching is disabled unless the raw caller explicitly opts into it.
 */
export async function authenticatedFetch(
	target: ApiTarget,
	path: string,
	options: AuthenticatedFetchOptions = {}
): Promise<Response> {
	const {
		headers: extraHeaders,
		skipUserJwt,
		skipAuthentication,
		...init
	} = options;
	return await fetch(apiUrl(target, path), {
		...init,
		cache: options.cache ?? "no-store",
		headers: await requestHeaders(target, extraHeaders, {
			skipUserJwt,
			skipAuthentication,
		}),
	});
}

/**
 * Perform a JSON request against a node and parse the response.
 *
 * Throws an {@link ApiError} with the status code on a non-2xx response so callers
 * can degrade gracefully (the status spine relies on this to flag Core as down).
 * A `503 app_disabled` body throws the typed {@link AppDisabledError} instead so
 * a gated feature (Meetings, Spaces, …) can render an actionable "Enable" prompt.
 */
export async function request<T>(
	target: ApiTarget,
	path: string,
	...[options = {}, responseCodec]: [RequestOptions | undefined, z.ZodType<T>]
): Promise<T> {
	// Developer-mode timing. The gate is checked before anything is allocated, so
	// a release build without Developer Mode pays one boolean read per call and
	// keeps `started`/`at` unset. This is the ONE choke point every Core API call
	// goes through, which is why the probe lives here and nowhere else.
	const metering = isDevMetricsEnabled();
	const started = metering ? performance.now() : 0;
	const at = metering ? Date.now() : 0;
	const method = options.method ?? "GET";
	const meter = (status: number): void => {
		if (metering) {
			recordHttpSample({
				at,
				method,
				path: normalizePath(path),
				status,
				ms: performance.now() - started,
			});
		}
	};

	let resp: Response;
	try {
		resp = await fetch(apiUrl(target, path), {
			// Mutable node APIs must reach the captured authority without sharing
			// a browser cache transaction with an in-flight request for another identity.
			cache: "no-store",
			method,
			headers: await requestHeaders(target, options.headers, {
				skipUserJwt: options.skipUserJwt,
				skipAuthentication: options.skipAuthentication,
			}),
			body:
				options.body === undefined ? undefined : JSON.stringify(options.body),
			signal: options.signal,
		});
	} catch (error) {
		// Status 0 = never reached the node (offline, DNS, abort). Recording it is
		// the point: "the call took 30s and returned nothing" is the shape of the
		// problem people report as "it hung".
		meter(0);
		throw error;
	}
	meter(resp.status);
	if (!resp.ok) {
		const text = await resp.text().catch(() => "");
		const disabled = appDisabledFromBody(resp.status, text);
		if (disabled) {
			throw disabled;
		}
		const serverError = parseApiErrorBody(text);
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			body = undefined;
		}
		throw new ApiError(
			path,
			resp.status,
			serverError.message,
			serverError.code,
			body
		);
	}
	// Some endpoints (DELETE, no-content) return an empty body.
	const text = await resp.text();
	if (!text) {
		return responseCodec.parse(undefined);
	}
	let decoded: AppResponseValue;
	try {
		decoded = appResponseValueSchema.parse(JSON.parse(text));
	} catch {
		// A 200 that isn't JSON means we reached something that is not this node's
		// API — typically an SPA/proxy fallback serving index.html. Report that
		// rather than leaking a bare JSON.parse SyntaxError to the caller.
		const contentType = resp.headers.get("content-type") ?? "unknown";
		throw new Error(
			`${path} returned ${contentType}, not JSON — the node URL may be wrong or unreachable.`
		);
	}
	return responseCodec.parse(decoded);
}
