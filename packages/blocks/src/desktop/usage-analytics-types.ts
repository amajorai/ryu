export const USAGE_SCOPES = ["you", "organization", "node"] as const;
export type UsageScope = (typeof USAGE_SCOPES)[number];

export const USAGE_GRANULARITIES = [
	"15m",
	"hourly",
	"daily",
	"weekly",
	"monthly",
] as const;
export type UsageGranularity = (typeof USAGE_GRANULARITIES)[number];

export type UsageSource =
	| "managed"
	| "byok"
	| "self_hosted"
	| "local"
	| "unknown";

export interface UsageDateRange {
	from: Date;
	to: Date;
}

export interface UsageEvent {
	agentSeconds?: number;
	/** Width of a server-owned aggregate represented by this event. */
	bucketSeconds?: number;
	/** Prompt tokens read from the provider cache, when the host reports them. */
	cacheReadTokens?: number;
	/** Prompt tokens written to the provider cache, when the host reports them. */
	cacheWriteTokens?: number;
	costMicroUsd?: number | null;
	durationMs?: number | null;
	error?: boolean;
	errorCount?: number;
	feature?: string | null;
	inputTokens?: number;
	latencySamples?: number;
	latencyTotalMs?: number;
	memberId?: string | null;
	model?: string | null;
	nodeId?: string | null;
	organizationId?: string | null;
	outputTokens?: number;
	provider?: string | null;
	/**
	 * Background work tag. `null` is a foreground (or untagged) call;
	 * `undefined` means the host does not report purpose at all.
	 */
	purpose?: string | null;
	requestCount?: number;
	/** Stable request identity used to join audit events with billing rows. */
	requestId?: string | null;
	source?: UsageSource | null;
	/** ISO timestamp for the start of the observed request. */
	timestamp: string;
}

export interface UsageBucket {
	averageLatencyMs: number | null;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	end: string;
	errors: number;
	inputTokens: number;
	label: string;
	outputTokens: number;
	requests: number;
	spendMicroUsd: number | null;
	start: string;
}

export interface UsageTrendPoint {
	errors: number;
	label: string;
	requests: number;
	spend: number | null;
	tokens: number;
}

/** Bound chart work while preserving exact totals for long, detailed ranges. */
export function compactUsageTrendPoints(
	points: UsageTrendPoint[],
	maximumPoints = 1000
): UsageTrendPoint[] {
	if (maximumPoints < 1 || points.length <= maximumPoints) {
		return maximumPoints < 1 ? [] : points;
	}
	const groupSize = Math.ceil(points.length / maximumPoints);
	const compacted: UsageTrendPoint[] = [];
	for (let index = 0; index < points.length; index += groupSize) {
		const group = points.slice(index, index + groupSize);
		const first = group[0];
		const last = group.at(-1);
		if (!(first && last)) {
			continue;
		}
		let spend: number | null = null;
		let errors = 0;
		let requests = 0;
		let tokens = 0;
		for (const point of group) {
			errors += point.errors;
			requests += point.requests;
			tokens += point.tokens;
			if (point.spend !== null) {
				spend = (spend ?? 0) + point.spend;
			}
		}
		compacted.push({
			errors,
			label: first === last ? first.label : `${first.label} – ${last.label}`,
			requests,
			spend,
			tokens,
		});
	}
	return compacted;
}

/** One provider's per-bucket values, aligned index-for-index with `buckets`. */
export interface UsageProviderSeries {
	errors: number[];
	key: string;
	label: string;
	requests: number[];
	spendMicroUsd: (number | null)[];
	tokens: number[];
}

export interface UsageBreakdownRow {
	key: string;
	label: string;
	requests: number;
	spendMicroUsd: number | null;
	tokens: number;
}

export interface UsageAnalyticsTotals {
	activeDays: number;
	activeMembers: number;
	activeNodes: number;
	agentSeconds: number;
	averageLatencyMs: number | null;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	errors: number;
	inputTokens: number;
	outputTokens: number;
	requests: number;
	spendMicroUsd: number | null;
}

export interface UsageAnalyticsData {
	availability?: {
		message?: string;
		supported: boolean;
	};
	buckets: UsageBucket[];
	byFeature: UsageBreakdownRow[];
	byModel: UsageBreakdownRow[];
	byProvider: UsageBreakdownRow[];
	/**
	 * Request counts by background purpose, keyed by the raw purpose tag (or
	 * {@link FOREGROUND_PURPOSE_KEY}). Absent unless the host reports at least
	 * one tagged call in range.
	 */
	byPurpose?: UsageBreakdownRow[];
	bySource: UsageBreakdownRow[];
	caption: string;
	from: string;
	granularity: UsageGranularity;
	modelOptions: string[];
	providerOptions: string[];
	/** Top providers over time; absent from hosts that only report totals. */
	providerSeries?: UsageProviderSeries[];
	scope: UsageScope;
	scopeLabel: string;
	to: string;
	totals: UsageAnalyticsTotals;
}
