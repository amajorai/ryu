// apps/desktop/src/lib/api/billing.ts
//
// Typed client for the desktop trial + entitlement + license-key gate (epic
// #496, Unit C1).
//
// Like credits.ts / channels.ts (and unlike the Core-node clients), this targets
// the identity/control-plane server (:3000, BACKEND_URL), authenticated with the
// Better-Auth session bearer token in localStorage. Billing/entitlement is a
// "what is allowed / paid for" concern and lives in the control plane.
//
// Why a desktop-native client (not @ryu/settings useSubscription): the settings
// api-client authenticates with COOKIES (`credentials: "include"`), which the
// Tauri webview does not carry for :3000 unless `configureSettingsApi` is wired
// (it is not). A gate that silently fails to `false` would falsely lock out a
// real Pro user, so the gate reads its own bearer-authed endpoints and consumes
// the server's richer `entitlement` field directly.
//
//   GET  /api/billing/subscription-status -> { entitlement, plan, ... }
//   GET  /api/billing/trial               -> { firstLaunchAt }  (idempotent anchor)
//   POST /api/billing/trial               -> { firstLaunchAt }  (ensure-then-read)
//   POST /api/billing/license/validate    -> { active, status, expiresAt, productId }

import type { Entitlement, PlanId } from "@ryu/auth/lib/plans";
import { BACKEND_URL, TOKEN_KEY } from "@/lib/auth-client.ts";

/** True when the user has a session token; the gate requires sign-in. */
export function hasBillingAuth(): boolean {
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
		// No storage — the request 401s and the caller treats it as a failed check.
	}
	return headers;
}

const BASE = `${BACKEND_URL.replace(/\/$/, "")}/api/billing`;

/** The subscription-status payload's entitlement-bearing fields (Unit B1). */
export interface SubscriptionStatus {
	entitlement?: Entitlement | null;
	plan?: PlanId | null;
	scope?: "org" | "user";
	seats?: number;
	subscription?: {
		currentPeriodEnd?: string | null;
		interval?: string | null;
		status?: string | null;
	} | null;
}

/**
 * Fetch the caller's resolved entitlement from the control plane. Returns the
 * server's `entitlement` object, or null when the check FAILED (offline / 5xx /
 * not signed in) so the gate can distinguish "no entitlement" (a successful
 * un-entitled result) from "could not check" (ride the offline cache).
 */
export async function fetchEntitlement(): Promise<Entitlement | null> {
	if (!hasBillingAuth()) {
		return null;
	}
	try {
		const resp = await fetch(`${BASE}/subscription-status`, {
			headers: authHeaders(),
		});
		if (!resp.ok) {
			return null;
		}
		const json = (await resp.json()) as SubscriptionStatus;
		return json.entitlement ?? null;
	} catch {
		return null;
	}
}

/** Fetch the full billing status when a surface needs plan metadata. */
export async function fetchEntitlementStatus(): Promise<SubscriptionStatus> {
	if (!hasBillingAuth()) {
		return { entitlement: null, plan: null, subscription: null };
	}
	const resp = await fetch(`${BASE}/subscription-status`, {
		headers: authHeaders(),
	});
	if (!resp.ok) {
		throw new Error(`Billing status failed: ${resp.status}`);
	}
	return (await resp.json()) as SubscriptionStatus;
}

/** Why a checkout attempt could not produce a URL. */
export type CheckoutErrorKind = "auth" | "unavailable" | "unknown";

export class CheckoutError extends Error {
	readonly kind: CheckoutErrorKind;
	constructor(kind: CheckoutErrorKind, message: string) {
		super(message);
		this.name = "CheckoutError";
		this.kind = kind;
	}
}

/**
 * Create a Polar checkout for a pricing-plan slug (e.g. "lifetime",
 * "pro-monthly", "max-yearly") via the control-plane's generic bearer-authed
 * endpoint, returning the hosted checkout URL for the caller to open externally
 * (Tauri opener). The desktop cannot run Better Auth's Polar client plugin, so
 * this mirrors the web `authClient.checkout({ slug })` over a plain fetch.
 *
 * Throws a {@link CheckoutError} when the URL could not be produced (not signed
 * in / product unconfigured / network) so the paywall shows an actionable
 * message instead of silently doing nothing.
 */
export async function createCheckout(slug: string): Promise<string> {
	if (!hasBillingAuth()) {
		throw new CheckoutError("auth", "Sign in to continue to checkout.");
	}
	let resp: Response;
	try {
		resp = await fetch(`${BASE}/checkout`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({ slug }),
		});
	} catch {
		throw new CheckoutError(
			"unknown",
			"Could not reach the checkout server. Check your connection."
		);
	}
	if (resp.status === 401) {
		throw new CheckoutError("auth", "Sign in to continue to checkout.");
	}
	if (resp.status === 503) {
		throw new CheckoutError(
			"unavailable",
			"This plan is not available for purchase right now."
		);
	}
	if (!resp.ok) {
		throw new CheckoutError("unknown", `Checkout failed (${resp.status}).`);
	}
	const json = (await resp.json()) as { url?: string };
	if (!json.url) {
		throw new CheckoutError("unknown", "Checkout did not return a URL.");
	}
	return json.url;
}

/** The server-authoritative trial anchor. */
export interface TrialAnchor {
	firstLaunchAt: string | null;
}

/**
 * Ensure + read the server-side first-launch anchor (idempotent: written once,
 * never moved forward, so a reinstall cannot reset the trial). Returns the
 * epoch-ms first-launch time, or null when the check failed (the gate then
 * falls back to the local Tauri-store mirror).
 */
export async function ensureTrialAnchorMs(): Promise<number | null> {
	if (!hasBillingAuth()) {
		return null;
	}
	try {
		const resp = await fetch(`${BASE}/trial`, {
			method: "POST",
			headers: authHeaders(),
		});
		if (!resp.ok) {
			return null;
		}
		const json = (await resp.json()) as TrialAnchor;
		const ms = json.firstLaunchAt ? Date.parse(json.firstLaunchAt) : Number.NaN;
		return Number.isFinite(ms) ? ms : null;
	} catch {
		return null;
	}
}

/** The normalized result of validating a desktop license key. */
export interface LicenseValidateResult {
	active: boolean;
	expiresAt: string | null;
	productId: string | null;
	status: string | null;
}

/** Why a license validate attempt could not produce a definitive answer. */
export type LicenseValidateErrorKind = "auth" | "unavailable" | "unknown";

export class LicenseValidateError extends Error {
	readonly kind: LicenseValidateErrorKind;
	constructor(kind: LicenseValidateErrorKind, message: string) {
		super(message);
		this.name = "LicenseValidateError";
		this.kind = kind;
	}
}

/**
 * Validate a desktop license key via the control plane (which proxies Polar's
 * org-level validate API, so the Polar token never reaches the client).
 *
 * Throws a {@link LicenseValidateError} on a check that could not run (not
 * signed in / validation unavailable / network) so the UI shows an actionable
 * message rather than treating an unreachable server as "invalid key". A
 * genuinely-invalid key resolves to `{ active: false }`, not a throw.
 */
export async function validateLicenseKey(
	key: string
): Promise<LicenseValidateResult> {
	if (!hasBillingAuth()) {
		throw new LicenseValidateError("auth", "Sign in to enter a license key.");
	}
	let resp: Response;
	try {
		resp = await fetch(`${BASE}/license/validate`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({ key }),
		});
	} catch {
		throw new LicenseValidateError(
			"unknown",
			"Could not reach the license server. Check your connection."
		);
	}
	if (resp.status === 401) {
		throw new LicenseValidateError("auth", "Sign in to enter a license key.");
	}
	if (resp.status === 503) {
		throw new LicenseValidateError(
			"unavailable",
			"License validation is not available right now."
		);
	}
	if (!resp.ok) {
		throw new LicenseValidateError(
			"unknown",
			`License validation failed (${resp.status}).`
		);
	}
	return (await resp.json()) as LicenseValidateResult;
}
