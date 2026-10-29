/**
 * Cross-surface passwordless login approval contract.
 *
 * This file is deliberately browser-safe: it contains no database, Better Auth
 * server, or host UI imports. The auth server and every Ryu client import these
 * same names so surface-specific adapters cannot drift.
 */

export const LOGIN_APPROVAL_CLIENTS = {
	desktop: "ryu-desktop",
	extension: "ryu-extension",
	mobile: "ryu-mobile",
	web: "ryu-web",
} as const;

export type LoginApprovalSurface = keyof typeof LOGIN_APPROVAL_CLIENTS;

export const LOGIN_APPROVAL_SURFACE_LABELS = {
	desktop: "Ryu Desktop",
	extension: "Ryu Browser Extension",
	mobile: "Ryu Mobile",
	web: "Ryu Website",
} satisfies Record<LoginApprovalSurface, string>;

export const LOGIN_APPROVAL_SCOPE = "openid profile email";
export const LOGIN_APPROVAL_EXPIRES_IN_SECONDS = 5 * 60;
export const LOGIN_APPROVAL_POLL_INTERVAL_SECONDS = 5;

export interface LoginApprovalStart {
	deviceCode: string | null;
	expiresIn: number;
	interval: number;
	requestId: string;
	userCode: string | null;
	verificationUri: string | null;
	verificationUriComplete: string | null;
}

export interface LoginApprovalQrPayload {
	userCode: string;
	verificationUri: string;
}

export interface LoginApprovalRequest {
	clientId: string;
	createdAt: string;
	deviceLabel: string;
	expiresAt: string;
	id: string;
	ipAddress: string | null;
	status: "pending" | "approving" | "approved" | "denied";
	surface: LoginApprovalSurface;
	userAgent: string | null;
	userCode: string;
}

export type LoginApprovalEvent =
	| { request: LoginApprovalRequest; type: "created" }
	| { requestId: string; type: "approved" | "denied" };

/** Normalize the Better Auth user code without accepting arbitrary QR payloads. */
export function normalizeLoginApprovalUserCode(value: string): string {
	return value.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

/**
 * Parse the URL returned as Better Auth's `verification_uri_complete`.
 *
 * The QR contains only the expiring, human-visible user code. Requiring the
 * `/device` verification path keeps the native scanner from treating unrelated
 * QR links as sign-in requests, while HTTP is retained for local development.
 */
export function parseLoginApprovalQr(
	value: string
): LoginApprovalQrPayload | null {
	const raw = value.trim();
	if (!raw || raw.length > 2000) {
		return null;
	}
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		return null;
	}
	const path = url.pathname.replace(/\/+$/, "");
	if (!path.endsWith("/device")) {
		return null;
	}
	const userCode = normalizeLoginApprovalUserCode(
		url.searchParams.get("user_code") ?? ""
	);
	if (!(userCode.length >= 4 && userCode.length <= 191)) {
		return null;
	}
	return { userCode, verificationUri: url.toString() };
}

export function loginApprovalSurfaceForClientId(
	clientId: string
): LoginApprovalSurface | null {
	switch (clientId) {
		case LOGIN_APPROVAL_CLIENTS.desktop:
			return "desktop";
		case LOGIN_APPROVAL_CLIENTS.extension:
			return "extension";
		case LOGIN_APPROVAL_CLIENTS.mobile:
			return "mobile";
		case LOGIN_APPROVAL_CLIENTS.web:
			return "web";
		default:
			return null;
	}
}
