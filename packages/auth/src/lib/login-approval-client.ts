import {
	LOGIN_APPROVAL_CLIENTS,
	LOGIN_APPROVAL_POLL_INTERVAL_SECONDS,
	type LoginApprovalEvent,
	type LoginApprovalRequest,
	type LoginApprovalStart,
} from "./login-approval-contract.ts";

export type {
	LoginApprovalEvent,
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

interface LoginApprovalError {
	error?: unknown;
	message?: unknown;
}

function baseUrl(value: string): string {
	return value.replace(/\/+$/, "");
}

function apiUrl(value: string, path: string): string {
	return `${baseUrl(value)}/api/login-approvals${path}`;
}

function recordOf(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

async function errorMessage(response: Response): Promise<string> {
	try {
		const parsed = (await response.json()) as LoginApprovalError;
		if (typeof parsed.message === "string" && parsed.message.trim()) {
			return parsed.message;
		}
		if (typeof parsed.error === "string" && parsed.error.trim()) {
			return parsed.error;
		}
	} catch {
		// The response may be a proxy-generated plain-text error.
	}
	return `Login approval request failed (${response.status})`;
}

function authHeaders(token?: string | null): Record<string, string> {
	return token ? { Authorization: `Bearer ${token}` } : {};
}

function parseRequest(value: unknown): LoginApprovalRequest | null {
	const record = recordOf(value);
	if (!record) {
		return null;
	}
	const status = record.status;
	const surface = record.surface;
	if (
		typeof record.id !== "string" ||
		typeof record.clientId !== "string" ||
		typeof record.createdAt !== "string" ||
		typeof record.deviceLabel !== "string" ||
		typeof record.expiresAt !== "string" ||
		typeof record.userCode !== "string" ||
		(surface !== "desktop" &&
			surface !== "extension" &&
			surface !== "mobile" &&
			surface !== "web") ||
		(status !== "pending" &&
			status !== "approving" &&
			status !== "approved" &&
			status !== "denied")
	) {
		return null;
	}
	return {
		clientId: record.clientId,
		createdAt: record.createdAt,
		deviceLabel: record.deviceLabel,
		expiresAt: record.expiresAt,
		id: record.id,
		ipAddress: typeof record.ipAddress === "string" ? record.ipAddress : null,
		status,
		surface,
		userAgent: typeof record.userAgent === "string" ? record.userAgent : null,
		userCode: record.userCode,
	};
}

function parseStart(value: unknown): LoginApprovalStart | null {
	const record = recordOf(value);
	if (!record || typeof record.requestId !== "string") {
		return null;
	}
	const asStringOrNull = (candidate: unknown): string | null =>
		typeof candidate === "string" && candidate.length > 0 ? candidate : null;
	const asPositiveInteger = (candidate: unknown, fallback: number): number =>
		typeof candidate === "number" && Number.isFinite(candidate)
			? Math.max(1, Math.floor(candidate))
			: fallback;
	return {
		deviceCode: asStringOrNull(record.deviceCode),
		expiresIn: asPositiveInteger(record.expiresIn, 300),
		interval: asPositiveInteger(
			record.interval,
			LOGIN_APPROVAL_POLL_INTERVAL_SECONDS
		),
		requestId: record.requestId,
		userCode: asStringOrNull(record.userCode),
		verificationUri: asStringOrNull(record.verificationUri),
		verificationUriComplete: asStringOrNull(record.verificationUriComplete),
	};
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
	endpoint: "session" | "token",
	options: PollLoginApprovalOptions = {}
): Promise<string | true> {
	if (!start.deviceCode) {
		throw new Error("No matching Ryu account was found");
	}
	let interval = Math.max(start.interval, 1);
	const deadline = Date.now() + start.expiresIn * 1000;
	while (Date.now() < deadline) {
		await wait(interval * 1000, options.signal);
		const response = await fetch(
			`${baseUrl(base)}/api/auth/device/${endpoint}`,
			{
				body: JSON.stringify({
					client_id: clientId,
					device_code: start.deviceCode,
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				}),
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				method: "POST",
				signal: options.signal,
			}
		);
		const data = recordOf(await response.json());
		if (endpoint === "session" && data?.ok === true) {
			return true;
		}
		const token = data?.access_token;
		if (typeof token === "string" && token) {
			return token;
		}
		const error = typeof data?.error === "string" ? data.error : null;
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

/** Poll Better Auth's existing device-token endpoint for a bearer session. */
export async function pollLoginApprovalToken(
	base: string,
	clientId: string,
	start: LoginApprovalStart,
	options: PollLoginApprovalOptions = {}
): Promise<string> {
	const token = await pollLoginApprovalGrant(
		base,
		clientId,
		start,
		"token",
		options
	);
	if (typeof token !== "string") {
		throw new Error("The sign-in request returned no session token");
	}
	return token;
}

/** Poll the browser-only endpoint that sets Better Auth's HttpOnly cookie. */
export async function pollLoginApprovalSession(
	base: string,
	clientId: string,
	start: LoginApprovalStart,
	options: PollLoginApprovalOptions = {}
): Promise<void> {
	await pollLoginApprovalGrant(base, clientId, start, "session", options);
}

/** Read all pending approval prompts for the authenticated account. */
export async function listLoginApprovals(
	base: string,
	auth: LoginApprovalAuth = {}
): Promise<LoginApprovalRequest[]> {
	const response = await fetch(apiUrl(base, "/pending"), {
		credentials: "include",
		headers: authHeaders(auth.token),
		method: "GET",
	});
	if (!response.ok) {
		throw new Error(await errorMessage(response));
	}
	const body = recordOf(await response.json());
	const rows = Array.isArray(body?.requests) ? body.requests : [];
	return rows.flatMap((row) => {
		const parsed = parseRequest(row);
		return parsed ? [parsed] : [];
	});
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
	const parsed = recordOf(JSON.parse(data));
	if (
		!parsed ||
		(parsed.type !== "created" &&
			parsed.type !== "approved" &&
			parsed.type !== "denied")
	) {
		return null;
	}
	if (parsed.type === "created") {
		const request = parseRequest(parsed.request);
		return request ? { request, type: "created" } : null;
	}
	return typeof parsed.requestId === "string"
		? { requestId: parsed.requestId, type: parsed.type }
		: null;
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
		throw new Error(await errorMessage(response));
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			return;
		}
		buffer += decoder.decode(value, { stream: true });
		let separator = buffer.indexOf(FRAME_SEPARATOR);
		while (separator >= 0) {
			const frame = buffer.slice(0, separator);
			buffer = buffer.slice(separator + FRAME_SEPARATOR.length);
			const event = parseEvent(frame);
			if (event) {
				onEvent(event);
			}
			separator = buffer.indexOf(FRAME_SEPARATOR);
		}
	}
}

export { LOGIN_APPROVAL_CLIENTS };
