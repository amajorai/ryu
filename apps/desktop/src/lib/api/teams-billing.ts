// apps/desktop/src/lib/api/teams-billing.ts
//
// Typed client for the org-scoped Teams billing surface (epic #496, Unit D1).
// Like credits.ts (and unlike the Core-node clients), this targets the
// identity/control-plane server (:3000, BACKEND_URL), authenticated with the
// Better-Auth session bearer token. Member seats, the shared wallet, and
// organization billing all live in the control plane (packages/api).
//
// RBAC is enforced SERVER-SIDE by the billing/credits routers: seat checkout,
// seat changes, and portal access require an org owner/admin; wallet reads are
// member-visible. This client never decides who may mutate; it only hides
// controls as a courtesy and surfaces the server's 403/422.
//
//   GET  /api/billing/subscription-status -> org plan + entitlement (pool)
//   POST /api/billing/checkout/teams      -> native seat checkout URL
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
}

export interface SubscriptionStatus {
	entitlement: Entitlement;
	/**
	 * Server-driven rollout flags. Declared here so the SSE path carries them:
	 * `BillingStatusEvent.subscription` IS this payload, so a frame lands them
	 * at `frame.subscription.features`. Without the field the push path would
	 * silently type-drop it while the TTL path kept working — the hardest
	 * version of this bug to notice.
	 *
	 * Required, matching this file's all-required style. Note the compiler
	 * cannot enforce it either way: both desktop mirrors are independent
	 * structural declarations cast off `resp.json()`, NOT imports of the
	 * server's `SubscriptionStatusPayload`, so nothing links them. They are kept
	 * in step by hand.
	 */
	features: Record<string, boolean>;
	hostedAgents: HostedAgentEntitlement | null;
	organizationId: string | null;
	plan: string | null;
	scope: "org" | "user";
}

export function fetchSubscriptionStatus(): Promise<SubscriptionStatus> {
	return get<SubscriptionStatus>("/billing/subscription-status");
}

/** Member-seat state for the active organization. Polar owns billedSeats. */
export interface TeamsSeatStatus {
	billedSeats: number | null;
	bonusExpiresAt: string | null;
	bonusSeats: number;
	includedCreditPoolMicroUsd: number | null;
	includedSeats: number | null;
	memberCount: number;
	minRequired: number;
	minSeats: number;
	organizationId: string;
	overAllocated: boolean;
	pendingSeatReservations: number;
	plan: string | null;
}

export type OrganizationPlanId = "teams" | "business";

export interface OrganizationPlanCheckout {
	monthlyPriceMicroUsd: number;
	plan: OrganizationPlanId;
	seats: number;
	url: string;
}

export function fetchTeamsSeatStatus(): Promise<TeamsSeatStatus> {
	return get<TeamsSeatStatus>("/billing/seats");
}

/** Start a native Polar checkout for a human-seat organization plan. */
export function checkoutOrganizationPlan(
	planId: OrganizationPlanId,
	interval: "monthly" | "yearly",
	seats: number,
	organizationId?: string | null
): Promise<OrganizationPlanCheckout> {
	return post("/billing/checkout/organization", {
		interval,
		organizationId,
		planId,
		seats,
	});
}

/** Start the native Polar seat-based Teams checkout. */
export function checkoutTeams(
	interval: "monthly" | "yearly",
	seats: number,
	organizationId?: string | null
): Promise<{ seats: number; url: string }> {
	return post("/billing/checkout/teams", {
		interval,
		organizationId,
		seats,
	});
}

/** Start the one-month desktop onboarding offer at the fixed five-seat floor. */
export interface TeamsOnboardingCheckout {
	offer: {
		firstMonthUsd: number;
		interval: "monthly";
		recurringMonthUsd: number;
	};
	seats: number;
	url: string;
}

export function checkoutTeamsOnboarding(
	organizationId?: string | null
): Promise<TeamsOnboardingCheckout> {
	return post("/billing/checkout/teams/onboarding", { organizationId });
}

/** Update the billed seat quantity; server-side RBAC and floors still apply. */
export function updateTeamsSeats(seats: number): Promise<{
	memberCount: number;
	pendingSeatCount: number;
	prorationBehavior: "invoice";
	prorationLabel: string;
	seats: number;
}> {
	return post("/billing/seats", { seats });
}

export type HostedAgentPlanId = "max" | "pro" | "teams";

export interface HostedAgentEntitlement {
	bonusAgents: number;
	contractedAgents: number;
	effectiveAgents: number;
	includedCreditPoolMicroUsd: number;
	monthlyPriceMicroUsd: number;
	nodeProfile: string;
	planId: HostedAgentPlanId;
}

/**
 * A live billing-status snapshot pushed by `GET /api/billing/status/stream`
 * (SSE `event: "billing-status"`). The subscription payload includes the
 * hosted-agent entitlement, and is emitted on connect and whenever a
 * Polar/Stripe webhook changes organization billing.
 */
export interface BillingStatusUpdate {
	organizationId: string | null;
	scope: "org" | "user";
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

/** Legacy Pro/Max process-agent checkout; Teams uses {@link checkoutTeams}. */
export function checkoutHostedAgents(
	planId: HostedAgentPlanId,
	agentCount: number
): Promise<{
	agentCount: number;
	monthlyPriceUsd: number;
	planId: HostedAgentPlanId;
	url: string;
}> {
	return post("/billing/checkout/agents", { agentCount, planId });
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
