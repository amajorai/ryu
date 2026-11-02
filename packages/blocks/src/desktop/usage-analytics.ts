import {
	bucketStartFor,
	formatBucketLabel,
	nextBucketStart,
} from "./usage-analytics-buckets.ts";
import {
	FOREGROUND_PURPOSE_KEY,
	POOL_PROVIDER_LABELS,
	SOURCE_LABELS,
	usagePurposeLabel,
} from "./usage-analytics-labels.ts";
import type {
	UsageAnalyticsData,
	UsageAnalyticsTotals,
	UsageBreakdownRow,
	UsageEvent,
	UsageGranularity,
	UsageProviderSeries,
	UsageScope,
} from "./usage-analytics-types.ts";

export {
	bucketStartFor,
	cacheReuseRatio,
	formatBucketLabel,
	nextBucketStart,
	USAGE_FORECAST_HORIZON,
	USAGE_FORECAST_HORIZON_LABELS,
	type UsageCachePoint,
	type UsageForecastSlot,
	type UsageForecastTimeline,
	usageCacheSeries,
	usageForecastTimeline,
} from "./usage-analytics-buckets.ts";
export {
	FOREGROUND_PURPOSE_KEY,
	FOREGROUND_PURPOSE_LABEL,
	GRANULARITY_LABELS,
	isLabelledPurposeKey,
	ledgerProviderLabel,
	PLUGIN_PURPOSE_LABEL,
	PLUGIN_PURPOSE_PREFIX,
	PURPOSE_LABELS,
	pluginIdForPurpose,
	RYU_ROUTER_LABEL,
	SOURCE_LABELS,
	USAGE_PURPOSES,
	type UsagePurpose,
	usageProviderLabel,
	usagePurposeLabel,
} from "./usage-analytics-labels.ts";
export {
	compactUsageTrendPoints,
	USAGE_GRANULARITIES,
	USAGE_SCOPES,
	type UsageAnalyticsData,
	type UsageAnalyticsTotals,
	type UsageBreakdownRow,
	type UsageBucket,
	type UsageDateRange,
	type UsageEvent,
	type UsageGranularity,
	type UsageProviderSeries,
	type UsageScope,
	type UsageSource,
	type UsageTrendPoint,
} from "./usage-analytics-types.ts";

const numberOrZero = (value: number | undefined): number =>
	Number.isFinite(value) ? (value ?? 0) : 0;

function labelForKey(key: string, granularity: UsageGranularity): string {
	return formatBucketLabel(new Date(key), granularity);
}

function cleanKey(value: string | null | undefined, fallback: string): string {
	const trimmed = value?.trim();
	return trimmed ? trimmed : fallback;
}

interface MutableBreakdown {
	knownSpend: boolean;
	requests: number;
	spendMicroUsd: number;
	tokens: number;
}

interface MutableBucket extends MutableBreakdown {
	agentSeconds: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	end: Date;
	errors: number;
	inputTokens: number;
	latencyMs: number;
	latencySamples: number;
	memberIds: Set<string>;
	nodeIds: Set<string>;
	outputTokens: number;
}

function newBreakdown(): MutableBreakdown {
	return { knownSpend: false, requests: 0, spendMicroUsd: 0, tokens: 0 };
}

function addBreakdown(
	map: Map<string, MutableBreakdown>,
	key: string,
	event: UsageEvent,
	requests: number,
	tokens: number
): void {
	const breakdown = map.get(key) ?? newBreakdown();
	breakdown.requests += requests;
	breakdown.tokens += tokens;
	if (event.costMicroUsd !== null && event.costMicroUsd !== undefined) {
		breakdown.knownSpend = true;
		breakdown.spendMicroUsd += numberOrZero(event.costMicroUsd);
	}
	map.set(key, breakdown);
}

function toRows(
	map: Map<string, MutableBreakdown>,
	labels?: Record<string, string>
): UsageBreakdownRow[] {
	return [...map.entries()]
		.map(([key, value]) => ({
			key,
			label: labels?.[key] ?? key,
			requests: value.requests,
			spendMicroUsd: value.knownSpend ? value.spendMicroUsd : null,
			tokens: value.tokens,
		}))
		.sort((a, b) => b.requests - a.requests || b.tokens - a.tokens)
		.slice(0, 8);
}

interface MutableProviderBucket {
	errors: number;
	knownSpend: boolean;
	requests: number;
	spendMicroUsd: number;
	tokens: number;
}

const PROVIDER_SERIES_LIMIT = 5;

function addProviderBucket(
	providers: Map<string, Map<string, MutableProviderBucket>>,
	providerKey: string,
	bucketKey: string,
	event: UsageEvent,
	requests: number,
	tokens: number,
	errors: number
): void {
	const buckets = providers.get(providerKey) ?? new Map();
	const bucket = buckets.get(bucketKey) ?? {
		errors: 0,
		knownSpend: false,
		requests: 0,
		spendMicroUsd: 0,
		tokens: 0,
	};
	bucket.errors += errors;
	bucket.requests += requests;
	bucket.tokens += tokens;
	if (event.costMicroUsd !== null && event.costMicroUsd !== undefined) {
		bucket.knownSpend = true;
		bucket.spendMicroUsd += numberOrZero(event.costMicroUsd);
	}
	buckets.set(bucketKey, bucket);
	providers.set(providerKey, buckets);
}

function toProviderSeries(
	totals: Map<string, MutableBreakdown>,
	providers: Map<string, Map<string, MutableProviderBucket>>,
	bucketKeys: string[]
): UsageProviderSeries[] {
	return [...totals.entries()]
		.sort(([, a], [, b]) => b.requests - a.requests || b.tokens - a.tokens)
		.slice(0, PROVIDER_SERIES_LIMIT)
		.map(([key]) => {
			const buckets = providers.get(key);
			const series: UsageProviderSeries = {
				errors: [],
				key,
				label: key,
				requests: [],
				spendMicroUsd: [],
				tokens: [],
			};
			for (const bucketKey of bucketKeys) {
				const bucket = buckets?.get(bucketKey);
				series.errors.push(bucket?.errors ?? 0);
				series.requests.push(bucket?.requests ?? 0);
				series.tokens.push(bucket?.tokens ?? 0);
				series.spendMicroUsd.push(
					bucket?.knownSpend ? bucket.spendMicroUsd : null
				);
			}
			return series;
		});
}

function addSpend(target: MutableBucket, event: UsageEvent): void {
	if (event.costMicroUsd === null || event.costMicroUsd === undefined) {
		return;
	}
	target.knownSpend = true;
	target.spendMicroUsd += numberOrZero(event.costMicroUsd);
}

function addErrors(
	target: MutableBucket,
	event: UsageEvent,
	requests: number
): void {
	if (event.errorCount !== undefined) {
		target.errors += Math.max(0, numberOrZero(event.errorCount));
		return;
	}
	target.errors += event.error ? requests : 0;
}

function addLatency(target: MutableBucket, event: UsageEvent): void {
	if (
		event.latencyTotalMs !== undefined &&
		event.latencySamples !== undefined &&
		Number.isFinite(event.latencyTotalMs) &&
		Number.isFinite(event.latencySamples) &&
		event.latencySamples > 0
	) {
		target.latencyMs += Math.max(0, event.latencyTotalMs);
		target.latencySamples += event.latencySamples;
		return;
	}
	if (
		event.durationMs !== null &&
		event.durationMs !== undefined &&
		Number.isFinite(event.durationMs)
	) {
		target.latencyMs += Math.max(0, event.durationMs);
		target.latencySamples += 1;
	}
}

export function aggregateUsageEvents({
	events,
	from,
	granularity,
	scope,
	to,
	scopeLabel,
	caption,
}: {
	caption: string;
	events: UsageEvent[];
	from: Date;
	granularity: UsageGranularity;
	scope: UsageScope;
	scopeLabel: string;
	to: Date;
}): UsageAnalyticsData {
	const firstBucket = bucketStartFor(from, granularity);
	const buckets = new Map<string, MutableBucket>();
	const byProvider = new Map<string, MutableBreakdown>();
	const byModel = new Map<string, MutableBreakdown>();
	const bySource = new Map<string, MutableBreakdown>();
	const byFeature = new Map<string, MutableBreakdown>();
	const byPurpose = new Map<string, MutableBreakdown>();
	let hasTaggedPurpose = false;
	const activeDateKeys = new Set<string>();
	const providerBuckets = new Map<string, Map<string, MutableProviderBucket>>();

	for (
		let cursor = firstBucket;
		cursor < to;
		cursor = nextBucketStart(cursor, granularity)
	) {
		const end = nextBucketStart(cursor, granularity);
		buckets.set(cursor.toISOString(), {
			...newBreakdown(),
			agentSeconds: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			end,
			errors: 0,
			inputTokens: 0,
			latencyMs: 0,
			latencySamples: 0,
			memberIds: new Set(),
			nodeIds: new Set(),
			outputTokens: 0,
		});
	}

	for (const event of events) {
		const date = new Date(event.timestamp);
		const bucketSeconds = Math.max(0, numberOrZero(event.bucketSeconds));
		const overlapsStart =
			date >= from || date.getTime() + bucketSeconds * 1000 > from.getTime();
		if (!(Number.isFinite(date.getTime()) && overlapsStart) || date >= to) {
			continue;
		}
		const start = bucketStartFor(date, granularity);
		const bucket = buckets.get(start.toISOString());
		if (!bucket) {
			continue;
		}
		activeDateKeys.add(date.toISOString().slice(0, 10));
		const requests =
			event.requestCount === undefined
				? 1
				: Math.max(0, numberOrZero(event.requestCount));
		const inputTokens = numberOrZero(event.inputTokens);
		const outputTokens = numberOrZero(event.outputTokens);
		const tokens = inputTokens + outputTokens;
		bucket.requests += requests;
		bucket.inputTokens += inputTokens;
		bucket.outputTokens += outputTokens;
		bucket.agentSeconds += numberOrZero(event.agentSeconds);
		bucket.cacheReadTokens += Math.max(0, numberOrZero(event.cacheReadTokens));
		bucket.cacheWriteTokens += Math.max(
			0,
			numberOrZero(event.cacheWriteTokens)
		);
		const errorsBefore = bucket.errors;
		addErrors(bucket, event, requests);
		addLatency(bucket, event);
		if (event.memberId) {
			bucket.memberIds.add(event.memberId);
		}
		if (event.nodeId) {
			bucket.nodeIds.add(event.nodeId);
		}
		addSpend(bucket, event);
		const providerKey = cleanKey(event.provider, "Unknown provider");
		addBreakdown(byProvider, providerKey, event, requests, tokens);
		addProviderBucket(
			providerBuckets,
			providerKey,
			start.toISOString(),
			event,
			requests,
			tokens,
			bucket.errors - errorsBefore
		);
		addBreakdown(
			byModel,
			cleanKey(event.model, "Unknown model"),
			event,
			requests,
			tokens
		);
		addBreakdown(
			bySource,
			cleanKey(event.source, "unknown"),
			event,
			requests,
			tokens
		);
		addBreakdown(
			byFeature,
			cleanKey(event.feature, "Unattributed"),
			event,
			requests,
			tokens
		);
		// Hosts that do not report purpose leave it undefined; only a reported
		// `null` is a foreground call.
		if (event.purpose !== undefined) {
			const purposeKey = cleanKey(event.purpose, FOREGROUND_PURPOSE_KEY);
			hasTaggedPurpose ||= purposeKey !== FOREGROUND_PURPOSE_KEY;
			addBreakdown(byPurpose, purposeKey, event, requests, tokens);
		}
	}

	const materializedBuckets = [...buckets.entries()].map(([start, value]) => ({
		averageLatencyMs:
			value.latencySamples > 0
				? Math.round(value.latencyMs / value.latencySamples)
				: null,
		cacheReadTokens: value.cacheReadTokens,
		cacheWriteTokens: value.cacheWriteTokens,
		end: value.end.toISOString(),
		errors: value.errors,
		inputTokens: value.inputTokens,
		label: labelForKey(start, granularity),
		outputTokens: value.outputTokens,
		requests: value.requests,
		spendMicroUsd: value.knownSpend ? value.spendMicroUsd : null,
		start,
	}));
	const activeMemberIds = new Set<string>();
	const activeNodeIds = new Set<string>();
	const totals = materializedBuckets.reduce<UsageAnalyticsTotals>(
		(acc, bucket) => {
			acc.inputTokens += bucket.inputTokens;
			acc.outputTokens += bucket.outputTokens;
			acc.requests += bucket.requests;
			acc.errors += bucket.errors;
			acc.cacheReadTokens += bucket.cacheReadTokens;
			acc.cacheWriteTokens += bucket.cacheWriteTokens;
			if (bucket.spendMicroUsd !== null) {
				acc.spendMicroUsd = (acc.spendMicroUsd ?? 0) + bucket.spendMicroUsd;
			}
			return acc;
		},
		{
			activeDays: activeDateKeys.size,
			activeMembers: 0,
			activeNodes: 0,
			agentSeconds: 0,
			averageLatencyMs: null,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			errors: 0,
			inputTokens: 0,
			outputTokens: 0,
			requests: 0,
			spendMicroUsd: null,
		}
	);
	let latencyTotal = 0;
	let latencySamples = 0;
	for (const value of buckets.values()) {
		if (value.requests > 0 || value.inputTokens + value.outputTokens > 0) {
			for (const memberId of value.memberIds) {
				activeMemberIds.add(memberId);
			}
			for (const nodeId of value.nodeIds) {
				activeNodeIds.add(nodeId);
			}
		}
		if (value.latencySamples > 0) {
			latencyTotal += value.latencyMs;
			latencySamples += value.latencySamples;
		}
		totals.agentSeconds += value.agentSeconds;
	}
	totals.activeMembers = activeMemberIds.size;
	totals.activeNodes = activeNodeIds.size;
	totals.averageLatencyMs =
		latencySamples > 0 ? Math.round(latencyTotal / latencySamples) : null;

	const data: UsageAnalyticsData = {
		availability: { supported: true },
		byFeature: toRows(byFeature),
		byModel: toRows(byModel),
		byProvider: toRows(byProvider, POOL_PROVIDER_LABELS),
		bySource: toRows(bySource, SOURCE_LABELS),
		buckets: materializedBuckets,
		caption,
		from: from.toISOString(),
		granularity,
		modelOptions: [...byModel.keys()].sort(),
		providerOptions: [...byProvider.keys()].sort(),
		providerSeries: toProviderSeries(
			byProvider,
			providerBuckets,
			materializedBuckets.map((bucket) => bucket.start)
		),
		scope,
		scopeLabel,
		to: to.toISOString(),
		totals,
	};
	if (hasTaggedPurpose) {
		data.byPurpose = toRows(byPurpose).map((row) => ({
			...row,
			label: usagePurposeLabel(row.key),
		}));
	}
	return data;
}
