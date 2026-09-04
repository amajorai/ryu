// apps/desktop/src/lib/api/client.ts
//
// Shared HTTP plumbing for the typed Core/Gateway client modules. Every domain
// module (agents, system, engines, chat, ...) builds on these helpers so bearer
// auth and base-URL handling live in exactly one place. The base URL + token
// always come from the node store (`getActiveNode()` -> { url, token, userJwt }), never
// hardcoded — Core listens on :7980 but the active node may be remote.

import { TOKEN_KEY } from "@/lib/auth-client.ts";
import {
	isDevMetricsEnabled,
	normalizePath,
	recordHttpSample,
} from "@/src/lib/dev-metrics.ts";
import { getRealtimeJwt } from "@/src/lib/realtime/jwt.ts";
import type { Node } from "@/src/store/useNodeStore.ts";

export const USER_JWT_HEADER = "x-ryu-user-jwt";

/** The subset of a node the api layer needs: base URL + scoped credentials. */
export interface ApiTarget {
	token: string | null;
	url: string;
	/** Managed-node user JWT; not a node secret and never persisted as one. */
	userJwt?: string | null;
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
 * managed target may fall back to its short-lived user JWT and carries that JWT
 * in the explicit identity header as well.
 */
export function makeHeaders(
	token: string | null,
	userJwt: string | null = null
): Record<string, string> {
	const headers: Record<string, string> = {
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
};

/**
 * The dedicated header carrying the user's CONTROL-PLANE (Better-Auth) session
 * bearer to Core on a Marketplace install for optional account-aware operations.
 * Kept distinct from `Authorization`
 * (which holds the Core node token, a machine secret the control plane does not
 * recognize as a user). Core forwards this to the Marketplace install handoff when present.
 */
export const BUYER_TOKEN_HEADER = "X-Ryu-Buyer-Token";

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
 * Build the buyer-token header from the signed-in control-plane session token,
 * but only for a loopback Core target. A remote or malformed target gets no
 * session credential; the node token remains the only credential sent there.
 */
export function buyerTokenHeader(
	target: Pick<ApiTarget, "url">
): Record<string, string> {
	if (!isLoopbackTarget(target.url)) {
		return {};
	}
	try {
		const token = localStorage.getItem(TOKEN_KEY);
		if (token) {
			return { [BUYER_TOKEN_HEADER]: token };
		}
	} catch {
		// No storage — install proceeds anonymously.
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
 */
async function verifiedUserHeader(
	managedUserJwt?: string | null
): Promise<Record<string, string>> {
	if (managedUserJwt?.trim()) {
		return { [USER_JWT_HEADER]: managedUserJwt };
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
 * Thrown when Core refuses a first-party route because the App that owns it is
 * disabled (or not installed). Core answers `503 {"error":"app_disabled","app":
 * "<id>","message":"Enable the X app"}` (see `apps/core/src/server/mod.rs`
 * `app_disabled_response`); this is the typed, catchable client view. Surfaces
 * catch it to offer a one-click "Enable" instead of showing a dead error string.
 */
export class AppDisabledError extends Error {
	/** The owning App's manifest id the caller must enable (e.g. `@ryu/meetings`). */
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
 * A non-2xx response from a node. Carries the HTTP `status` and, when Core sent
 * one, the `{ "error": "…" }` body as {@link serverMessage}, so a caller can tell
 * "this Core is too old to have the route" (404) apart from "Core refused"
 * (403) instead of guessing from a bare message string.
 *
 * `message` keeps the historical `"<path> failed: <status>"` shape — callers that
 * only log or match on the text are unaffected.
 */
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

/** Pull Core's `{ "error": "…" }` message out of an error body, if it has one. */
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

/** A response body read once and decoded leniently by {@link readJsonBody}. */
export interface JsonBody<T> {
	/** The parsed JSON body, or `null` when the body was empty or not JSON. */
	data: T | null;
	/**
	 * A human-readable failure message, or `null` when the response was a 2xx
	 * carrying a JSON (or empty) body. Set for every non-2xx, and for a 2xx whose
	 * body is not JSON at all — a caller can treat a non-null `error` as "failed"
	 * without ever calling `JSON.parse` itself.
	 */
	error: string | null;
	status: number;
}

/** Collapse a raw error body to one short line so a stray HTML page or stack
 *  trace cannot fill a panel. */
function snippet(text: string): string {
	return text.trim().replace(/\s+/g, " ").slice(0, 200);
}

/**
 * Read a response body ONCE and decode it as JSON without ever throwing a
 * `SyntaxError` at the caller.
 *
 * This exists because the hand-rolled `fetch` clients used to call `resp.json()`
 * before checking `resp.ok`: any non-JSON error body (an axum extractor
 * rejection is `text/plain`, a proxy error page is HTML) surfaced in the UI as
 * `Unexpected token 'E', "Expected r"... is not valid JSON` instead of the real
 * reason. Status is inspected first here, the body is read as text, and JSON is
 * only attempted — never required.
 *
 * `label` names the operation for the fallback message (`"<label> failed: 415"`).
 * When the failing body is not JSON its first line is appended, so the server's
 * actual complaint still reaches the user.
 */
export async function readJsonBody<T>(
	resp: Response,
	label: string
): Promise<JsonBody<T>> {
	const text = await resp.text().catch(() => "");
	let data: T | null = null;
	if (text) {
		try {
			data = JSON.parse(text) as T;
		} catch {
			// Not JSON — `data` stays null and the raw text becomes the message.
			data = null;
		}
	}

	if (resp.ok) {
		if (text && data === null) {
			// A 2xx that is not JSON means we reached something that is not this
			// node's API (SPA/proxy fallback serving index.html), same failure mode
			// `request()` reports below.
			const contentType = resp.headers.get("content-type") ?? "unknown";
			return {
				data: null,
				status: resp.status,
				error: `${label} returned ${contentType}, not JSON — the node URL may be wrong or unreachable.`,
			};
		}
		return { data, status: resp.status, error: null };
	}

	const serverError =
		data && typeof data === "object"
			? (data as { error?: unknown }).error
			: undefined;
	if (typeof serverError === "string" && serverError) {
		return { data, status: resp.status, error: serverError };
	}
	const base = `${label} failed: ${resp.status}`;
	const detail = snippet(text);
	return {
		data,
		status: resp.status,
		error: detail ? `${base} — ${detail}` : base,
	};
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
	options: { skipUserJwt?: boolean } = {}
): Promise<Record<string, string>> {
	const headers: Record<string, string> = {
		// Local and self-hosted nodes use their node bearer. Managed nodes fall back
		// to the short-lived user JWT returned by the control plane.
		...makeHeaders(target.token, target.userJwt ?? null),
		...identityHeaders(),
		...(options.skipUserJwt ? {} : await verifiedUserHeader(target.userJwt)),
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
 */
export async function authenticatedFetch(
	target: ApiTarget,
	path: string,
	options: AuthenticatedFetchOptions = {}
): Promise<Response> {
	const { headers: extraHeaders, skipUserJwt, ...init } = options;
	return await fetch(apiUrl(target, path), {
		...init,
		headers: await requestHeaders(target, extraHeaders, { skipUserJwt }),
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
	options: RequestOptions = {}
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
			method,
			headers: await requestHeaders(target, options.headers, {
				skipUserJwt: options.skipUserJwt,
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
		throw new ApiError(path, resp.status, serverErrorFromBody(text));
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
