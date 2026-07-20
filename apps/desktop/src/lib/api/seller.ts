// apps/desktop/src/lib/api/seller.ts
//
// Typed client for the Stripe Connect "Become a seller" flow (monetization #492,
// spec §3). A seller = one Organization; both routes resolve the caller's active
// org server-side, so they take no org argument (mirrors credits.ts).
//
// Targets the identity/control-plane server (:3000, BACKEND_URL) with the
// Better-Auth session bearer. Onboarding opens a Stripe-hosted Express URL
// externally (KYC, bank, tax) — Ryu never touches seller PII. Payout/onboarding
// state is materialized from the `account.updated` webhook, so after returning
// from Stripe the UI re-fetches status on window focus.
//
//   GET  /api/seller/status   -> stored onboarding + payouts-enabled state
//   POST /api/seller/onboard  -> a fresh Stripe-hosted onboarding URL (admin-gated)

import { BACKEND_URL, TOKEN_KEY } from "@/lib/auth-client.ts";

/** Onboarding lifecycle, mirroring the server's `SellerOnboardingStatus`. */
export type SellerOnboardingStatus =
	| "none"
	| "pending"
	| "active"
	| "restricted";

/** The stored seller state for the caller's active org. */
export interface SellerStatus {
	onboardingStatus: SellerOnboardingStatus;
	payoutsEnabled: boolean;
	stripeConnectAccountId: string | null;
}

/** True when the user has a session token; the seller flow requires sign-in. */
export function hasSellerAuth(): boolean {
	try {
		return Boolean(localStorage.getItem(TOKEN_KEY));
	} catch {
		return false;
	}
}

function authHeaders(): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	try {
		const token = localStorage.getItem(TOKEN_KEY);
		if (token) {
			headers.Authorization = `Bearer ${token}`;
		}
	} catch {
		// No storage — request will 401 and the UI prompts to sign in.
	}
	return headers;
}

const BASE = `${BACKEND_URL.replace(/\/$/, "")}/api/seller`;

/**
 * Classified degrade-cleanly states:
 *   - "auth":   401, not signed in.
 *   - "no_org": 409, no active org (a seller account is org-level).
 *   - "admin":  403, the caller is not an org admin (onboarding only).
 *   - "stripe": 502/503, Stripe is unconfigured/unreachable (onboarding only).
 */
export type SellerErrorKind =
	| "auth"
	| "no_org"
	| "admin"
	| "stripe"
	| "unknown";

export class SellerError extends Error {
	readonly kind: SellerErrorKind;
	constructor(kind: SellerErrorKind, message: string) {
		super(message);
		this.name = "SellerError";
		this.kind = kind;
	}
}

async function toError(resp: Response): Promise<SellerError> {
	let message: string | undefined;
	try {
		const body = (await resp.json()) as { message?: string; error?: string };
		message = body.message ?? body.error;
	} catch {
		// Non-JSON body.
	}
	if (resp.status === 401) {
		return new SellerError("auth", message ?? "Sign in to become a seller.");
	}
	if (resp.status === 409) {
		return new SellerError(
			"no_org",
			message ??
				"A seller account is org-level. Create or select an organization first."
		);
	}
	if (resp.status === 403) {
		return new SellerError(
			"admin",
			message ?? "Only an org admin may manage the seller account."
		);
	}
	if (resp.status === 502 || resp.status === 503) {
		return new SellerError(
			"stripe",
			message ?? "Seller onboarding is unavailable: Stripe is not configured."
		);
	}
	return new SellerError(
		"unknown",
		message ?? `Request failed: ${resp.status}`
	);
}

/** Read the active org's stored seller status (no live Stripe call). */
export async function fetchSellerStatus(): Promise<SellerStatus> {
	const resp = await fetch(`${BASE}/status`, { headers: authHeaders() });
	if (!resp.ok) {
		throw await toError(resp);
	}
	const json = (await resp.json()) as Partial<SellerStatus>;
	return {
		stripeConnectAccountId: json.stripeConnectAccountId ?? null,
		payoutsEnabled: Boolean(json.payoutsEnabled),
		onboardingStatus: json.onboardingStatus ?? "none",
	};
}

export interface OnboardResult {
	accountId: string;
	created: boolean;
	url: string;
}

/**
 * Create (or reuse) the org's Connect Express account and return a fresh
 * Stripe-hosted onboarding URL to open externally. Admin-gated server-side.
 */
export async function startOnboarding(
	input: { returnUrl?: string; refreshUrl?: string; country?: string } = {}
): Promise<OnboardResult> {
	const resp = await fetch(`${BASE}/onboard`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify(input),
	});
	if (!resp.ok) {
		throw await toError(resp);
	}
	const json = (await resp.json()) as Partial<OnboardResult>;
	if (!json.url) {
		throw new SellerError("unknown", "Onboarding session has no URL.");
	}
	return {
		accountId: json.accountId ?? "",
		created: Boolean(json.created),
		url: json.url,
	};
}
