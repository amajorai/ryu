import { activeLocale, dateFormatter } from "@ryu/i18n/core";
import type { UsageBucket, UsageGranularity } from "./usage-analytics-types.ts";

/**
 * Share of cache traffic that was reuse: reads / (reads + writes), or `null`
 * with no cache traffic. Some providers report cache reads but never writes,
 * so this reads 100% for them; it is a reuse ratio, not a hit rate over all
 * prompt tokens.
 */
export function cacheReuseRatio(read: number, write: number): number | null {
	const total = read + write;
	return total > 0 ? read / total : null;
}

export interface UsageCachePoint {
	label: string;
	/** Reuse ratio of the summed reads and writes; `null` with no cache traffic. */
	ratio: number | null;
	read: number;
	write: number;
}

/** Per-bucket prompt-cache traffic, grouped to at most `maximumPoints`. */
export function usageCacheSeries(
	buckets: readonly UsageBucket[],
	maximumPoints = 1000
): UsageCachePoint[] {
	if (maximumPoints < 1) {
		return [];
	}
	const groupSize = Math.max(1, Math.ceil(buckets.length / maximumPoints));
	const points: UsageCachePoint[] = [];
	for (let index = 0; index < buckets.length; index += groupSize) {
		const group = buckets.slice(index, index + groupSize);
		const first = group[0];
		const last = group.at(-1);
		if (!(first && last)) {
			continue;
		}
		let read = 0;
		let write = 0;
		for (const bucket of group) {
			read += bucket.cacheReadTokens;
			write += bucket.cacheWriteTokens;
		}
		points.push({
			label: first === last ? first.label : `${first.label} – ${last.label}`,
			// A ratio of sums: averaging per-bucket ratios would overweight
			// quiet buckets.
			ratio: cacheReuseRatio(read, write),
			read,
			write,
		});
	}
	return points;
}

const GRANULARITY_MS = {
	"15m": 15 * 60 * 1000,
	hourly: 60 * 60 * 1000,
	daily: 24 * 60 * 60 * 1000,
	weekly: 7 * 24 * 60 * 60 * 1000,
	monthly: 0,
} satisfies Record<UsageGranularity, number>;

function startOfUtcMonth(date: Date): Date {
	return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function startOfUtcWeek(date: Date): Date {
	const start = new Date(
		Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
	);
	const day = start.getUTCDay();
	const daysFromMonday = day === 0 ? 6 : day - 1;
	start.setUTCDate(start.getUTCDate() - daysFromMonday);
	return start;
}

export function bucketStartFor(
	date: Date,
	granularity: UsageGranularity
): Date {
	if (granularity === "monthly") {
		return startOfUtcMonth(date);
	}
	if (granularity === "weekly") {
		return startOfUtcWeek(date);
	}
	const interval = GRANULARITY_MS[granularity];
	return new Date(Math.floor(date.getTime() / interval) * interval);
}

export function nextBucketStart(
	date: Date,
	granularity: UsageGranularity
): Date {
	if (granularity === "monthly") {
		return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
	}
	if (granularity === "weekly") {
		return new Date(date.getTime() + GRANULARITY_MS.weekly);
	}
	return new Date(date.getTime() + GRANULARITY_MS[granularity]);
}

export function formatBucketLabel(
	date: Date,
	granularity: UsageGranularity,
	locale: string = activeLocale()
): string {
	const options: Intl.DateTimeFormatOptions =
		granularity === "15m" || granularity === "hourly"
			? { day: "numeric", hour: "numeric", minute: "2-digit", month: "short" }
			: granularity === "monthly"
				? { month: "short", year: "numeric" }
				: { day: "numeric", month: "short" };
	return dateFormatter(locale, options).format(date);
}

/** Buckets projected ahead of the last completed bucket, per resolution. */
export const USAGE_FORECAST_HORIZON = {
	"15m": 16,
	daily: 14,
	hourly: 24,
	monthly: 3,
	weekly: 4,
} satisfies Record<UsageGranularity, number>;

export const USAGE_FORECAST_HORIZON_LABELS = {
	"15m": "next 4 hours",
	daily: "next 14 days",
	hourly: "next 24 hours",
	monthly: "next 3 months",
	weekly: "next 4 weeks",
} satisfies Record<UsageGranularity, string>;

export interface UsageForecastSlot {
	/** Index into `buckets` when the slot is inside the selected range. */
	bucketIndex: number | null;
	label: string;
	start: string;
}

export interface UsageForecastTimeline {
	/** Completed buckets at the start of the range; only these are fitted. */
	fitCount: number;
	slots: UsageForecastSlot[];
}

/**
 * Lay out forecast slots after the last completed bucket. The in-progress
 * bucket is projected, not fitted, so a partial "today" never drags the trend
 * down. Ranges that ended before the current bucket get no forecast.
 */
export function usageForecastTimeline(
	buckets: readonly UsageBucket[],
	granularity: UsageGranularity,
	now = Date.now()
): UsageForecastTimeline | null {
	const last = buckets.at(-1);
	if (!last || Date.parse(last.end) < now) {
		return null;
	}
	let fitCount = 0;
	while (
		fitCount < buckets.length &&
		Date.parse(buckets[fitCount]?.end ?? "") <= now
	) {
		fitCount += 1;
	}
	const slots: UsageForecastSlot[] = [];
	let cursor = new Date(buckets[fitCount]?.start ?? last.end);
	for (
		let index = fitCount;
		slots.length < USAGE_FORECAST_HORIZON[granularity];
		index += 1
	) {
		const bucket = buckets[index];
		slots.push(
			bucket
				? { bucketIndex: index, label: bucket.label, start: bucket.start }
				: {
						bucketIndex: null,
						label: formatBucketLabel(cursor, granularity),
						start: cursor.toISOString(),
					}
		);
		cursor = nextBucketStart(cursor, granularity);
	}
	return { fitCount, slots };
}
