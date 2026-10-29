import { z } from "zod";
import {
	LOGIN_APPROVAL_POLL_INTERVAL_SECONDS,
	type LoginApprovalEvent,
	type LoginApprovalRequest,
	type LoginApprovalStart,
} from "./login-approval-contract.ts";

export type {
	LoginApprovalEvent,
	LoginApprovalQrPayload,
	LoginApprovalRequest,
	LoginApprovalStart,
	LoginApprovalSurface,
} from "./login-approval-contract.ts";

export interface StartLoginApprovalOptions {
	deviceLabel?: string;
	email: string;
	signal?: AbortSignal;
}

export interface LoginApprovalAuth {
	token?: string | null;
}

export interface PollLoginApprovalOptions {
	onPending?: () => void;
	signal?: AbortSignal;
}

const errorSchema = z.object({
	error: z.string().catch(""),
	message: z.string().catch(""),
});
const requestSchema = z.object({
	clientId: z.string(),
	createdAt: z.string(),
	deviceLabel: z.string(),
	expiresAt: z.string(),
	id: z.string(),
	ipAddress: z.string().nullable().catch(null),
	status: z.enum(["pending", "approving", "approved", "denied"]),
	surface: z.enum(["desktop", "extension", "mobile", "web"]),
	userAgent: z.string().nullable().catch(null),
	userCode: z.string(),
});
const nullableStringSchema = z.string().min(1).nullable().catch(null);
const startSchema = z.object({
	deviceCode: nullableStringSchema,
	expiresIn: z
		.number()
		.transform((value) => Math.max(1, Math.floor(value)))
		.catch(300),
	interval: z
		.number()
		.transform((value) => Math.max(1, Math.floor(value)))
		.catch(LOGIN_APPROVAL_POLL_INTERVAL_SECONDS),
	requestId: z.string(),
	userCode: nullableStringSchema,
	verificationUri: nullableStringSchema,
	verificationUriComplete: nullableStringSchema,
});
const grantSchema = z
	.object({
		ok: z.boolean().catch(false),
		access_token: z.string().optional().catch(undefined),
		error: z.string().nullable().catch(null),
	})
	.catch(() => ({ ok: false, error: null }));
const pendingRequestsSchema = z
	.object({
		requests: z.array(requestSchema.nullable().catch(null)).catch(() => []),
	})
	.catch(() => ({ requests: [] }));
const eventSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("created"), request: requestSchema }),
	z.object({ type: z.literal("approved"), requestId: z.string() }),
	z.object({ type: z.literal("denied"), requestId: z.string() }),
]);
const parseStart = startSchema.nullable().catch(null).parse;

function baseUrl(value: string): string {
	return value.replace(/\/+$/, "");
}

function apiUrl(value: string, path: string): string {
	return `${baseUrl(value)}/api/login-approvals${path}`;
}

async function errorMessage(response: Response): Promise<string> {
	try {
		const parsed = errorSchema.parse(await response.json());
		if (parsed.message.trim()) {
			return parsed.message;
		}
		if (parsed.error.trim()) {
			return parsed.error;
		}
	} catch {
		// The response may be a proxy-generated plain-text error.
	}
	return `Login approval request failed (${response.status})`;
}

/** A non-2xx response from the login-approval API, carrying its HTTP status. */
export class LoginApprovalHttpError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = "LoginApprovalHttpError";
		this.status = status;
	}
}

const INITIAL_RECONNECT_BACKOFF_MS = 1000;
const MAX_RECONNECT_BACKOFF_MS = 30_000;
/** A session the API refuses will not recover by retrying sooner than this. */
const REFUSED_SESSION_RETRY_MS = 300_000;
/**
 * A listener connection (snapshot plus stream) that stayed up at least this long
 * was healthy, so its next reconnect starts the backoff over. One that failed or
 * closed sooner keeps growing it, including a stream that ends right after a
 * successful snapshot.
 */
export const LOGIN_APPROVAL_STABLE_CONNECTION_MS = 30_000;

/**
 * Delay before an approval listener reconnects after its `attempt`-th
 * consecutive failure or stream end. A refused session (401/403) waits five
 * minutes, since signing back in re-runs the listener anyway. Anything else
 * backs off exponentially from one second to 30 seconds with equal jitter: the
 * first reconnect stays fast, while clients that dropped together (an API
 * deploy or outage) come back spread out instead of as one synchronized wave.
 */
export function loginApprovalRetryDelay(
	attempt: number,
	error: unknown,
	random: () => number = Math.random
): number {
	if (
		error instanceof LoginApprovalHttpError &&
		(error.status === 401 || error.status === 403)
	) {
		return REFUSED_SESSION_RETRY_MS;
	}
	const base = Math.min(
		MAX_RECONNECT_BACKOFF_MS,
		INITIAL_RECONNECT_BACKOFF_MS * 2 ** Math.max(0, attempt)
	);
	return base / 2 + (random() * base) / 2;
}

function authHeaders(token?: string | null): Record<string, string> {
	return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Start a passwordless login request from any Ryu client surface. */
export async function startLoginApproval(
	base: string,
	clientId: string,
	options: StartLoginApprovalOptions
): Promise<LoginApprovalStart> {
	const response = await fetch(apiUrl(base, "/request"), {
		body: JSON.stringify({
			clientId,
			deviceLabel: options.deviceLabel,
			email: options.email,
		}),
		headers: { "Content-Type": "application/json" },
		method: "POST",
		signal: options.signal,
	});
	if (!(response.ok || response.status === 202)) {
		throw new Error(await errorMessage(response));
	}
	const parsed = parseStart(await response.json());
	if (!parsed) {
		throw new Error("Passwordless sign-in returned an invalid request");
	}
	return parsed;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) {
		return Promise.reject(new DOMException("Aborted", "AbortError"));
	}
	return new Promise((resolve, reject) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout>;
		const finish = () => {
			if (settled) {
				return;
			}
			settled = true;
			signal?.removeEventListener("abort", abort);
			resolve();
		};
		const abort = () => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			reject(new DOMException("Aborted", "AbortError"));
		};
		signal?.addEventListener("abort", abort, { once: true });
		timer = setTimeout(finish, ms);
	});
}

async function pollLoginApprovalGrant(
	base: string,
	clientId: string,
	start: LoginApprovalStart,
	options: PollLoginApprovalOptions = {}
): Promise<void> {
	if (!start.deviceCode) {
		throw new Error("No matching Ryu account was found");
	}
	let interval = Math.max(start.interval, 1);
	const deadline = Date.now() + start.expiresIn * 1000;
	while (Date.now() < deadline) {
		await wait(interval * 1000, options.signal);
		const response = await fetch(`${baseUrl(base)}/api/auth/device/session`, {
			body: JSON.stringify({
				client_id: clientId,
				device_code: start.deviceCode,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			}),
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			method: "POST",
			signal: options.signal,
		});
		const data = grantSchema.parse(await response.json());
		if (data?.ok === true || data?.access_token) {
			return;
		}
		const error = data.error;
		if (error === "authorization_pending") {
			options.onPending?.();
			continue;
		}
		if (error === "slow_down") {
			interval += 5;
			continue;
		}
		if (error === "access_denied") {
			throw new Error("Access denied. You declined the sign-in request.");
		}
		if (error === "expired_token") {
			throw new Error("The sign-in request expired. Please try again.");
		}
		if (error) {
			throw new Error(`Sign-in failed: ${error}`);
		}
		if (!response.ok) {
			throw new Error(await errorMessage(response));
		}
	}
	throw new Error("The sign-in request timed out. Please try again.");
}

/** Poll the browser-only endpoint that sets Better Auth's HttpOnly cookie. */
export async function pollLoginApprovalSession(
	base: string,
	clientId: string,
	start: LoginApprovalStart,
	options: PollLoginApprovalOptions = {}
): Promise<void> {
	await pollLoginApprovalGrant(base, clientId, start, options);
}

/** Read all pending approval prompts for the authenticated account. */
export async function listLoginApprovals(
	base: string,
	auth: LoginApprovalAuth = {},
	signal?: AbortSignal
): Promise<LoginApprovalRequest[]> {
	const response = await fetch(apiUrl(base, "/pending"), {
		credentials: "include",
		headers: authHeaders(auth.token),
		method: "GET",
		signal,
	});
	if (!response.ok) {
		throw new LoginApprovalHttpError(
			await errorMessage(response),
			response.status
		);
	}
	const body = pendingRequestsSchema.parse(await response.json());
	return body.requests.filter((request) => request !== null);
}

async function resolveLoginApproval(
	base: string,
	requestId: string,
	auth: LoginApprovalAuth,
	action: "approve" | "deny"
): Promise<void> {
	const response = await fetch(
		apiUrl(base, `/pending/${encodeURIComponent(requestId)}/${action}`),
		{
			body: "{}",
			credentials: "include",
			headers: {
				...authHeaders(auth.token),
				"Content-Type": "application/json",
			},
			method: "POST",
		}
	);
	if (!response.ok) {
		throw new Error(await errorMessage(response));
	}
}

/** Approve a pending login from the caller's existing authenticated session. */
export function approveLoginApproval(
	base: string,
	requestId: string,
	auth: LoginApprovalAuth = {}
): Promise<void> {
	return resolveLoginApproval(base, requestId, auth, "approve");
}

/** Deny a pending login from the caller's existing authenticated session. */
export function denyLoginApproval(
	base: string,
	requestId: string,
	auth: LoginApprovalAuth = {}
): Promise<void> {
	return resolveLoginApproval(base, requestId, auth, "deny");
}

const FRAME_SEPARATOR = "\n\n";

function parseEvent(frame: string): LoginApprovalEvent | null {
	const data = frame
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice("data:".length).trim())
		.join("\n");
	if (!data) {
		return null;
	}
	const parsed = eventSchema.safeParse(JSON.parse(data));
	return parsed.success ? parsed.data : null;
}

/**
 * Stream account-level approval events. Fetch is used instead of EventSource so
 * bearer surfaces can attach their Better Auth token; browsers still carry the
 * normal session cookie through `credentials: include`.
 */
export async function streamLoginApprovals(
	base: string,
	auth: LoginApprovalAuth,
	onEvent: (event: LoginApprovalEvent) => void,
	signal?: AbortSignal
): Promise<void> {
	const response = await fetch(apiUrl(base, "/stream"), {
		credentials: "include",
		headers: authHeaders(auth.token),
		method: "GET",
		signal,
	});
	if (!(response.ok && response.body)) {
		throw new LoginApprovalHttpError(
			await errorMessage(response),
			response.status
		);
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (!signal?.aborted) {
			const { done, value } = await reader.read();
			if (done) {
				return;
			}
			buffer += decoder.decode(value, { stream: true });
			let separator = buffer.indexOf(FRAME_SEPARATOR);
			while (separator >= 0 && !signal?.aborted) {
				const frame = buffer.slice(0, separator);
				buffer = buffer.slice(separator + FRAME_SEPARATOR.length);
				const event = parseEvent(frame);
				if (event) {
					onEvent(event);
				}
				separator = buffer.indexOf(FRAME_SEPARATOR);
			}
		}
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

export {
	LOGIN_APPROVAL_CLIENTS,
	normalizeLoginApprovalUserCode,
	parseLoginApprovalQr,
} from "./login-approval-contract.ts";
