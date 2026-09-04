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

export const LOGIN_APPROVAL_SURFACE_LABELS: Record<
	LoginApprovalSurface,
	string
> = {
	desktop: "Ryu Desktop",
	extension: "Ryu Browser Extension",
	mobile: "Ryu Mobile",
	web: "Ryu Website",
};

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

export function clientIdForLoginApprovalSurface(
	surface: LoginApprovalSurface
): string {
	return LOGIN_APPROVAL_CLIENTS[surface];
}

export function loginApprovalSurfaceForClientId(
	clientId: string
): LoginApprovalSurface | null {
	for (const [surface, candidate] of Object.entries(LOGIN_APPROVAL_CLIENTS)) {
		if (candidate === clientId) {
			return surface as LoginApprovalSurface;
		}
	}
	return null;
}
