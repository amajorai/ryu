import { OWN_SUPPLY_POOLS } from "@ryu/auth/lib/credit-pools";

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

export const GRANULARITY_LABELS = {
	"15m": "15 min",
	daily: "Daily",
	hourly: "Hourly",
	monthly: "Monthly",
	weekly: "Weekly",
} satisfies Record<UsageGranularity, string>;

export const SOURCE_LABELS = {
	byok: "BYOK",
	local: "Local",
	managed: "Managed credits",
	self_hosted: "Self-hosted",
	unknown: "Other",
} satisfies Record<UsageSource, string>;

/** Background purposes the Gateway attributes (`x-ryu-purpose` wire names). */
export const USAGE_PURPOSES = [
	"btw",
	"advisor",
	"compaction",
	"handoff",
	"auto_title",
	"chat_suggestions",
	"composer_prediction",
	"predict",
	"memory_dream",
	"recommendations",
	"learning_judge",
	"agent_auto_route",
	"workflow_prompt",
	"delegate",
	"app_model_stream",
	"retrieval_expansion",
] as const;
export type UsagePurpose = (typeof USAGE_PURPOSES)[number];

/**
 * Row key for calls without a purpose (your own chat and agent turns). The
 * parentheses are outside the Gateway's purpose grammar (`[a-z0-9_:.@/-]`),
 * so no tagged call can ever land in this row.
 */
export const FOREGROUND_PURPOSE_KEY = "(foreground)";

/** Prefix the Gateway uses for plugin-initiated background calls. */
export const PLUGIN_PURPOSE_PREFIX = "plugin:";

/**
 * English source literals for purpose rows. Render them through the i18n
 * literal boundary (`useLocalizedText(label, { literal: true })`), like the
 * rest of this dashboard's copy.
 */
export const PURPOSE_LABELS = {
	advisor: "Advisor",
	agent_auto_route: "Agent auto-route",
	app_model_stream: "App model calls",
	auto_title: "Chat titles",
	btw: "/btw side questions",
	chat_suggestions: "Chat suggestions",
	compaction: "Context compaction",
	composer_prediction: "Composer prediction",
	delegate: "Delegation",
	handoff: "Handoff summaries",
	learning_judge: "Learning judge",
	memory_dream: "Memory consolidation",
	predict: "Predictions",
	recommendations: "Recommendations",
	retrieval_expansion: "Search query expansion",
	workflow_prompt: "Workflow steps",
} satisfies Record<UsagePurpose, string>;

export const FOREGROUND_PURPOSE_LABEL = "Chat and agent turns";
export const PLUGIN_PURPOSE_LABEL = "Plugin";

function isUsagePurpose(key: string): key is UsagePurpose {
	return Object.hasOwn(PURPOSE_LABELS, key);
}

/** The plugin id of a `plugin:<id>` purpose, or `null` for any other key. */
export function pluginIdForPurpose(key: string): string | null {
	if (!key.startsWith(PLUGIN_PURPOSE_PREFIX)) {
		return null;
	}
	const pluginId = key.slice(PLUGIN_PURPOSE_PREFIX.length);
	return pluginId.length > 0 ? pluginId : null;
}

/**
 * The English label for a purpose row key. Unknown tags from newer Gateways
 * render verbatim rather than disappearing.
 */
export function usagePurposeLabel(key: string): string {
	if (key === FOREGROUND_PURPOSE_KEY) {
		return FOREGROUND_PURPOSE_LABEL;
	}
	if (isUsagePurpose(key)) {
		return PURPOSE_LABELS[key];
	}
	const pluginId = pluginIdForPurpose(key);
	return pluginId === null ? key : `${PLUGIN_PURPOSE_LABEL} · ${pluginId}`;
}

/** Whether a purpose row key has a first-party English label to localize. */
export function isLabelledPurposeKey(key: string): boolean {
	return key === FOREGROUND_PURPOSE_KEY || isUsagePurpose(key);
}

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

const numberOrZero = (value: number | undefined): number =>
	Number.isFinite(value) ? (value ?? 0) : 0;

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
	granularity: UsageGranularity
): string {
	const options: Intl.DateTimeFormatOptions =
		granularity === "15m" || granularity === "hourly"
			? { day: "numeric", hour: "numeric", minute: "2-digit", month: "short" }
			: granularity === "monthly"
				? { month: "short", year: "numeric" }
				: { day: "numeric", month: "short" };
	return new Intl.DateTimeFormat(undefined, options).format(date);
}

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

/** The one provider name a user reads for any Ryu-served work. */
export const RYU_ROUTER_LABEL = "Ryu Router";

/**
 * Gateway slots of Ryu's OWN supply, all shown as "Ryu Router": users pick
 * models from one provider and never see the supplier that served a request.
 * The OpenRouter pass-through is deliberately absent here, because usage
 * analytics also carries BYOK OpenRouter traffic; ledger surfaces, which only
 * ever carry managed traffic, use {@link ledgerProviderLabel}.
 */
const POOL_PROVIDER_LABELS: Record<string, string> = {
	...Object.fromEntries(
		OWN_SUPPLY_POOLS.flatMap((pool) =>
			pool.gatewayProviders.map((provider) => [provider, RYU_ROUTER_LABEL])
		)
	),
	// The provider id the gateway reports for managed Ryu Router work.
	ryu: RYU_ROUTER_LABEL,
};

/** The user-facing name for a usage row's provider key. */
export function usageProviderLabel(key: string): string {
	return POOL_PROVIDER_LABELS[key] ?? key;
}

/**
 * The user-facing name for a credit-LEDGER row's provider. Every ledger debit
 * is managed (Ryu-billed) traffic, so the managed OpenRouter pass-through is
 * Ryu Router too; anything else falls back to {@link usageProviderLabel}.
 */
export function ledgerProviderLabel(key: string): string {
	return key === "openrouter" ? RYU_ROUTER_LABEL : usageProviderLabel(key);
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
