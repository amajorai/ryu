// apps/desktop/src/lib/api/teams-billing.ts
//
// Typed client for the org-scoped Teams billing surface (epic #496, Unit D1).
// Like credits.ts (and unlike the Core-node clients), this targets the
// identity/control-plane server (:3000, BACKEND_URL), authenticated with the
// Better-Auth session bearer token. Billing/seats/wallet are "what is allowed /
// shared / paid for" concerns and live in the control plane (packages/api).
//
// RBAC is enforced SERVER-SIDE by the billing/credits routers: the seat
// mutation + the Teams checkout require an org owner/admin; the wallet + seat
// reads are member-visible. This client never decides who may mutate; it only
// hides controls as a courtesy and surfaces the server's 403/422.
//
//   GET  /api/billing/subscription-status -> org plan + entitlement (pool)
//   GET  /api/billing/seats               -> seat status (member-readable)
//   POST /api/billing/seats               -> set billed seats (owner/admin)
//   POST /api/billing/checkout/teams      -> a Polar Teams checkout URL
//   GET  /api/billing/portal              -> the Polar billing portal URL
//   GET  /api/credits/wallet              -> the pooled org wallet balance

import { openSse, type SseMessage } from "@ryuhq/protocol/sse";
import { BACKEND_URL, TOKEN_KEY } from "@/lib/auth-client.ts";

/** The Better-Auth session bearer token, or null when signed out / no storage. */
function authToken(): string | null {
	try {
		return localStorage.getItem(TOKEN_KEY);
	} catch {
		// No storage — treated as signed out.
		return null;
	}
}

/** True when the user has a session token; the Teams surface requires sign-in. */
export function hasTeamsBillingAuth(): boolean {
	return Boolean(authToken());
}

function authHeaders(): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	const token = authToken();
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}
	return headers;
}

const BASE = `${BACKEND_URL.replace(/\/$/, "")}/api`;

/** Distinguishes the degrade-cleanly states so the UI can tailor the message. */
export type TeamsBillingErrorKind =
	| "auth"
	| "no_org"
	| "forbidden"
	| "needs_upgrade"
	| "invalid"
	| "unknown";

export class TeamsBillingError extends Error {
	readonly kind: TeamsBillingErrorKind;
	/** Server-flagged over-allocation (the upgrade prompt). */
	readonly needsUpgrade: boolean;
	constructor(
		kind: TeamsBillingErrorKind,
		message: string,
		needsUpgrade = false
	) {
		super(message);
		this.name = "TeamsBillingError";
		this.kind = kind;
		this.needsUpgrade = needsUpgrade;
	}
}

async function toError(resp: Response): Promise<TeamsBillingError> {
	let message: string | undefined;
	let needsUpgrade = false;
	try {
		const body = (await resp.json()) as {
			message?: string;
			error?: string;
			needsUpgrade?: boolean;
		};
		message = body.message ?? body.error;
		needsUpgrade = Boolean(body.needsUpgrade);
	} catch {
		// Non-JSON body.
	}
	if (resp.status === 401) {
		return new TeamsBillingError("auth", message ?? "Sign in to manage Teams.");
	}
	if (resp.status === 403) {
		return new TeamsBillingError(
			"forbidden",
			message ?? "Only an organization owner or admin can do that."
		);
	}
	if (resp.status === 409) {
		return new TeamsBillingError(
			"no_org",
			message ?? "Teams applies to an organization. Create or select one first."
		);
	}
	if (resp.status === 422) {
		return new TeamsBillingError(
			needsUpgrade ? "needs_upgrade" : "invalid",
			message ?? "Invalid seat count.",
			needsUpgrade
		);
	}
	return new TeamsBillingError(
		"unknown",
		message ?? `Request failed: ${resp.status}`
	);
}

async function get<T>(path: string): Promise<T> {
	const resp = await fetch(`${BASE}${path}`, { headers: authHeaders() });
	if (!resp.ok) {
		throw await toError(resp);
	}
	return (await resp.json()) as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
	const resp = await fetch(`${BASE}${path}`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify(body),
	});
	if (!resp.ok) {
		throw await toError(resp);
	}
	return (await resp.json()) as T;
}

/** The entitlement resolved by subscription-status (subset read here). */
export interface Entitlement {
	desktopAccess: boolean;
	managedInference: boolean;
	monthlyCreditPoolMicroUsd: number;
	plan: string | null;
	seats: number;
}

export interface SubscriptionStatus {
	entitlement: Entitlement;
	organizationId: string | null;
	plan: string | null;
	scope: "org" | "user";
	seats: number;
}

export function fetchSubscriptionStatus(): Promise<SubscriptionStatus> {
	return get<SubscriptionStatus>("/billing/subscription-status");
}

/** Seat status for the active org (member-readable). */
export interface SeatStatus {
	billedSeats: number | null;
	memberCount: number;
	minRequired: number;
	minSeats: number;
	organizationId: string;
	overAllocated: boolean;
	plan: string | null;
}

export function fetchSeatStatus(): Promise<SeatStatus> {
	return get<SeatStatus>("/billing/seats");
}

/**
 * A live billing-status snapshot pushed by `GET /api/billing/status/stream`
 * (SSE `event: "billing-status"`): the caller's active-org subscription status
 * combined with its seat status. Mirrors the {@link SubscriptionStatus} and
 * {@link SeatStatus} REST reads (`scope`/`organizationId` ride along on
 * `subscription`). Emitted on connect (snapshot) and whenever a Polar/Stripe
 * webhook changes the plan or seat count. `seats` is null for a user-scope
 * caller with no org (matching the server's `SeatStatusPayload | null`).
 */
export interface BillingStatusUpdate {
	seats: SeatStatus | null;
	subscription: SubscriptionStatus;
}

/**
 * Open the active org's live billing-status stream and async-iterate its frames.
 * Sends the session bearer token in the `Authorization` header (fetch +
 * ReadableStream via `openSse`, not EventSource). Yields one
 * {@link BillingStatusUpdate} per frame and ends when `signal` aborts. Throws on
 * a failed connect so the caller can back off and reconnect.
 */
export function openBillingStatusStream(
	signal: AbortSignal
): AsyncGenerator<SseMessage<BillingStatusUpdate>> {
	return openSse<BillingStatusUpdate>(`${BASE}/billing/status/stream`, {
		token: authToken(),
		signal,
	});
}

/** Set the billed seat count (owner/admin only; validated server-side). */
export function setSeats(seats: number): Promise<{
	seats: number;
	memberCount: number;
}> {
	return post("/billing/seats", { seats });
}

/** Start a Teams subscription checkout for `seats` (owner/admin only). */
export function checkoutTeams(seats: number): Promise<{
	url: string;
	seats: number;
}> {
	return post("/billing/checkout/teams", { seats });
}

/** Open the Polar billing portal (owner/admin only) to change/cancel a plan. */
export function openBillingPortalUrl(): Promise<{ url: string }> {
	return get<{ url: string }>("/billing/portal");
}

/** The pooled org wallet. */
export interface WalletView {
	balanceMicroUsd: number;
	currency: string;
	id: string;
}

export function fetchWallet(): Promise<{ wallet: WalletView }> {
	return get<{ wallet: WalletView }>("/credits/wallet");
}

/** One org membership row (the control plane maps BA roles onto OrgRole). */
export interface OrgMembership {
	id: string;
	name: string;
	role: "owner" | "admin" | "member" | "viewer" | null;
}

/**
 * The caller's role in `organizationId`. The desktop auth client has no
 * organization plugin, so the role is read from the control-plane `/orgs` view
 * (which maps Better Auth member roles onto the control plane's OrgRole). This
 * is only a UI courtesy: the server enforces RBAC on the mutations regardless.
 */
export async function fetchOrgRole(
	organizationId: string
): Promise<OrgMembership["role"]> {
	const { organizations } = await get<{ organizations: OrgMembership[] }>(
		"/control-plane/orgs"
	);
	const org = organizations.find((o) => o.id === organizationId);
	return org?.role ?? null;
}
