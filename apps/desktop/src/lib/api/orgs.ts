// apps/desktop/src/lib/api/orgs.ts
//
// The organizations the signed-in user belongs to, and which one their session
// is currently scoped to. Targets the identity/control-plane server (:3000,
// BACKEND_URL) with the Better-Auth session bearer token, like credits.ts and
// teams-billing.ts.
//
//   GET  /api/control-plane/orgs            -> the caller's orgs, with roles
//   POST /api/auth/organization/set-active  -> rescope THIS session
//   GET  /api/credits/transferable          -> what can move, and where to
//   POST /api/credits/transfer              -> move it
//
// WHY set-active IS THE RIGHT LEVER, and not a per-request org parameter: every
// org-scoped route in the control plane (`/api/credits/*`, `/api/billing/*`,
// `/api/affiliate/*`) resolves its org from `session.activeOrganizationId` and
// falls back to the caller's earliest membership. There is no `?orgId=` on any
// of them. The desktop's bearer token is backed by a REAL Better Auth session
// row — the same row `set-active` writes — so switching once rescopes all of
// them at their existing seam, with nothing to thread through.
//
// The transfer routes are the exception and take explicit org ids, because a
// transfer names two orgs and neither of them is necessarily the active one.
//
// Because the active org is the fact every org-scoped surface is implicitly
// parameterised by, this module also owns the ONE cached read of it that the
// whole app shares — `useActiveOrgId` at the bottom. It lives next to
// `getActiveOrgId`/`setActiveOrg` rather than in a hook of its own so the
// accessor, the mutation and the cache key that ties them together cannot drift
// apart.

import { useQuery } from "@tanstack/react-query";
import {
	BACKEND_URL,
	getActiveToken,
	getActiveUserId,
} from "@/lib/auth-client.ts";
import { queryClient as appQueryClient } from "@/src/lib/query-client.ts";
import {
	organizationActivityResponseSchema,
	organizationControlsResponseSchema,
	orgErrorProjectionSchema,
	orgListResponseSchema,
	orgSessionOrganizationScopeSchema,
	orgSessionTeamScopeSchema,
	orgTeamProjectionSchema,
	orgTeamsResponseSchema,
	transferableViewSchema,
	transferResultSchema,
} from "./org-wire-contracts.ts";
import type { PluginDocument } from "./plugin-wire-values.ts";

export function getOrgSessionToken(): string | null {
	try {
		return getActiveToken();
	} catch {
		// No storage — treated as signed out.
		return null;
	}
}

/** True when there is a session token at all; every route here requires one. */
export function hasOrgAuth(): boolean {
	return Boolean(getOrgSessionToken());
}

function authHeaders(token: string | null = getOrgSessionToken()): Headers {
	const headers = new Headers({ "Content-Type": "application/json" });
	if (token) {
		headers.set("Authorization", `Bearer ${token}`);
	}
	return headers;
}

const BASE = BACKEND_URL.replace(/\/$/, "");

async function readError(response: Response): Promise<string> {
	const parsed = orgErrorProjectionSchema.safeParse(
		await response.json().catch(() => null)
	);
	const body = parsed.success ? parsed.data : null;
	return body?.error ?? body?.message ?? `Request failed (${response.status})`;
}

export interface OrgSummary {
	/** Whether the caller may move credits OUT of this org (owner/admin). */
	canSendFrom: boolean;
	id: string;
	/** True for the caller's personal org — where referral rewards are paid. */
	isPersonal: boolean;
	name: string;
	role: string | null;
	slug: string;
}

export interface TransferableGrant {
	expiresAt: string | null;
	id: string;
	originalMicroUsd: number;
	pool: string;
	remainingMicroUsd: number;
}

export interface TransferableView {
	orgs: OrgSummary[];
	source: {
		grants: TransferableGrant[];
		orgId: string;
		topupMicroUsd: number;
	} | null;
}

export interface OrgListEntry {
	createdAt: string | null;
	id: string;
	/**
	 * True for the caller's personal workspace. Server-computed (earliest
	 * membership) rather than derived here from the slug, so there is one rule
	 * for it rather than a desktop copy that can drift — the same field, from the
	 * same helper, that `/api/credits/transferable` puts on {@link OrgSummary}.
	 */
	isPersonal: boolean;
	/**
	 * The org's uploaded logo, exactly as the web dashboard's settings dialog
	 * writes it. `null` when nobody has set one, which is a real answer and not a
	 * failure: the UI falls back to the generative avatar seeded by `id`, the same
	 * placeholder the web shows.
	 */
	logo: string | null;
	name: string;
	role: string | null;
	slug: string;
}

export interface OrgTeamEntry {
	id: string;
	name: string;
}

export type OrganizationAuditActorType = "gateway" | "system" | "user";

/** One bounded, redacted event returned by the organization audit projections. */
export interface OrganizationAuditEntry {
	action: string;
	actor: {
		email: string | null;
		id: string | null;
		name: string | null;
		type: OrganizationAuditActorType;
	};
	agentId: string | null;
	details: PluginDocument;
	error: string | null;
	eventType: string;
	feature: string | null;
	id: string;
	requestId: string | null;
	scope: "gateway" | "org";
	sessionId: string | null;
	target: string;
	targetId: string | null;
	timestamp: string;
}

/** Gateway request/tool event shape used by the Agent passport. */
export interface OrganizationGatewayActivityEntry {
	actorId: string | null;
	agentId: string | null;
	apiKey: string | null;
	backend: string | null;
	command: string | null;
	costMicroUsd: number | null;
	durationMs: number | null;
	error: string | null;
	evalScore: number | null;
	eventType: string;
	feature: string | null;
	gatewayId: string;
	id: string;
	inputTokens: number;
	latencyMs: number;
	managedInference: boolean;
	model?: string | null;
	outputTokens: number;
	projectId: string | null;
	provider: string;
	providerCostMicroUsd: number | null;
	requestId: string;
	sessionId: string | null;
	teamId: string | null;
	timestamp: string;
	userName: string | null;
	widgetInstanceId?: string | null;
}

/** The orgs the caller belongs to. Empty when signed out. */
export async function listOrgs(): Promise<OrgListEntry[]> {
	if (!getOrgSessionToken()) {
		return [];
	}
	const response = await fetch(`${BASE}/api/control-plane/orgs`, {
		headers: authHeaders(),
	});
	if (!response.ok) {
		throw new Error(await readError(response));
	}
	const body = orgListResponseSchema.parse(await response.json());
	// Normalized rather than cast straight through: the desktop talks to whatever
	// control plane it is pointed at, and one older than the field is a plausible
	// pairing. `undefined` reaching `EntityAvatar` as `src` would be harmless, but
	// `isPersonal` deciding a branch on `undefined` is not — spell both out here
	// so the rest of the app sees the declared shape.
	return (body.organizations ?? []).map((org) => ({
		createdAt: org.createdAt ?? null,
		id: org.id ?? "",
		isPersonal: org.isPersonal ?? false,
		logo: org.logo ?? null,
		name: org.name ?? "",
		role: org.role ?? null,
		slug: org.slug ?? "",
	}));
}

/**
 * The org THIS session is scoped to, read back from Better Auth's session
 * payload rather than cached locally.
 *
 * Deliberately a server read: the same account may be signed in on the web and
 * in another desktop window, and a locally remembered id would keep showing the
 * org this window last picked while every API response came back scoped to a
 * different one — a switcher that lies is worse than no switcher.
 */
export async function getActiveOrgId(): Promise<string | null> {
	if (!getOrgSessionToken()) {
		return null;
	}
	const response = await fetch(`${BASE}/api/auth/get-session`, {
		headers: authHeaders(),
	});
	if (!response.ok) {
		return null;
	}
	const parsed = orgSessionOrganizationScopeSchema.safeParse(
		await response.json().catch(() => null)
	);
	const body = parsed.success ? parsed.data : null;
	return body?.session?.activeOrganizationId ?? null;
}

/** The Better Auth teams the current user belongs to in one organization. */
export async function listMyOrganizationTeams(
	organizationId: string
): Promise<OrgTeamEntry[]> {
	const response = await fetch(
		`${BASE}/api/auth/organization/list-user-teams?organizationId=${encodeURIComponent(organizationId)}`,
		{ headers: authHeaders() }
	);
	if (!response.ok) {
		throw new Error(await readError(response));
	}
	const parsed = orgTeamsResponseSchema.safeParse(await response.json());
	if (!parsed.success) {
		return [];
	}
	return parsed.data.flatMap((team) => {
		const projected = orgTeamProjectionSchema.safeParse(team);
		return projected.success ? [projected.data] : [];
	});
}

/** The Better Auth active team stored on this session, or null when unset. */
export async function getActiveTeamId(): Promise<string | null> {
	if (!getOrgSessionToken()) {
		return null;
	}
	const response = await fetch(`${BASE}/api/auth/get-session`, {
		headers: authHeaders(),
	});
	if (!response.ok) {
		return null;
	}
	const parsed = orgSessionTeamScopeSchema.safeParse(
		await response.json().catch(() => null)
	);
	const body = parsed.success ? parsed.data : null;
	return body?.session?.activeTeamId ?? null;
}

/**
 * The PREFIX under which {@link getActiveOrgId}'s answer is cached, one entry
 * per account (see {@link activeOrgQueryKey}). Exported so the switcher can
 * refetch every entry by prefix, and so nobody re-derives a second key for the
 * same fact.
 */
export const ACTIVE_ORG_KEY = ["settings", "orgs", "active"] as const;
export const ACTIVE_TEAM_KEY = ["settings", "orgs", "active-team"] as const;

/**
 * The cache key for ONE account's active org.
 *
 * Keyed by account because the answer belongs to that account's session: the
 * vault can switch accounts without a reload, and an unkeyed entry would pair
 * the new account with the org the previous account had active (and, through
 * the flag cache, with that org's role-targeted flags) until a refetch landed.
 * Signed out (`null`) is its own entry, which nothing can resolve to an org.
 */
export function activeOrgQueryKey(accountId: string | null) {
	return [...ACTIVE_ORG_KEY, accountId] as const;
}

/**
 * {@link getActiveOrgId} bound to one account: rejects when a different account
 * is active when the lookup starts or when it lands, so a lookup made with the
 * other account's token is never cached under this account's key. `lookup` is
 * injectable so callers that already hold a lookup share this guard.
 */
export async function getActiveOrgIdForAccount(
	accountId: string | null,
	lookup: () => Promise<string | null> = getActiveOrgId
): Promise<string | null> {
	const assertActive = () => {
		if (getActiveUserId() !== accountId) {
			throw new Error("The active account changed during the org lookup.");
		}
	};
	assertActive();
	const orgId = await lookup();
	assertActive();
	return orgId;
}

/**
 * Org switches made from THIS device, so a request whose answer depends on the
 * session's active org can tell that it may have been served for a different
 * org than the one it captured. `generation` changes when a switch starts and
 * when it settles; `switching` is true while one is in flight, the window in
 * which the server may already answer for the new org while the local cache
 * still names the old one.
 */
let orgSwitchGeneration = 0;
let orgSwitchesInFlight = 0;

export interface ActiveOrgSwitchState {
	generation: number;
	switching: boolean;
}

export function activeOrgSwitchState(): ActiveOrgSwitchState {
	return {
		generation: orgSwitchGeneration,
		switching: orgSwitchesInFlight > 0,
	};
}

/**
 * The org THIS session is scoped to, as a hook.
 *
 * Every org-scoped surface needs it for one of two reasons: to put it in a
 * TanStack query key (so the previous org's response is not served for a paint
 * after a switch), or — for the surfaces that are plain state + `useEffect`
 * rather than queries — as an effect DEPENDENCY, so the switch re-runs a load
 * whose request is byte-identical but whose answer is not. `/api/credits/*` and
 * friends carry no `?orgId=`; they resolve the org from the session row, so the
 * id is a re-run key here, never an argument.
 *
 * DELIBERATELY PINNED to the app-wide client (the second argument) instead of
 * whatever `QueryClientProvider` happens to be above the caller. The settings
 * dialog runs its own isolated `new QueryClient()` while the gateway dialog is
 * mounted outside that provider entirely, so reading the ambient client would
 * make a component's answer depend on which dialog it is rendered inside, and
 * would leave the two with independently stale copies of the single fact that
 * decides whose numbers every other surface is showing.
 *
 * `staleTime: 0` overrides the app-wide 5-minute default: the same account can
 * switch org from the web or a second window, and a cached id that is five
 * minutes behind the session row would scope the whole app to the wrong org.
 */
export function useActiveOrgId(): string | null {
	const accountId = getActiveUserId();
	const { data } = useQuery(
		{
			enabled: hasOrgAuth() && accountId !== null,
			queryFn: () => getActiveOrgIdForAccount(accountId),
			queryKey: activeOrgQueryKey(accountId),
			staleTime: 0,
		},
		appQueryClient
	);
	return data ?? null;
}

/** The current Better Auth active team, scoped to the current active org. */
export function useActiveTeamId(): string | null {
	const activeOrgId = useActiveOrgId();
	const { data } = useQuery(
		{
			enabled: hasOrgAuth() && Boolean(activeOrgId),
			queryFn: getActiveTeamId,
			queryKey: [...ACTIVE_TEAM_KEY, activeOrgId],
			staleTime: 0,
		},
		appQueryClient
	);
	return data ?? null;
}

/** Rescope this session to `organizationId`. */
export async function setActiveOrg(organizationId: string): Promise<void> {
	const accountId = getActiveUserId();
	orgSwitchGeneration += 1;
	orgSwitchesInFlight += 1;
	try {
		const response = await fetch(`${BASE}/api/auth/organization/set-active`, {
			body: JSON.stringify({ organizationId }),
			headers: authHeaders(),
			method: "POST",
		});
		if (!response.ok) {
			throw new Error(await readError(response));
		}
		// The session row now names this org, so the cached answer is known
		// without waiting for a refetch: closing that window means no reader sees
		// the old org while the server already answers for the new one.
		if (getActiveUserId() === accountId) {
			appQueryClient.setQueryData(activeOrgQueryKey(accountId), organizationId);
		}
	} finally {
		// Whatever the outcome, the server may now answer for the new org, so the
		// Core JWT (whose signed flag claims name the org they were evaluated
		// for) is re-minted on the next Core request instead of being reused.
		await clearCoreUserJwt();
		orgSwitchesInFlight -= 1;
		orgSwitchGeneration += 1;
	}
	await appQueryClient.invalidateQueries({ queryKey: ACTIVE_TEAM_KEY });
}

/**
 * Drop the cached Core user JWT. Imported lazily: many component tests replace
 * the JWT module with a stub that only provides `getRealtimeJwt`, and a static
 * named import would fail to link under those stubs.
 */
async function clearCoreUserJwt(): Promise<void> {
	try {
		const jwt = await import("@/src/lib/realtime/jwt.ts");
		jwt.clearRealtimeJwt?.();
	} catch {
		// The cached token still expires on its own; nothing else to do.
	}
}

/** Rescope this session to a Better Auth team in its active organization. */
export async function setActiveTeam(teamId: string | null): Promise<void> {
	const response = await fetch(
		`${BASE}/api/auth/organization/set-active-team`,
		{
			body: JSON.stringify({ teamId }),
			headers: authHeaders(),
			method: "POST",
		}
	);
	if (!response.ok) {
		throw new Error(await readError(response));
	}
	await appQueryClient.invalidateQueries({ queryKey: ACTIVE_TEAM_KEY });
}

/** What the caller can move, and the orgs they can move it between. */
export async function fetchTransferable(
	orgId?: string | null,
	sessionToken?: string | null
): Promise<TransferableView> {
	const query = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";
	const response = await fetch(`${BASE}/api/credits/transferable${query}`, {
		headers: authHeaders(sessionToken),
	});
	if (!response.ok) {
		throw new Error(await readError(response));
	}
	return transferableViewSchema.parse(await response.json());
}

/**
 * Fetch the org's gateway activity for one agent. Request/model/tool rows are
 * kept separate from control changes by the server, then joined in the Agent
 * passport with the control projection below.
 */
export async function fetchOrganizationAgentActivity(
	orgId: string,
	agentId: string,
	limit = 200
): Promise<{ count: number; entries: OrganizationGatewayActivityEntry[] }> {
	const params = new URLSearchParams({
		agentId,
		limit: String(Math.min(Math.max(limit, 1), 200)),
	});
	const response = await fetch(
		`${BASE}/api/aggregation/orgs/${encodeURIComponent(orgId)}/audit?${params.toString()}`,
		{ headers: authHeaders() }
	);
	if (!response.ok) {
		throw new Error(await readError(response));
	}
	return organizationActivityResponseSchema.parse(await response.json());
}

/** Fetch organization and gateway control mutations scoped to one agent. */
export async function fetchOrganizationAgentControls(
	orgId: string,
	agentId: string,
	limit = 200
): Promise<{ count: number; entries: OrganizationAuditEntry[] }> {
	const params = new URLSearchParams({
		agentId,
		limit: String(Math.min(Math.max(limit, 1), 200)),
	});
	const response = await fetch(
		`${BASE}/api/control-plane/orgs/${encodeURIComponent(orgId)}/audit?${params.toString()}`,
		{ headers: authHeaders() }
	);
	if (!response.ok) {
		throw new Error(await readError(response));
	}
	return organizationControlsResponseSchema.parse(await response.json());
}

export interface TransferResult {
	movedGrantIds: string[];
	movedGrantMicroUsd: number;
	movedTopupMicroUsd: number;
	ok: boolean;
	reason: string | null;
}

/**
 * Move grants and/or top-up balance between two orgs the caller belongs to.
 *
 * `idempotencyKey` belongs to one intended transfer, not one HTTP attempt: the
 * caller reuses it when retrying after a failed or lost response, so a transfer
 * the server already committed is not applied a second time. The server binds
 * the key to the source, destination and amount, so reusing it for an edited
 * transfer cannot replay or redirect the earlier one.
 */
export async function transferCredits(
	input: {
		fromOrgId: string;
		grantIds?: string[];
		toOrgId: string;
		topupMicroUsd?: number;
	},
	idempotencyKey: string,
	sessionToken?: string | null
): Promise<TransferResult> {
	const headers = authHeaders(sessionToken);
	headers.set("Idempotency-Key", idempotencyKey);
	const response = await fetch(`${BASE}/api/credits/transfer`, {
		body: JSON.stringify(input),
		headers,
		method: "POST",
	});
	if (!response.ok) {
		throw new Error(await readError(response));
	}
	return transferResultSchema.parse(await response.json());
}
