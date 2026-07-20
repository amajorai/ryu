// apps/desktop/src/lib/api/upsell.ts
//
// Typed client for the soft conversion-upsell loop (free-tier gating plan,
// 2026-07-11 addendum). Like billing.ts, this targets the identity/control-plane
// server (:3000, BACKEND_URL) with the Better-Auth session bearer token: the
// upsell is closed-product marketing logic and lives in the control plane, never
// in OSS core/gateway.
//
// The server computes WHAT to show (the ranked pitch cards, via
// `selectUpsellCards` in @ryu/auth/lib/upsell); the client decides WHEN to show
// (the launch show-cadence in entitlement-context). This client is the thin wire
// between the two.
//
//   GET  /api/upsell/pitch      -> { cards: UpsellCard[] }   ranked for this week
//   GET  /api/upsell/state      -> { lastUpsellShownAt }     per-user, not per-device
//   POST /api/upsell/shown      body { cardIds }             stamp lastUpsellShownAt
//   POST /api/upsell/converted  body { cardIds }             click-through signal
//
// Contract note for the packages/api agent: `lastUpsellShownAt` is expected as an
// ISO-8601 string (a number epoch-ms is also tolerated here). `POST /shown`
// stamps the server-side timestamp so the modal does not re-fire per device.
// `POST /converted` records a CLICK-THROUGH (the user acted on the Upgrade CTA),
// NOT a purchase — true conversion attribution is server-side via Polar. Keep the
// two events distinct so the weights can later be tuned against real purchases.

import type { UpsellCard } from "@ryu/auth/lib/upsell";
import { BACKEND_URL, TOKEN_KEY } from "@/lib/auth-client.ts";

const BASE = `${BACKEND_URL.replace(/\/$/, "")}/api/upsell`;

/** True when the user has a session token; the upsell requires sign-in. */
function hasUpsellAuth(): boolean {
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

/** The per-user upsell show-state used by the client to decide cadence. */
export interface UpsellState {
	/**
	 * When the soft upsell was last shown, in epoch ms, or null when it has never
	 * been shown for this user. A FAILED fetch resolves to null too — but the
	 * caller must distinguish the two: only a *successful* null means "never
	 * shown → eligible". See {@link fetchUpsellState}.
	 */
	readonly lastUpsellShownAtMs: number | null;
}

/** Parse the server's `lastUpsellShownAt` (ISO string or epoch-ms) into ms. */
function parseShownAt(value: unknown): number | null {
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : null;
	}
	if (typeof value === "string") {
		const ms = Date.parse(value);
		return Number.isFinite(ms) ? ms : null;
	}
	return null;
}

/**
 * Fetch the per-user show-state. Resolves to `null` when the check FAILED
 * (offline / 404 while the endpoint is unbuilt / not signed in) so the caller
 * can FAIL SAFE and not show the modal. A successful response with no prior show
 * resolves to `{ lastUpsellShownAtMs: null }` — distinct from the failure null.
 */
export async function fetchUpsellState(): Promise<UpsellState | null> {
	if (!hasUpsellAuth()) {
		return null;
	}
	try {
		const resp = await fetch(`${BASE}/state`, { headers: authHeaders() });
		if (!resp.ok) {
			return null;
		}
		const json = (await resp.json()) as { lastUpsellShownAt?: unknown };
		return { lastUpsellShownAtMs: parseShownAt(json.lastUpsellShownAt) };
	} catch {
		return null;
	}
}

/**
 * Fetch the ranked pitch cards for this user's current week. Returns an empty
 * array on any failure (offline / unbuilt endpoint / not signed in) so the
 * caller simply shows nothing. Tolerates both `{ cards: [...] }` and a bare
 * array body.
 */
export async function fetchUpsellPitch(): Promise<UpsellCard[]> {
	if (!hasUpsellAuth()) {
		return [];
	}
	try {
		const resp = await fetch(`${BASE}/pitch`, { headers: authHeaders() });
		if (!resp.ok) {
			return [];
		}
		const json = (await resp.json()) as { cards?: UpsellCard[] } | UpsellCard[];
		const cards = Array.isArray(json) ? json : (json.cards ?? []);
		return Array.isArray(cards) ? cards : [];
	} catch {
		return [];
	}
}

/**
 * Stamp the server-side `lastUpsellShownAt` and record which cards were shown.
 * Best-effort: a failure only means the cadence may re-fire sooner, never a
 * broken UI.
 */
export async function markUpsellShown(cardIds: string[]): Promise<void> {
	if (!hasUpsellAuth()) {
		return;
	}
	try {
		await fetch(`${BASE}/shown`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({ cardIds }),
		});
	} catch {
		// Non-fatal: the show-state stamp is best-effort.
	}
}

/**
 * Record a click-through on the Upgrade CTA for the shown cards. This is an
 * INTENT signal, not a purchase — final conversion is attributed server-side via
 * Polar. Best-effort.
 */
export async function markUpsellConverted(cardIds: string[]): Promise<void> {
	if (!hasUpsellAuth()) {
		return;
	}
	try {
		await fetch(`${BASE}/converted`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({ cardIds }),
		});
	} catch {
		// Non-fatal: outcome logging is best-effort.
	}
}

/** Seven days in ms — the minimum gap between soft-upsell shows. */
export const UPSELL_MIN_GAP_MS = 7 * 24 * 60 * 60 * 1000;
