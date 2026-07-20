// apps/desktop/src/lib/api/client.ts
//
// Shared HTTP plumbing for the typed Core/Gateway client modules. Every domain
// module (agents, system, engines, chat, ...) builds on these helpers so bearer
// auth and base-URL handling live in exactly one place. The base URL + token
// always come from the node store (`getActiveNode()` -> { url, token }), never
// hardcoded — Core listens on :7980 but the active node may be remote.

import { TOKEN_KEY } from "@/lib/auth-client.ts";
import { getRealtimeJwt } from "@/src/lib/realtime/jwt.ts";
import type { Node } from "@/src/store/useNodeStore.ts";

/** The subset of a node the api layer needs: base URL + optional bearer token. */
export interface ApiTarget {
	token: string | null;
	url: string;
}

/** Narrow a full node (or any url/token pair) down to an {@link ApiTarget}. */
export function toTarget(node: Pick<Node, "url" | "token">): ApiTarget {
	return { url: node.url, token: node.token ?? null };
}

/** Build request headers, attaching the bearer token when present. */
export function makeHeaders(token: string | null): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (token) {
		headers.Authorization = `Bearer ${token}`;
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
}

/**
 * The dedicated header carrying the user's CONTROL-PLANE (Better-Auth) session
 * bearer to Core on a marketplace install, so a PAID item's entitlement check
 * (#491) can resolve the buyer org + license. Kept distinct from `Authorization`
 * (which holds the Core node token, a machine secret the control plane does not
 * recognize as a user). Core forwards this to the marketplace install handoff.
 */
export const BUYER_TOKEN_HEADER = "X-Ryu-Buyer-Token";

/**
 * Build the buyer-token header from the signed-in control-plane session token,
 * or `{}` when not signed in (an anonymous install — fine for free items; a paid
 * item is denied with an actionable error). Reads the same `TOKEN_KEY` the
 * credits/seller clients use.
 */
export function buyerTokenHeader(): Record<string, string> {
	try {
		const token = localStorage.getItem(TOKEN_KEY);
		if (token) {
			return { [BUYER_TOKEN_HEADER]: token };
		}
	} catch {
		// No storage — install proceeds anonymously (free items only).
	}
	return {};
}

/** localStorage key for this install's stable, randomly-generated client id. */
const CLIENT_ID_KEY = "ryu_client_id";
/** localStorage key the app store persists the signed-in OIDC user under. */
const OIDC_USER_KEY = "ryu_oidc_user";

/** Stable per-install id, generated once and persisted. Used to dedup presence. */
function clientId(): string {
	try {
		let id = localStorage.getItem(CLIENT_ID_KEY);
		if (!id) {
			id =
				typeof crypto?.randomUUID === "function"
					? crypto.randomUUID()
					: `desktop-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
			localStorage.setItem(CLIENT_ID_KEY, id);
		}
		return id;
	} catch {
		return "desktop-unknown";
	}
}

/** This install's stable client id (the value sent as `X-Ryu-Client-Id`). */
export function currentClientId(): string {
	return clientId();
}

/**
 * Self-declared presence identity headers, sent on every Core request so the
 * node's connections registry can show "who is connected" (see
 * apps/core/src/connections). This is ATTRIBUTION, not authentication: the node
 * token in `Authorization` is the real trust boundary; these are display labels
 * a node operator can see. User fields are URL-encoded so a non-ASCII display
 * name is still a valid HTTP header value (Core percent-decodes them).
 */
export function identityHeaders(): Record<string, string> {
	const headers: Record<string, string> = {
		"X-Ryu-Client-Id": clientId(),
		"X-Ryu-Client-Label": "Desktop",
		"X-Ryu-Surface": "desktop",
	};
	try {
		const raw = localStorage.getItem(OIDC_USER_KEY);
		if (raw) {
			const user = JSON.parse(raw) as { name?: string; email?: string };
			if (user.email) {
				headers["X-Ryu-User-Id"] = encodeURIComponent(user.email);
			}
			if (user.name) {
				headers["X-Ryu-User-Name"] = encodeURIComponent(user.name);
			}
		}
	} catch {
		// Not signed in / no storage — presence still works, just shows as anonymous.
	}
	return headers;
}

/**
 * The header carrying the signed-in human's VERIFIED identity to Core on every
 * REST call. Unlike {@link identityHeaders} (attribution-only display labels),
 * this is a JWKS-verifiable Better-Auth JWT that Core checks offline (see
 * apps/core/src/identity_verify) to resolve the caller's org role and effective
 * permissions, so a config / workflow / space write can be gated per-user. It
 * rides ALONGSIDE the node-token `Authorization` header, never replacing it: the
 * node token is the machine trust boundary, this names the human behind it.
 */
export const USER_JWT_HEADER = "x-ryu-user-jwt";

/**
 * Build the verified-user JWT header from the current session, minting/refreshing
 * via the cached, single-flight {@link getRealtimeJwt}. Returns `{}` when signed
 * out or the control plane is unreachable, so a local-first single-user node
 * keeps working with just its node token (Core then falls back to full trust).
 */
async function verifiedUserHeader(): Promise<Record<string, string>> {
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
 * Thrown when Core refuses a first-party route because the App that owns it is
 * disabled (or not installed). Core answers `503 {"error":"app_disabled","app":
 * "<id>","message":"Enable the X app"}` (see `apps/core/src/server/mod.rs`
 * `app_disabled_response`); this is the typed, catchable client view. Surfaces
 * catch it to offer a one-click "Enable" instead of showing a dead error string.
 */
export class AppDisabledError extends Error {
	/** The owning App's manifest id the caller must enable (e.g. `com.ryu.meetings`). */
	readonly app: string;
	constructor(app: string, message: string) {
		super(message);
		this.name = "AppDisabledError";
		this.app = app;
	}
}

/** Detect the `503 {error:"app_disabled", app, message}` contract in a response
 *  body and produce a typed {@link AppDisabledError}, or `null` when the body is
 *  not that shape. Kept in one place so every gated endpoint decodes it the same. */
function appDisabledFromBody(
	status: number,
	text: string
): AppDisabledError | null {
	if (status !== 503 || !text) {
		return null;
	}
	try {
		const body = JSON.parse(text) as {
			error?: string;
			app?: string;
			message?: string;
		};
		if (body.error === "app_disabled" && typeof body.app === "string") {
			return new AppDisabledError(
				body.app,
				body.message ?? "This app is disabled."
			);
		}
	} catch {
		// Non-JSON 503 — not the app_disabled contract.
	}
	return null;
}

/**
 * Perform a JSON request against a node and parse the response.
 *
 * Throws an {@link Error} with the status code on a non-2xx response so callers
 * can degrade gracefully (the status spine relies on this to flag Core as down).
 * A `503 app_disabled` body throws the typed {@link AppDisabledError} instead so
 * a gated feature (Meetings, Spaces, …) can render an actionable "Enable" prompt.
 */
export async function request<T>(
	target: ApiTarget,
	path: string,
	options: RequestOptions = {}
): Promise<T> {
	const userHeader = await verifiedUserHeader();
	const resp = await fetch(apiUrl(target, path), {
		method: options.method ?? "GET",
		headers: {
			...makeHeaders(target.token),
			...identityHeaders(),
			...userHeader,
			...options.headers,
		},
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
		signal: options.signal,
	});
	if (!resp.ok) {
		const text = await resp.text().catch(() => "");
		const disabled = appDisabledFromBody(resp.status, text);
		if (disabled) {
			throw disabled;
		}
		throw new Error(`${path} failed: ${resp.status}`);
	}
	// Some endpoints (DELETE, no-content) return an empty body.
	const text = await resp.text();
	if (!text) {
		return undefined as T;
	}
	try {
		return JSON.parse(text) as T;
	} catch {
		// A 200 that isn't JSON means we reached something that is not this node's
		// API — typically an SPA/proxy fallback serving index.html. Report that
		// rather than leaking a bare JSON.parse SyntaxError to the caller.
		const contentType = resp.headers.get("content-type") ?? "unknown";
		throw new Error(
			`${path} returned ${contentType}, not JSON — the node URL may be wrong or unreachable.`
		);
	}
}
