import { z } from "zod";
import {
	DEFAULT_STATS_PREFERENCES,
	type deriveSessionStats,
	formatStatsCount,
	formatStatsDuration,
	type StatsPreferences,
	type StatsUsageMetric,
	statsPreferenceFields,
} from "./stats-model.ts";

export const STORAGE_KEY = "ryu:stats-plugin-preferences";
const authoredStoredPreferences = z.object(statsPreferenceFields).partial();
// Every current authored field is checked; unobserved future JSON fields remain
// on the original decoded object and retain native object-spread persistence.
const storedPreferencesSchema = z.custom<Partial<StatsPreferences>>(
	(value) => authoredStoredPreferences.safeParse(value).success
);

export function readPreferences(): StatsPreferences {
	if (globalThis.window === undefined) {
		return DEFAULT_STATS_PREFERENCES;
	}
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (!raw) {
			return DEFAULT_STATS_PREFERENCES;
		}
		const parsed = storedPreferencesSchema.parse(JSON.parse(raw));
		return { ...DEFAULT_STATS_PREFERENCES, ...parsed };
	} catch {
		return DEFAULT_STATS_PREFERENCES;
	}
}

export function formatSpeed(value: number | undefined): string | null {
	if (value === undefined || !Number.isFinite(value) || value <= 0) {
		return null;
	}
	return `${value.toFixed(value >= 100 ? 0 : 1)} tok/s`;
}

export function formatPercent(value: number | undefined): string | null {
	if (value === undefined || !Number.isFinite(value)) {
		return null;
	}
	return `${Math.round(value * 100)}%`;
}

export function formatPercentagePoints(
	value: number | undefined
): string | null {
	if (value === undefined || !Number.isFinite(value)) {
		return null;
	}
	return `${value < 1 ? value.toFixed(1) : Math.round(value)}%`;
}

export function formatCost(
	amount: number | undefined,
	currency: string | undefined
): string | null {
	if (amount === undefined || !Number.isFinite(amount)) {
		return null;
	}
	try {
		return new Intl.NumberFormat(undefined, {
			currency: currency ?? "USD",
			maximumFractionDigits: 4,
			minimumFractionDigits: 2,
			style: "currency",
		}).format(amount);
	} catch {
		return `${amount.toFixed(2)} ${currency ?? "USD"}`;
	}
}

function formatResetRemaining(
	resetAt: string | null,
	now: number
): string | null {
	if (!resetAt) {
		return null;
	}
	const resetMs = Date.parse(resetAt);
	if (Number.isNaN(resetMs)) {
		return null;
	}
	const seconds = Math.max(0, Math.ceil((resetMs - now) / 1000));
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m`;
	}
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function usagePercent(
	percent: number | undefined,
	mode: StatsPreferences["usagePercentMode"]
): string | null {
	if (percent === undefined || !Number.isFinite(percent)) {
		return null;
	}
	const value = mode === "remaining" ? 100 - percent : percent;
	return `${Math.round(Math.max(0, Math.min(100, value)))}%`;
}

export function usageTimeCursor(
	metric: StatsUsageMetric,
	now: number
): number | undefined {
	if (!(metric.resetAt && metric.windowSeconds) || metric.windowSeconds <= 0) {
		return undefined;
	}
	const resetMs = Date.parse(metric.resetAt);
	if (Number.isNaN(resetMs)) {
		return undefined;
	}
	const startMs = resetMs - metric.windowSeconds * 1000;
	return Math.max(
		0,
		Math.min(100, ((now - startMs) / (resetMs - startMs)) * 100)
	);
}

export function formatUsageReset(
	metric: StatsUsageMetric | null | undefined,
	now: number,
	preferences: StatsPreferences
): string | null {
	if (!metric?.resetAt) {
		return null;
	}
	if (preferences.resetTimerMode === "progress") {
		const cursor = usageTimeCursor(metric, now);
		return cursor === undefined
			? formatResetRemaining(metric.resetAt, now)
			: `${Math.round(cursor)}% elapsed`;
	}
	if (preferences.resetTimerMode === "exact") {
		const resetMs = Date.parse(metric.resetAt);
		if (Number.isNaN(resetMs)) {
			return null;
		}
		const locale =
			preferences.resetTimerLocale === "system" ||
			preferences.resetTimerLocale.trim() === ""
				? undefined
				: preferences.resetTimerLocale.trim();
		try {
			return new Intl.DateTimeFormat(locale, {
				dateStyle: "short",
				timeStyle: "short",
				timeZone: preferences.resetTimerTimezone === "utc" ? "UTC" : undefined,
			}).format(resetMs);
		} catch {
			return new Date(resetMs).toLocaleString();
		}
	}
	return formatResetRemaining(metric.resetAt, now);
}

export function compactionValue(
	stats: ReturnType<typeof deriveSessionStats>,
	preferences: StatsPreferences
): string | null {
	const compactions = stats.compactions;
	const selected =
		preferences.compactionValue === "total"
			? compactions.count
			: preferences.compactionValue === "auto"
				? compactions.auto
				: preferences.compactionValue === "manual"
					? compactions.manual
					: preferences.compactionValue === "unknown"
						? compactions.unknown
						: compactions.reclaimedTokens;
	if (preferences.hideEmpty && selected === 0) {
		return null;
	}
	if (preferences.compactionValue === "reclaimed") {
		return `${formatStatsCount(selected) ?? "0"} tokens`;
	}
	if (
		preferences.compactionValue === "total" &&
		(preferences.compactionShowTriggers || preferences.compactionShowReclaimed)
	) {
		const details: string[] = [];
		if (preferences.compactionShowTriggers) {
			details.push(
				`${compactions.auto} auto, ${compactions.manual} manual, ${compactions.unknown} unknown`
			);
		}
		if (
			preferences.compactionShowReclaimed &&
			compactions.reclaimedTokens > 0
		) {
			details.push(`↓${formatStatsCount(compactions.reclaimedTokens)}`);
		}
		return `${formatStatsCount(selected) ?? "0"} (${details.join("; ")})`;
	}
	return formatStatsCount(selected) ?? "0";
}

export function timerLabel(
	stats: ReturnType<typeof deriveSessionStats>,
	preferences: StatsPreferences
): string | null {
	const timer = stats.cacheTimer;
	if (!timer) {
		return null;
	}
	if (timer.state === "hot") {
		return `${preferences.cacheHotGlyph} HOT`;
	}
	if (timer.state === "cold") {
		return `${preferences.cacheColdGlyph} COLD`;
	}
	return `${preferences.cacheCountdownGlyph} ${formatStatsDuration(timer.remainingMs ?? 0)}`;
}
