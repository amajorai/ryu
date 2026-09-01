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
// Why a desktop-native client (not @ryu/settings useSubscription): the gate has
// to tell "un-entitled" apart from "could not check". A hook that resolves an
// outage to `false` would falsely lock out a real Pro user, so every function
// here returns null on a FAILED check and lets the caller ride the offline
// cache instead. They also consume the server's richer `entitlement` object
// directly rather than re-deriving a plan from the subscription row.
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

/**
 * The lifetime (desktop-license) order and its updates window. Mirrors the
 * server's `LifetimeOrderData` (packages/api/src/lib/billing-scope.ts).
 * `expired` means only that the UPDATES window lapsed — a desktop licence is
 * perpetual and is never revoked by it.
 */
export interface LifetimeUpdatesWindow {
	expired: boolean;
	purchasedAt: string;
	updatesExpiresAt: string;
}

/** The subscription-status payload's entitlement-bearing fields (Unit B1). */
export interface SubscriptionStatus {
	entitlement?: Entitlement | null;
	/**
	 * Server-driven rollout flags. Optional like every field here — this is a
	 * structural view of the JSON, not a checked mirror of the server's
	 * `SubscriptionStatusPayload`, so an older control plane simply omits it.
	 */
	features?: Record<string, boolean> | null;
	lifetime?: LifetimeUpdatesWindow | null;
	/** The organization that owns this resolved plan, when billing is org-scoped. */
	organizationId?: string | null;
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
 * Both facts the desktop needs, from ONE request. `null` means the check
 * FAILED or the user is not signed in — distinct from a successful
 * un-entitled result, which returns a non-null object with `entitlement: null`.
 */
export interface EntitlementSnapshot {
	entitlement: Entitlement | null;
	/**
	 * The rollout flags this caller is served, or null when the control plane
	 * carried none (an older server, or a client whose build predates the
	 * field). Kept NULLABLE rather than defaulted to `{}` for this file's whole
	 * reason to exist: `{}` would read as "checked, and every flag is off",
	 * which is exactly the outage-becomes-a-lockout mistake the header rejects.
	 * The flag cache turns null into the compiled-in default per key instead.
	 */
	features: Record<string, boolean> | null;
	lifetime: LifetimeUpdatesWindow | null;
}

/**
 * Fetch the caller's resolved entitlement (the paywall gate) and their lifetime
 * updates window (the updater) in a single round-trip — the endpoint has always
 * carried both, so reading the window costs no extra request.
 */
export async function fetchEntitlementSnapshot(): Promise<EntitlementSnapshot | null> {
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
		return {
			entitlement: json.entitlement ?? null,
			features: json.features ?? null,
			lifetime: json.lifetime ?? null,
		};
	} catch {
		return null;
	}
}

/**
 * Fetch the caller's resolved entitlement from the control plane. Returns the
 * server's `entitlement` object, or null when the check FAILED (offline / 5xx /
 * not signed in) so the gate can distinguish "no entitlement" (a successful
 * un-entitled result) from "could not check" (ride the offline cache).
 */
export async function fetchEntitlement(): Promise<Entitlement | null> {
	return (await fetchEntitlementSnapshot())?.entitlement ?? null;
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
			headers: {
				...authHeaders(),
				"Idempotency-Key": crypto.randomUUID(),
			},
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
