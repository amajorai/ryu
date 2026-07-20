// Desktop client for the profile/stats control plane (packages/api routers/
// profile.ts, mounted at /api/profile/me/*). Talks to the control-plane server
// (BACKEND_URL, :3000) with the stored Better Auth bearer token — the same auth
// the waitlist + user-stories clients use. Powers the Stats settings tab: the
// contributions heatmap, the stat cards, and the unlockable-features grid. The
// public "Ryu Wrapped" share card lives on the web app (FRONTEND_URL/wrapped/:userId).

import { BACKEND_URL, FRONTEND_URL, TOKEN_KEY } from "@/lib/auth-client.ts";

export interface ProfileTotals {
	agentSeconds: number;
	costMicroUsd: number;
	inputTokens: number;
	outputTokens: number;
	requestCount: number;
	sessionCount: number;
}

export interface ProfileMe {
	displayUsername?: string | null;
	image: string | null;
	joinedAt: string;
	level: number;
	name: string;
	plan: string;
	pointsBalance: number;
	profileVisibility: "public" | "private";
	streak: { current: number; longest: number };
	totals: ProfileTotals;
	userId: string;
	username?: string | null;
	xp: number;
}

export interface UsageDayFeatures {
	agent?: number;
	chat?: number;
	island?: number;
	predict?: { accepted: number; shown: number };
}

export interface UsageDay {
	byFeature: UsageDayFeatures;
	count: number;
	day: string;
	tokens: number;
}

export interface UsageDailyResponse {
	days: UsageDay[];
}

export interface ProfileStats {
	byFeatureTotals: {
		agentSeconds: number;
		chat: number;
		island: number;
		predictAccepted: number;
	};
	insights: {
		activeDays: number;
		averageRequestsPerActiveDay: number;
		averageTokensPerActiveDay: number;
		favoriteModel: string | null;
		peakDay: { day: string; tokens: number } | null;
		peakHourUtc: string | null;
		topModels: Array<{ count: number; id: string }>;
		topPlugins: Array<{ count: number; id: string }>;
		topSkills: Array<{ count: number; id: string }>;
		transport: {
			acp: number;
			gateway: number;
			openAiCompat: number;
			other: number;
		};
	};
	totals: ProfileTotals;
}

export type UnlockTier = "default" | "progressive" | "paid";

export interface UnlockCatalogEntry {
	autoUnlockAtLevel?: number;
	description: string;
	icon?: string;
	key: string;
	pointsCost?: number;
	requiresPlan?: string[];
	tier: UnlockTier;
	title: string;
}

export interface ProfileUnlocks {
	catalog: UnlockCatalogEntry[];
	unlocked: string[];
}

export interface UnlockResult {
	ok: boolean;
	pointsBalance: number;
	unlocked: string[];
}

function authHeaders(): Record<string, string> {
	const token = localStorage.getItem(TOKEN_KEY);
	if (!token) {
		throw new Error("Sign in to view your stats.");
	}
	return { Authorization: `Bearer ${token}` };
}

// Cap every control-plane read so a stalled backend surfaces as an error the UI
// can retry, rather than a request (and its spinner) that hangs forever.
const REQUEST_TIMEOUT_MS = 15_000;

async function getJson<T>(path: string): Promise<T> {
	const resp = await fetch(`${BACKEND_URL}${path}`, {
		headers: authHeaders(),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!resp.ok) {
		throw new Error(`Request failed (${resp.status})`);
	}
	return (await resp.json()) as T;
}

/** The signed-in user's profile summary (level, streak, lifetime totals). */
export const fetchProfileMe = (): Promise<ProfileMe> =>
	getJson<ProfileMe>("/api/profile/me/profile");

/** Per-day usage between two YYYY-MM-DD dates, for the contributions heatmap. */
export function fetchUsageDaily(
	from: string,
	to: string
): Promise<UsageDailyResponse> {
	const params = new URLSearchParams({ from, to });
	return getJson<UsageDailyResponse>(
		`/api/profile/me/usage/daily?${params.toString()}`
	);
}

/** Lifetime totals broken down by feature. */
export const fetchProfileStats = (): Promise<ProfileStats> =>
	getJson<ProfileStats>("/api/profile/me/stats");

/** The unlockable-feature catalog plus which keys the caller has unlocked. */
export const fetchProfileUnlocks = (): Promise<ProfileUnlocks> =>
	getJson<ProfileUnlocks>("/api/profile/me/unlocks");

/** Spend points to unlock a feature. Throws with the server message on 4xx. */
export async function unlockFeature(key: string): Promise<UnlockResult> {
	const resp = await fetch(
		`${BACKEND_URL}/api/profile/me/unlocks/${encodeURIComponent(key)}`,
		{
			method: "POST",
			headers: authHeaders(),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		}
	);
	if (!resp.ok) {
		const body = (await resp.json().catch(() => ({}))) as { message?: string };
		throw new Error(body.message ?? `Failed to unlock (${resp.status})`);
	}
	return (await resp.json()) as UnlockResult;
}

/** The public "Ryu Wrapped" share card for a user, served by the web app. */
export const wrappedUrl = (userId: string): string =>
	`${FRONTEND_URL}/wrapped/${userId}`;

// ---------------------------------------------------------------------------
// Agents-as-employees (the "Your Team" roster)
//
// The control plane tracks per-agent usage under /api/profile/me/agents/*. The
// agent's identity (name, description) comes from Core's /api/agents; here we
// only pull the STATS that power each employee's ID badge and profile page.
// ---------------------------------------------------------------------------

/** Per-agent usage stats for one of the signed-in user's "employee" agents. */
export interface AgentProfile {
	agentId: string;
	hiredAt: string;
	lastActiveDay: string;
	level: number;
	streak: { current: number; longest: number };
	totals: ProfileTotals;
	xp: number;
}

export interface TeamAgentsResponse {
	agents: AgentProfile[];
}

/** One day of an agent's usage, for its contributions heatmap. */
export interface AgentUsageDay {
	count: number;
	day: string;
	tokens: number;
}

export interface AgentUsageDailyResponse {
	days: AgentUsageDay[];
}

/** Usage stats for every agent the signed-in user has employed. */
export const fetchTeamAgents = (): Promise<TeamAgentsResponse> =>
	getJson<TeamAgentsResponse>("/api/profile/me/agents");

/** Usage stats for a single agent (zeros if it has no usage yet). */
export const fetchAgentProfile = (agentId: string): Promise<AgentProfile> =>
	getJson<AgentProfile>(
		`/api/profile/me/agents/${encodeURIComponent(agentId)}`
	);

/** Per-day usage for one agent between two YYYY-MM-DD dates, for its heatmap. */
export function fetchAgentUsageDaily(
	agentId: string,
	from: string,
	to: string
): Promise<AgentUsageDailyResponse> {
	const params = new URLSearchParams({ from, to });
	return getJson<AgentUsageDailyResponse>(
		`/api/profile/me/agents/${encodeURIComponent(agentId)}/usage/daily?${params.toString()}`
	);
}
