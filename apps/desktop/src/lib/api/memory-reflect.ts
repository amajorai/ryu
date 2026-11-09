// apps/desktop/src/lib/api/memory-reflect.ts
//
// Typed client for Reflect, the Memory app's usage dashboard
// (`/api/memory/reflect`), with a fallback to the opt-in usage review on nodes
// without the dedicated route. Wire shapes are snake_case; this module maps
// them to camelCase.

import { z } from "zod";
import { ApiError, type ApiTarget, request } from "./client.ts";

const activityResponseSchema = z.looseObject({
	count: z.number().optional(),
	label: z.string().optional(),
	trend: z.union([z.null(), z.number()]).optional(),
});
const insightsResponseSchema = z.looseObject({
	body: z.string().optional(),
	id: z.string(),
	title: z.string().optional(),
	tone: z.string().optional(),
});
const topicsResponseSchema = z.looseObject({
	count: z.number().optional(),
	name: z.string(),
	summary: z.union([z.null(), z.string()]).optional(),
});
const getReflectDashboardResponseSchema = z.looseObject({
	activity: z.array(activityResponseSchema).optional(),
	generated_at: z.number().optional(),
	insights: z.array(insightsResponseSchema).optional(),
	period: z.string().optional(),
	topics: z.array(topicsResponseSchema).optional(),
});
const aiFluencyObservationsResponseSchema = z.looseObject({
	detail: z.string().optional(),
	evidence_count: z.number().optional(),
	id: z.string(),
	title: z.string().optional(),
});
const metricsResponseSchema = z.looseObject({
	active_days: z.number().optional(),
	activity_count: z.number().optional(),
	conversation_count: z.number().optional(),
	message_count: z.number().optional(),
});
const periodResponseSchema = z.looseObject({
	from: z.number().optional(),
	to: z.number().optional(),
});
const topicsResponseSchema2 = z.looseObject({
	conversation_count: z.number().optional(),
	label: z.string(),
	message_count: z.number().optional(),
});
const usageResponseSchema = z.looseObject({
	ai_fluency_observations: z
		.array(aiFluencyObservationsResponseSchema)
		.optional(),
	metrics: metricsResponseSchema.optional(),
	period: periodResponseSchema.optional(),
	topics: z.array(topicsResponseSchema2).optional(),
});
const settingsResponseSchema2 = z.looseObject({
	break_nudges: z.boolean().optional(),
	quiet_hours_enabled: z.boolean().optional(),
	quiet_hours_end: z.number().optional(),
	quiet_hours_start: z.number().optional(),
});
const jsonResponseSchema13 = z.looseObject({
	settings: settingsResponseSchema2.optional(),
});
const jsonResponseSchema14 = z.looseObject({
	settings: settingsResponseSchema2.optional(),
});
const usageReviewSettingsResponseSchema = z.looseObject({
	enabled: z.boolean().optional(),
});

/** The refusal Core returns while the opt-in usage review is turned off. */
const USAGE_REVIEW_DISABLED = "usage_review_disabled";
/** Core's default for the Reflect break-nudge preference (off). */
const DEFAULT_BREAK_NUDGES = false;

/** A time window shown by Reflect. */
export type ReflectPeriod = "7d" | "30d" | "90d";

export const REFLECT_PERIODS: ReflectPeriod[] = ["7d", "30d", "90d"];

export interface ReflectActivity {
	count: number;
	label: string;
	trend: number | null;
}

export interface ReflectTopic {
	count: number;
	name: string;
	summary: string | null;
}

export interface ReflectInsight {
	body: string;
	id: string;
	title: string;
	tone: "positive" | "neutral" | "notice";
}

export interface ReflectDashboard {
	activity: ReflectActivity[];
	generatedAt: number;
	insights: ReflectInsight[];
	period: ReflectPeriod;
	topics: ReflectTopic[];
}

export interface ReflectSettings {
	breakNudges: boolean;
	quietHoursEnabled: boolean;
	quietHoursEnd: number;
	quietHoursStart: number;
}

interface ReflectDashboardWire {
	activity?: Array<{
		count?: number;
		label?: string;
		trend?: number | null;
	}>;
	generated_at?: number;
	insights?: Array<{
		body?: string;
		id: string;
		title?: string;
		tone?: string;
	}>;
	period?: string;
	topics?: Array<{
		count?: number;
		name: string;
		summary?: string | null;
	}>;
}

interface ReflectSettingsWire {
	break_nudges?: boolean;
	quiet_hours_enabled?: boolean;
	quiet_hours_end?: number;
	quiet_hours_start?: number;
}

function toPeriod(value: string | undefined): ReflectPeriod {
	return REFLECT_PERIODS.find((period) => period === value) ?? "7d";
}

function toTone(value: string | undefined): ReflectInsight["tone"] {
	return value === "positive" || value === "notice" ? value : "neutral";
}

// ── Reflect dashboard ─────────────────────────────────────────────────────────

export async function getReflectDashboard(
	target: ApiTarget,
	period: ReflectPeriod
): Promise<ReflectDashboard> {
	let json: ReflectDashboardWire;
	try {
		json = await request(
			target,
			`/api/memory/reflect?period=${encodeURIComponent(period)}`,
			undefined,
			getReflectDashboardResponseSchema
		);
	} catch (error) {
		// Reflect's richer route is additive. Older nodes already expose the
		// privacy-gated usage review, so use it as the activity/topic source until
		// the dedicated Reflect projection is available.
		if (
			!(error instanceof ApiError && [404, 405, 501].includes(error.status))
		) {
			throw error;
		}
		const days = period === "90d" ? 90 : period === "30d" ? 30 : 7;
		const to = Date.now();
		const usage = await request(
			target,
			`/api/usage-review?from=${to - days * 24 * 60 * 60 * 1000}&to=${to}`,
			undefined,
			usageResponseSchema
		);
		const metrics = usage.metrics ?? {};
		json = {
			activity: [
				{
					count: metrics.conversation_count ?? 0,
					label: "Conversations",
					trend: null,
				},
				{ count: metrics.message_count ?? 0, label: "Messages", trend: null },
				{ count: metrics.active_days ?? 0, label: "Active days", trend: null },
			],
			generated_at: usage.period?.to ?? to,
			insights: (usage.ai_fluency_observations ?? []).map((item) => ({
				body: item.detail,
				id: item.id,
				title: item.title,
				tone: "neutral",
			})),
			period,
			topics: (usage.topics ?? []).map((item) => ({
				count: item.conversation_count ?? item.message_count ?? 0,
				name: item.label,
				summary: item.message_count ? `${item.message_count} messages` : null,
			})),
		};
	}
	return {
		activity: (json.activity ?? []).map((item) => ({
			count: item.count ?? 0,
			label: item.label ?? "Activity",
			trend: item.trend ?? null,
		})),
		generatedAt: json.generated_at ?? 0,
		insights: (json.insights ?? []).map((item) => ({
			body: item.body ?? "",
			id: item.id,
			title: item.title ?? "Insight",
			tone: toTone(item.tone),
		})),
		period: toPeriod(json.period ?? period),
		topics: (json.topics ?? []).map((item) => ({
			count: item.count ?? 0,
			name: item.name,
			summary: item.summary ?? null,
		})),
	};
}

/**
 * Whether `error` is Core's `403 usage_review_disabled` refusal. Reflect is a
 * projection of the opt-in usage review, so a node that has not turned usage
 * review on refuses the dashboard with this code rather than failing.
 */
export function isUsageReviewDisabled(error: unknown): boolean {
	return (
		error instanceof ApiError &&
		error.status === 403 &&
		(error.code === USAGE_REVIEW_DISABLED ||
			error.serverMessage === USAGE_REVIEW_DISABLED)
	);
}

/**
 * Turn on the node's opt-in usage review (`PUT /api/usage-review/settings`).
 * Only `enabled` is sent, so existing exclusions are kept. Resolves to the
 * node's persisted `enabled` value.
 */
export async function enableUsageReview(target: ApiTarget): Promise<boolean> {
	const json = await request(
		target,
		"/api/usage-review/settings",
		{ method: "PUT", body: { enabled: true } },
		usageReviewSettingsResponseSchema
	);
	return json.enabled ?? false;
}

export async function getReflectSettings(
	target: ApiTarget
): Promise<ReflectSettings> {
	const json = await request(
		target,
		"/api/memory/reflect/settings",
		undefined,
		jsonResponseSchema13
	);
	const settings = json.settings ?? {};
	return {
		breakNudges: settings.break_nudges ?? DEFAULT_BREAK_NUDGES,
		quietHoursEnabled: settings.quiet_hours_enabled ?? true,
		quietHoursEnd: settings.quiet_hours_end ?? 8,
		quietHoursStart: settings.quiet_hours_start ?? 22,
	};
}

export async function updateReflectSettings(
	target: ApiTarget,
	settings: Partial<ReflectSettings>
): Promise<ReflectSettings> {
	const body: ReflectSettingsWire = {};
	if (settings.breakNudges !== undefined) {
		body.break_nudges = settings.breakNudges;
	}
	if (settings.quietHoursEnabled !== undefined) {
		body.quiet_hours_enabled = settings.quietHoursEnabled;
	}
	if (settings.quietHoursStart !== undefined) {
		body.quiet_hours_start = settings.quietHoursStart;
	}
	if (settings.quietHoursEnd !== undefined) {
		body.quiet_hours_end = settings.quietHoursEnd;
	}
	const json = await request(
		target,
		"/api/memory/reflect/settings",
		{ method: "PATCH", body },
		jsonResponseSchema14
	);
	const next = json.settings ?? {};
	return {
		breakNudges:
			next.break_nudges ?? settings.breakNudges ?? DEFAULT_BREAK_NUDGES,
		quietHoursEnabled:
			next.quiet_hours_enabled ?? settings.quietHoursEnabled ?? true,
		quietHoursEnd: next.quiet_hours_end ?? settings.quietHoursEnd ?? 8,
		quietHoursStart: next.quiet_hours_start ?? settings.quietHoursStart ?? 22,
	};
}
