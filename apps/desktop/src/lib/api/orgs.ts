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
import { BACKEND_URL, TOKEN_KEY } from "@/lib/auth-client.ts";
import { queryClient as appQueryClient } from "@/src/lib/query-client.ts";

function authToken(): string | null {
	try {
		return localStorage.getItem(TOKEN_KEY);
	} catch {
		// No storage — treated as signed out.
		return null;
	}
}

/** True when there is a session token at all; every route here requires one. */
export function hasOrgAuth(): boolean {
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

const BASE = BACKEND_URL.replace(/\/$/, "");

async function readError(response: Response): Promise<string> {
	const body = (await response.json().catch(() => null)) as {
		error?: string;
		message?: string;
	} | null;
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
	details: Record<string, unknown>;
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
	model: string;
	outputTokens: number;
	projectId: string | null;
	provider: string;
	providerCostMicroUsd: number | null;
	requestId: string;
	sessionId: string | null;
	teamId: string | null;
	timestamp: string;
	userName: string | null;
}

/** The orgs the caller belongs to. Empty when signed out. */
export async function listOrgs(): Promise<OrgListEntry[]> {
	if (!authToken()) {
		return [];
	}
	const response = await fetch(`${BASE}/api/control-plane/orgs`, {
		headers: authHeaders(),
	});
	if (!response.ok) {
		throw new Error(await readError(response));
	}
	const body = (await response.json()) as {
		organizations?: Partial<OrgListEntry>[];
	};
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
	if (!authToken()) {
		return null;
	}
	const response = await fetch(`${BASE}/api/auth/get-session`, {
		headers: authHeaders(),
	});
	if (!response.ok) {
		return null;
	}
	const body = (await response.json().catch(() => null)) as {
		session?: { activeOrganizationId?: string | null };
	} | null;
	return body?.session?.activeOrganizationId ?? null;
}

/**
 * Where {@link getActiveOrgId}'s answer is cached. Exported so the switcher can
 * name it, and so nobody re-derives a second key for the same fact.
 */
export const ACTIVE_ORG_KEY = ["settings", "orgs", "active"] as const;

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
	const { data } = useQuery(
		{
			enabled: hasOrgAuth(),
			queryFn: getActiveOrgId,
			queryKey: ACTIVE_ORG_KEY,
			staleTime: 0,
		},
		appQueryClient
	);
	return data ?? null;
}

/** Rescope this session to `organizationId`. */
export async function setActiveOrg(organizationId: string): Promise<void> {
	const response = await fetch(`${BASE}/api/auth/organization/set-active`, {
		body: JSON.stringify({ organizationId }),
		headers: authHeaders(),
		method: "POST",
	});
	if (!response.ok) {
		throw new Error(await readError(response));
	}
}

/** What the caller can move, and the orgs they can move it between. */
export async function fetchTransferable(
	orgId?: string | null
): Promise<TransferableView> {
	const query = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";
	const response = await fetch(`${BASE}/api/credits/transferable${query}`, {
		headers: authHeaders(),
	});
	if (!response.ok) {
		throw new Error(await readError(response));
	}
	return (await response.json()) as TransferableView;
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
	return (await response.json()) as {
		count: number;
		entries: OrganizationGatewayActivityEntry[];
	};
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
	return (await response.json()) as {
		count: number;
		entries: OrganizationAuditEntry[];
	};
}

export interface TransferResult {
	movedGrantIds: string[];
	movedGrantMicroUsd: number;
	movedTopupMicroUsd: number;
	ok: boolean;
	reason: string | null;
}

/** Move grants and/or top-up balance between two orgs the caller belongs to. */
export async function transferCredits(input: {
	fromOrgId: string;
	grantIds?: string[];
	toOrgId: string;
	topupMicroUsd?: number;
}): Promise<TransferResult> {
	const response = await fetch(`${BASE}/api/credits/transfer`, {
		body: JSON.stringify(input),
		headers: {
			...authHeaders(),
			"Idempotency-Key": crypto.randomUUID(),
		},
		method: "POST",
	});
	if (!response.ok) {
		throw new Error(await readError(response));
	}
	return (await response.json()) as TransferResult;
}
