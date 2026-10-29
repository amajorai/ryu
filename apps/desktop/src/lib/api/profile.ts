import { marketplaceWallpaperSelectionSchema } from "@ryuhq/protocol/marketplace-wallpaper";
import { z } from "zod";
// Desktop client for the profile/stats control plane (packages/api routers/
// profile.ts, mounted at /api/profile/me/*). Talks to the control-plane server
// (BACKEND_URL, :3000) with the stored Better Auth bearer token — the same auth
// the waitlist + user-stories clients use. Powers the Stats settings tab: the
// contributions heatmap, the stat cards, and the unlockable-features grid. The
// public "Ryu Wrapped" share card lives on the web app (FRONTEND_URL/wrapped/:userId).

import type { MarketplaceWallpaperSelection } from "@ryuhq/protocol/marketplace-wallpaper";
import {
	BACKEND_URL,
	FRONTEND_URL,
	getActiveToken,
} from "@/lib/auth-client.ts";

export interface ProfileTotals {
	agentSeconds: number;
	costMicroUsd: number;
	inputTokens: number;
	outputTokens: number;
	requestCount: number;
	sessionCount: number;
}

export interface ProfileMe {
	bannerWallpaper?: MarketplaceWallpaperSelection | null;
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
	/** Streak-active day (newer servers only). */
	active?: boolean;
	byFeature: UsageDayFeatures;
	count: number;
	day: string;
	tokens: number;
}

export interface UsageDailyResponse {
	/** Every streak-active day in range, including days with no usage row
	 * (newer servers only). */
	activeDays?: string[];
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

function authHeaders(capturedToken?: string | null) {
	const token = capturedToken === undefined ? getActiveToken() : capturedToken;
	if (!token) {
		throw new Error("Sign in to view your stats.");
	}
	return { Authorization: `Bearer ${token}` } satisfies NonNullable<
		RequestInit["headers"]
	>;
}

// Cap every control-plane read so a stalled backend surfaces as an error the UI
// can retry, rather than a request (and its spinner) that hangs forever.
const REQUEST_TIMEOUT_MS = 15_000;

async function getJson<T>(
	path: string,
	schema: z.ZodType<T>,
	capturedToken?: string | null
): Promise<T> {
	const resp = await fetch(`${BACKEND_URL}${path}`, {
		headers: authHeaders(capturedToken),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!resp.ok) {
		throw new Error(`Request failed (${resp.status})`);
	}
	return schema.parse(await resp.json());
}

const profileTotalsSchema = z.object({
	agentSeconds: z.number(),
	costMicroUsd: z.number(),
	inputTokens: z.number(),
	outputTokens: z.number(),
	requestCount: z.number(),
	sessionCount: z.number(),
});
const streakSchema = z.object({ current: z.number(), longest: z.number() });
const profileMeSchema = z.object({
	bannerWallpaper: marketplaceWallpaperSelectionSchema.nullish(),
	displayUsername: z.string().nullish(),
	image: z.string().nullable(),
	joinedAt: z.string(),
	level: z.number(),
	name: z
		.string()
		.nullable()
		.transform((value) => value ?? ""),
	plan: z.string(),
	pointsBalance: z.number(),
	profileVisibility: z.enum(["public", "private"]),
	streak: streakSchema,
	totals: profileTotalsSchema,
	userId: z.string(),
	username: z.string().nullish(),
	xp: z.number(),
});
const usageDaySchema = z.object({
	active: z.boolean().optional(),
	byFeature: z.object({
		agent: z.number().optional(),
		chat: z.number().optional(),
		island: z.number().optional(),
		predict: z.object({ accepted: z.number(), shown: z.number() }).optional(),
	}),
	count: z.number(),
	day: z.string(),
	tokens: z.number(),
});
const usageDailyResponseSchema = z.object({
	activeDays: z.array(z.string()).optional(),
	days: z.array(usageDaySchema),
});
const countedIdSchema = z.object({ count: z.number(), id: z.string() });
const profileStatsSchema = z.object({
	byFeatureTotals: z.object({
		agentSeconds: z.number(),
		chat: z.number(),
		island: z.number(),
		predictAccepted: z.number(),
	}),
	insights: z.object({
		activeDays: z.number(),
		averageRequestsPerActiveDay: z.number(),
		averageTokensPerActiveDay: z.number(),
		favoriteModel: z.string().nullable(),
		peakDay: z.object({ day: z.string(), tokens: z.number() }).nullable(),
		peakHourUtc: z.string().nullable(),
		topModels: z.array(countedIdSchema),
		topPlugins: z.array(countedIdSchema),
		topSkills: z.array(countedIdSchema),
		transport: z.object({
			acp: z.number(),
			gateway: z.number(),
			openAiCompat: z.number(),
			other: z.number(),
		}),
	}),
	totals: profileTotalsSchema,
});
const profileUnlocksSchema = z.object({
	catalog: z.array(
		z.object({
			autoUnlockAtLevel: z.number().optional(),
			description: z.string(),
			icon: z.string().optional(),
			key: z.string(),
			pointsCost: z.number().optional(),
			requiresPlan: z.array(z.string()).optional(),
			tier: z.enum(["default", "progressive", "paid"]),
			title: z.string(),
		})
	),
	unlocked: z.array(z.string()),
});
const unlockResultSchema = z.object({
	ok: z.boolean(),
	pointsBalance: z.number(),
	unlocked: z.array(z.string()),
});
const agentProfileSchema = z.object({
	agentId: z.string(),
	hiredAt: z.string(),
	lastActiveDay: z.string(),
	level: z.number(),
	streak: streakSchema,
	totals: profileTotalsSchema,
	xp: z.number(),
});
const agentUsageDailyResponseSchema = z.object({
	days: z.array(
		z.object({ count: z.number(), day: z.string(), tokens: z.number() })
	),
});

/** The signed-in user's profile summary (level, streak, lifetime totals). */
export const fetchProfileMe = (): Promise<ProfileMe> =>
	getJson("/api/profile/me/profile", profileMeSchema);

/** Keep a pending banner operation bound to its initiating account. */
export const fetchProfileMeWithToken = (
	capturedToken: string | null
): Promise<ProfileMe> =>
	getJson("/api/profile/me/profile", profileMeSchema, capturedToken);

export async function updateProfileBannerWallpaper(
	bannerWallpaper: MarketplaceWallpaperSelection | null,
	capturedToken?: string | null
): Promise<{
	ok: boolean;
	bannerWallpaper: MarketplaceWallpaperSelection | null;
}> {
	const resp = await fetch(`${BACKEND_URL}/api/profile/me/banner-wallpaper`, {
		method: "PATCH",
		headers: {
			...authHeaders(capturedToken),
			"Content-Type": "application/json",
		},
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		body: JSON.stringify({ bannerWallpaper }),
	});
	if (!resp.ok) {
		throw new Error(`Request failed (${resp.status})`);
	}
	return z
		.object({
			ok: z.boolean(),
			bannerWallpaper: marketplaceWallpaperSelectionSchema.nullable(),
		})
		.parse(await resp.json());
}

/** Per-day usage between two YYYY-MM-DD dates, for the contributions heatmap. */
export function fetchUsageDaily(
	from: string,
	to: string
): Promise<UsageDailyResponse> {
	const params = new URLSearchParams({ from, to });
	return getJson<UsageDailyResponse>(
		`/api/profile/me/usage/daily?${params.toString()}`,
		usageDailyResponseSchema
	);
}

/** Lifetime totals broken down by feature. */
export const fetchProfileStats = (): Promise<ProfileStats> =>
	getJson("/api/profile/me/stats", profileStatsSchema);

/** The unlockable-feature catalog plus which keys the caller has unlocked. */
export const fetchProfileUnlocks = (): Promise<ProfileUnlocks> =>
	getJson("/api/profile/me/unlocks", profileUnlocksSchema);

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
		const body = z
			.object({ message: z.string().optional().catch(undefined) })
			.catch({})
			.parse(await resp.json().catch(() => ({})));
		throw new Error(body.message ?? `Failed to unlock (${resp.status})`);
	}
	return unlockResultSchema.parse(await resp.json());
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
	getJson(
		"/api/profile/me/agents",
		z.object({ agents: z.array(agentProfileSchema) })
	);

/** Usage stats for a single agent (zeros if it has no usage yet). */
export const fetchAgentProfile = (agentId: string): Promise<AgentProfile> =>
	getJson<AgentProfile>(
		`/api/profile/me/agents/${encodeURIComponent(agentId)}`,
		agentProfileSchema
	);

/** Per-day usage for one agent between two YYYY-MM-DD dates, for its heatmap. */
export function fetchAgentUsageDaily(
	agentId: string,
	from: string,
	to: string
): Promise<AgentUsageDailyResponse> {
	const params = new URLSearchParams({ from, to });
	return getJson<AgentUsageDailyResponse>(
		`/api/profile/me/agents/${encodeURIComponent(agentId)}/usage/daily?${params.toString()}`,
		agentUsageDailyResponseSchema
	);
}
