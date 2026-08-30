/** A deliberately small JSON-like shape so the model can consume persisted and live AI SDK parts. */
type JsonRecord = Record<string, unknown>;

export interface StatsMessage {
	content?: unknown;
	createdAt?: unknown;
	metadata?: unknown;
	parts?: readonly unknown[];
	role?: unknown;
}

export type CacheScope = "latest" | "session";
export type CompactionValue =
	| "total"
	| "auto"
	| "manual"
	| "unknown"
	| "reclaimed";
export type ResetTimerMode = "exact" | "progress" | "remaining";
export type UsagePercentMode = "remaining" | "used";

/** Stats are app-owned and stay hidden until the Stats contribution is enabled. */
export const DEFAULT_STATS_PLUGIN_ENABLED = false;

export interface StatsPreferences {
	cacheColdGlyph: string;
	cacheCountdownGlyph: string;
	cacheHotGlyph: string;
	cacheScope: CacheScope;
	cacheTimerTtlMinutes: 5 | 60;
	compactionShowReclaimed: boolean;
	compactionShowTriggers: boolean;
	compactionValue: CompactionValue;
	hideEmpty: boolean;
	resetTimerLocale: string;
	resetTimerMode: ResetTimerMode;
	resetTimerTimezone: "local" | "utc";
	rollingWindowSeconds: number;
	showCacheTimer: boolean;
	usagePercentMode: UsagePercentMode;
	usageShowTimeCursor: boolean;
}

export const DEFAULT_STATS_PREFERENCES: StatsPreferences = {
	cacheScope: "latest",
	cacheTimerTtlMinutes: 5,
	compactionValue: "total",
	compactionShowReclaimed: true,
	compactionShowTriggers: true,
	hideEmpty: true,
	resetTimerLocale: "system",
	resetTimerMode: "remaining",
	resetTimerTimezone: "local",
	rollingWindowSeconds: 0,
	showCacheTimer: true,
	cacheHotGlyph: "🔥",
	cacheColdGlyph: "❄",
	cacheCountdownGlyph: "⏱",
	usagePercentMode: "used",
	usageShowTimeCursor: true,
};

export interface StatsUsageWindow {
	label: string;
	model: string | null;
	resetsAt: string | null;
	usedPercent: number;
	windowSeconds: number | null;
}

export interface StatsUsageValue {
	currency?: string | null;
	kind: "count" | "dollars" | "percent";
	number: number;
	unit: string | null;
}

export interface StatsUsageMeter {
	expiresAt: readonly string[];
	label: string;
	resetsAt: string | null;
	values: readonly StatsUsageValue[];
}

/** Structural subset of the desktop usage API; provider credentials never enter this shape. */
export interface StatsUsageSnapshot {
	available: boolean;
	extraUsageUsd: number | null;
	meters: readonly StatsUsageMeter[];
	windows: readonly StatsUsageWindow[];
}

export interface StatsUsageMetric {
	percent?: number;
	resetAt: string | null;
	windowSeconds: number | null;
}

export interface StatsUsageSummary {
	blockReset: StatsUsageMetric | null;
	blockTimer: StatsUsageMetric | null;
	extraCurrency: string | null;
	extraRemaining?: number;
	extraUsed?: number;
	extraUtilization?: number;
	fable?: StatsUsageMetric;
	opus?: StatsUsageMetric;
	session?: StatsUsageMetric;
	sonnet?: StatsUsageMetric;
	weekly?: StatsUsageMetric;
	weeklyReset: StatsUsageMetric | null;
}

export type CacheTimerState = "cold" | "countdown" | "hot";

export interface CacheTimer {
	anchorAt: number;
	remainingMs: number | null;
	state: CacheTimerState;
}

export interface CompactionSummary {
	auto: number;
	count: number;
	manual: number;
	reclaimedTokens: number;
	unknown: number;
}

export interface SessionStats {
	cacheHitRate?: number;
	cacheRead?: number;
	cacheReadShare?: number;
	cacheTimer?: CacheTimer;
	cacheWrite?: number;
	cacheWriteShare?: number;
	compactions: CompactionSummary;
	contextLength?: number;
	contextPercent?: number;
	contextPercentUsable?: number;
	contextRemaining?: number;
	contextWindow?: number;
	costAmount?: number;
	costCurrency?: string;
	inputSpeed?: number;
	inputTokens?: number;
	outputSpeed?: number;
	outputTokens?: number;
	steps: number;
	totalSpeed?: number;
	totalTokens?: number;
	turns: number;
	usage?: StatsUsageSummary;
}

export interface DeriveStatsOptions {
	contextFallback?: number;
	contextWindowOverride?: number;
	isMainChainActive?: boolean;
	modelName?: string;
	now?: number;
	preferences?: Partial<StatsPreferences>;
	usage?: StatsUsageSnapshot | null;
}

interface TurnSample {
	cacheRead?: number;
	cacheReadCumulative?: number;
	cacheWrite?: number;
	cacheWriteCumulative?: number;
	contextInput?: number;
	contextLength?: number;
	contextOutput?: number;
	contextUsableWindow?: number;
	contextWindow?: number;
	costAmount?: number;
	costCumulative?: number;
	costCurrency?: string;
	durationMs?: number;
	input?: number;
	inputCumulative?: number;
	inputSpeed?: number;
	observedAt?: number;
	output?: number;
	outputCumulative?: number;
	outputSpeed?: number;
	total?: number;
	totalCumulative?: number;
}

interface CompactionMarker {
	postTokens?: number;
	preTokens?: number;
	trigger: "auto" | "manual" | "unknown";
}

function asRecord(value: unknown): JsonRecord | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as JsonRecord)
		: null;
}

function asFiniteNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function nonNegative(value: number | undefined): number | undefined {
	return value === undefined ? undefined : Math.max(0, value);
}

function numberFrom(
	record: JsonRecord | null,
	keys: readonly string[]
): number | undefined {
	if (!record) {
		return undefined;
	}
	for (const key of keys) {
		const value = asFiniteNumber(record[key]);
		if (value !== undefined) {
			return value;
		}
	}
	return undefined;
}

function stringFrom(
	record: JsonRecord | null,
	keys: readonly string[]
): string | undefined {
	if (!record) {
		return undefined;
	}
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim() !== "") {
			return value;
		}
	}
	return undefined;
}

function firstRecord(
	record: JsonRecord,
	keys: readonly string[]
): JsonRecord | null {
	for (const key of keys) {
		const nested = asRecord(record[key]);
		if (nested) {
			return nested;
		}
	}
	return null;
}

function numberFromRecords(
	records: readonly (JsonRecord | null)[],
	keys: readonly string[]
): number | undefined {
	for (const record of records) {
		const value = numberFrom(record, keys);
		if (value !== undefined) {
			return value;
		}
	}
	return undefined;
}

function stringFromRecords(
	records: readonly (JsonRecord | null)[],
	keys: readonly string[]
): string | undefined {
	for (const record of records) {
		const value = stringFrom(record, keys);
		if (value) {
			return value;
		}
	}
	return undefined;
}

function timestamp(value: unknown): number | undefined {
	const numeric = asFiniteNumber(value);
	if (numeric !== undefined) {
		return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
	}
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isNaN(parsed) ? undefined : parsed;
	}
	return undefined;
}

function messageTimestamp(message: StatsMessage): number | undefined {
	const metadata = asRecord(message.metadata);
	return (
		timestamp(message.createdAt) ??
		timestamp(numberFrom(metadata, ["createdAt", "created_at", "timestamp"])) ??
		timestamp(stringFrom(metadata, ["createdAt", "created_at", "timestamp"]))
	);
}

function partType(part: JsonRecord): string {
	return typeof part.type === "string" ? part.type.toLowerCase() : "";
}

function partData(part: JsonRecord): JsonRecord {
	return asRecord(part.data) ?? part;
}

function isStatsPart(part: JsonRecord): boolean {
	const type = partType(part);
	if (
		type === "data-ryu-stats" ||
		type === "data-acp-usage" ||
		type.includes("usage") ||
		type.includes("stats")
	) {
		return true;
	}
	const data = partData(part);
	return Boolean(
		firstRecord(data, [
			"context_window",
			"contextWindow",
			"current_usage",
			"currentUsage",
		]) ||
			numberFrom(data, [
				"inputTokens",
				"outputTokens",
				"promptTokens",
				"completionTokens",
				"totalTokens",
				"sessionTotalTokens",
			]) !== undefined
	);
}

function isCompactionPart(part: JsonRecord): boolean {
	const type = partType(part);
	if (type.includes("compact") || type.includes("compaction")) {
		return true;
	}
	const data = partData(part);
	return Boolean(
		firstRecord(data, [
			"compact_boundary",
			"compactBoundary",
			"compaction",
			"context_compaction",
			"contextCompaction",
		])
	);
}

function normalizeTrigger(value: unknown): CompactionMarker["trigger"] {
	if (typeof value !== "string") {
		return "unknown";
	}
	const normalized = value.toLowerCase();
	if (normalized.includes("auto")) {
		return "auto";
	}
	if (normalized.includes("manual") || normalized.includes("user")) {
		return "manual";
	}
	return "unknown";
}

function readCompaction(part: JsonRecord): CompactionMarker | null {
	if (!isCompactionPart(part)) {
		return null;
	}
	const data = partData(part);
	const boundary =
		firstRecord(data, [
			"compact_boundary",
			"compactBoundary",
			"compaction",
			"context_compaction",
			"contextCompaction",
		]) ?? data;
	const records = [boundary, data, part];
	return {
		postTokens: nonNegative(
			numberFromRecords(records, [
				"postTokens",
				"post_tokens",
				"tokensAfter",
				"tokens_after",
			])
		),
		preTokens: nonNegative(
			numberFromRecords(records, [
				"preTokens",
				"pre_tokens",
				"tokensBefore",
				"tokens_before",
			])
		),
		trigger: normalizeTrigger(
			stringFromRecords(records, [
				"trigger",
				"compactionTrigger",
				"compaction_trigger",
				"reason",
			])
		),
	};
}

function readContext(
	root: JsonRecord,
	type: string,
	records: readonly (JsonRecord | null)[]
): Pick<
	TurnSample,
	| "contextInput"
	| "contextLength"
	| "contextOutput"
	| "contextUsableWindow"
	| "contextWindow"
> {
	const contextWindow = firstRecord(root, ["context_window", "contextWindow"]);
	const currentUsage = firstRecord(root, ["current_usage", "currentUsage"]);
	const nestedCurrentUsage = firstRecord(contextWindow ?? {}, [
		"current_usage",
		"currentUsage",
	]);
	const contextRecords = [
		nestedCurrentUsage,
		currentUsage,
		contextWindow,
		...records,
		root,
	];
	const reportedUsed = numberFromRecords(contextRecords, [
		"used",
		"tokens",
		"currentTokens",
		"current_tokens",
		"contextLength",
		"context_length",
	]);
	const contextInput = numberFromRecords(contextRecords, [
		"totalInputTokens",
		"total_input_tokens",
	]);
	const contextOutput = numberFromRecords(contextRecords, [
		"totalOutputTokens",
		"total_output_tokens",
	]);
	const windowFromContext = numberFrom(contextWindow, [
		"context_window_size",
		"contextWindowSize",
		"windowSize",
		"window_size",
		"size",
	]);
	const acpWindow =
		type === "data-acp-usage" ? numberFrom(root, ["total", "size"]) : undefined;
	const usableWindow = numberFromRecords(contextRecords, [
		"usableWindow",
		"usable_window",
		"usableContextWindow",
		"usable_context_window",
	]);
	return {
		contextInput: nonNegative(contextInput),
		contextLength: nonNegative(
			reportedUsed ??
				(contextInput !== undefined && contextOutput !== undefined
					? contextInput + contextOutput
					: undefined)
		),
		contextOutput: nonNegative(contextOutput),
		contextUsableWindow: nonNegative(usableWindow),
		contextWindow: nonNegative(windowFromContext ?? acpWindow),
	};
}

function readTurnSample(
	part: JsonRecord,
	fallbackTimestamp?: number
): TurnSample | null {
	if (!isStatsPart(part)) {
		return null;
	}
	const type = partType(part);
	const root = partData(part);
	const usage = firstRecord(root, ["usage", "usageSnapshot", "usage_snapshot"]);
	const context = firstRecord(root, ["context_window", "contextWindow"]);
	const currentUsage = firstRecord(root, ["current_usage", "currentUsage"]);
	const cost = firstRecord(root, ["cost", "costInfo", "cost_info"]);
	const records = [root, usage, currentUsage, context, cost];
	const inputCumulative = numberFrom(root, [
		"sessionTotalInputTokens",
		"session_total_input_tokens",
		"totalInputTokens",
	]);
	const outputCumulative = numberFrom(root, [
		"sessionTotalOutputTokens",
		"session_total_output_tokens",
		"totalOutputTokens",
	]);
	const totalCumulative = numberFrom(root, [
		"sessionTotalTokens",
		"session_total_tokens",
		"cumulativeTotalTokens",
	]);
	const cacheReadCumulative = numberFrom(root, [
		"sessionTotalCacheReadTokens",
		"session_total_cache_read_tokens",
		"sessionTotalCachedTokens",
	]);
	const cacheWriteCumulative = numberFrom(root, [
		"sessionTotalCacheWriteTokens",
		"session_total_cache_write_tokens",
	]);
	const cacheRead = numberFromRecords(records, [
		"cacheReadTokens",
		"cachedReadTokens",
		"cachedTokens",
		"cache_read_tokens",
		"cached_read_tokens",
		"cached_tokens",
	]);
	const cacheWrite = numberFromRecords(records, [
		"cacheWriteTokens",
		"cachedWriteTokens",
		"cache_write_tokens",
		"cached_write_tokens",
		"cache_creation_input_tokens",
	]);
	const input = numberFromRecords(records, [
		"inputTokens",
		"promptTokens",
		"input_tokens",
		"prompt_tokens",
	]);
	const output = numberFromRecords(records, [
		"outputTokens",
		"completionTokens",
		"output_tokens",
		"completion_tokens",
	]);
	const total = numberFromRecords(records, ["totalTokens", "total_tokens"]);
	const durationMs = numberFromRecords(records, ["durationMs", "duration_ms"]);
	const inputSpeed = numberFromRecords(records, [
		"inputSpeed",
		"promptPerSecond",
		"prompt_per_second",
	]);
	const outputSpeed = numberFromRecords(records, [
		"outputSpeed",
		"tokensPerSecond",
		"tokens_per_second",
	]);
	const costCumulative = numberFrom(root, [
		"sessionCostAmount",
		"session_cost_amount",
		"cumulativeCost",
	]);
	const costAmount = numberFromRecords(records, [
		"costAmount",
		"cost_amount",
		"cost",
		"amount",
		"value",
	]);
	const costCurrency = stringFromRecords(records, [
		"sessionCostCurrency",
		"costCurrency",
		"currency",
		"cost_currency",
	]);
	const contextValues = readContext(root, type, records);
	const observedAt =
		timestamp(numberFrom(root, ["observedAt", "observed_at", "timestamp"])) ??
		timestamp(stringFrom(root, ["observedAt", "observed_at", "timestamp"])) ??
		fallbackTimestamp;
	const hasValue = [
		input,
		output,
		total,
		cacheRead,
		cacheWrite,
		inputCumulative,
		outputCumulative,
		totalCumulative,
		contextValues.contextLength,
		contextValues.contextWindow,
		costAmount,
		costCumulative,
	].some((value) => value !== undefined);
	return hasValue
		? {
				...contextValues,
				cacheRead: nonNegative(cacheRead),
				cacheReadCumulative: nonNegative(cacheReadCumulative),
				cacheWrite: nonNegative(cacheWrite),
				cacheWriteCumulative: nonNegative(cacheWriteCumulative),
				costAmount: nonNegative(costAmount),
				costCumulative: nonNegative(costCumulative),
				costCurrency,
				durationMs: nonNegative(durationMs),
				input: nonNegative(input),
				inputCumulative: nonNegative(inputCumulative),
				inputSpeed: nonNegative(inputSpeed),
				observedAt,
				output: nonNegative(output),
				outputCumulative: nonNegative(outputCumulative),
				outputSpeed: nonNegative(outputSpeed),
				total: nonNegative(total),
				totalCumulative: nonNegative(totalCumulative),
			}
		: null;
}

function mergeSample(left: TurnSample, right: TurnSample): TurnSample {
	return {
		cacheRead: right.cacheRead ?? left.cacheRead,
		cacheReadCumulative: right.cacheReadCumulative ?? left.cacheReadCumulative,
		cacheWrite: right.cacheWrite ?? left.cacheWrite,
		cacheWriteCumulative:
			right.cacheWriteCumulative ?? left.cacheWriteCumulative,
		contextInput: right.contextInput ?? left.contextInput,
		contextLength: right.contextLength ?? left.contextLength,
		contextOutput: right.contextOutput ?? left.contextOutput,
		contextUsableWindow: right.contextUsableWindow ?? left.contextUsableWindow,
		contextWindow: right.contextWindow ?? left.contextWindow,
		costAmount: right.costAmount ?? left.costAmount,
		costCumulative: right.costCumulative ?? left.costCumulative,
		costCurrency: right.costCurrency ?? left.costCurrency,
		durationMs: right.durationMs ?? left.durationMs,
		input: right.input ?? left.input,
		inputCumulative: right.inputCumulative ?? left.inputCumulative,
		inputSpeed: right.inputSpeed ?? left.inputSpeed,
		observedAt: right.observedAt ?? left.observedAt,
		output: right.output ?? left.output,
		outputCumulative: right.outputCumulative ?? left.outputCumulative,
		outputSpeed: right.outputSpeed ?? left.outputSpeed,
		total: right.total ?? left.total,
		totalCumulative: right.totalCumulative ?? left.totalCumulative,
	};
}

function turnSamples(message: StatsMessage): TurnSample[] {
	const parts = (message.parts ?? [])
		.map(asRecord)
		.filter((part): part is JsonRecord => part !== null);
	const latestById = new Map<string, JsonRecord>();
	for (const part of parts) {
		if (!isStatsPart(part)) {
			continue;
		}
		const data = partData(part);
		const id =
			stringFrom(data, ["id"]) ?? (partType(part) || `part-${latestById.size}`);
		latestById.set(id, part);
	}
	const sample = [...latestById.values()]
		.map((part) => readTurnSample(part, messageTimestamp(message)))
		.filter((value): value is TurnSample => value !== null)
		.reduce<TurnSample | null>(
			(accumulator, value) =>
				accumulator ? mergeSample(accumulator, value) : value,
			null
		);
	return sample ? [sample] : [];
}

function allParts(messages: readonly StatsMessage[]): JsonRecord[] {
	const parts: JsonRecord[] = [];
	for (const message of messages) {
		for (const part of message.parts ?? []) {
			const record = asRecord(part);
			if (record) {
				parts.push(record);
			}
		}
	}
	return parts;
}

function sum(values: readonly (number | undefined)[]): number | undefined {
	const present = values.filter(
		(value): value is number => value !== undefined
	);
	return present.length === 0
		? undefined
		: present.reduce((total, value) => total + value, 0);
}

function latest(values: readonly (number | undefined)[]): number | undefined {
	for (let index = values.length - 1; index >= 0; index -= 1) {
		const value = values[index];
		if (value !== undefined) {
			return value;
		}
	}
	return undefined;
}

function cumulativeOrSum(
	samples: readonly TurnSample[],
	cumulative: (sample: TurnSample) => number | undefined,
	perTurn: (sample: TurnSample) => number | undefined
): number | undefined {
	const cumulativeValue = latest(samples.map(cumulative));
	return cumulativeValue ?? sum(samples.map(perTurn));
}

function modelContextHint(modelName: string | undefined): number | undefined {
	if (!modelName) {
		return undefined;
	}
	const match = modelName.match(
		/([0-9]+(?:\.[0-9]+)?)\s*([kmb])(?=$|[\s\])_-])/i
	);
	if (!match) {
		return undefined;
	}
	const amount = Number(match[1]);
	const unit = (match[2] ?? "").toLowerCase();
	const multiplier =
		unit === "m" ? 1_000_000 : unit === "b" ? 1_000_000_000 : 1000;
	return Number.isFinite(amount) && amount > 0
		? Math.round(amount * multiplier)
		: undefined;
}

export function resolveContextFallback(explicit?: number): number {
	if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) {
		return Math.floor(explicit);
	}
	const importMetaLike = import.meta as ImportMeta & {
		env?: Record<string, unknown>;
	};
	const processLike = (
		globalThis as typeof globalThis & {
			process?: { env?: Record<string, unknown> };
		}
	).process;
	const configured = asFiniteNumber(
		importMetaLike.env?.CCSTATUSLINE_CONTEXT_SIZE_FALLBACK ??
			processLike?.env?.CCSTATUSLINE_CONTEXT_SIZE_FALLBACK
	);
	return configured !== undefined && configured > 0
		? Math.floor(configured)
		: 200_000;
}

function deriveUsageSummary(
	usage: StatsUsageSnapshot | null | undefined
): StatsUsageSummary | undefined {
	if (!usage?.available) {
		return undefined;
	}
	const byLabel = (
		predicate: (window: StatsUsageWindow) => boolean
	): StatsUsageMetric | undefined => {
		const window = usage.windows.find(predicate);
		return window
			? {
					percent: Math.max(0, Math.min(100, window.usedPercent)),
					resetAt: window.resetsAt,
					windowSeconds: window.windowSeconds,
				}
			: undefined;
	};
	const normalized = (window: StatsUsageWindow) =>
		`${window.label} ${window.model ?? ""}`.toLowerCase();
	const session = byLabel((window) => normalized(window).includes("session"));
	const weekly = byLabel(
		(window) =>
			normalized(window).includes("weekly") &&
			!normalized(window).includes("sonnet") &&
			!normalized(window).includes("opus") &&
			!normalized(window).includes("fable") &&
			!window.model
	);
	const scoped = (name: string) =>
		byLabel((window) => normalized(window).includes(name));
	const extra = usage.meters.find((meter) =>
		meter.label.toLowerCase().includes("extra")
	);
	const first = extra?.values[0];
	const second = extra?.values[1];
	const extraUsed =
		usage.extraUsageUsd ??
		(first?.kind === "dollars" ? first.number : undefined);
	const extraCap = second?.kind === "dollars" ? second.number : undefined;
	const extraRemaining =
		extraCap !== undefined && extraUsed !== undefined
			? Math.max(0, extraCap - extraUsed)
			: undefined;
	const extraUtilization =
		extraCap !== undefined && extraCap > 0 && extraUsed !== undefined
			? Math.max(0, Math.min(100, (extraUsed / extraCap) * 100))
			: undefined;
	return {
		blockReset: session ?? null,
		blockTimer: session ?? null,
		extraCurrency:
			first?.kind === "dollars"
				? (first.currency ?? (usage.extraUsageUsd === null ? null : "USD"))
				: null,
		extraRemaining,
		extraUsed,
		extraUtilization,
		fable: scoped("fable"),
		opus: scoped("opus"),
		session,
		sonnet: scoped("sonnet"),
		weekly,
		weeklyReset: weekly ?? null,
	};
}

function speedForSamples(
	samples: readonly TurnSample[],
	value: (sample: TurnSample) => number | undefined,
	declaredSpeed: (sample: TurnSample) => number | undefined,
	preferDeclared = false
): number | undefined {
	if (preferDeclared) {
		const declaredSamples = samples.filter(
			(sample) =>
				value(sample) !== undefined && declaredSpeed(sample) !== undefined
		);
		const declaredTokens = sum(declaredSamples.map(value));
		if (declaredTokens !== undefined && declaredTokens > 0) {
			const declaredWeighted = declaredSamples.reduce(
				(total, sample) =>
					total + (declaredSpeed(sample) ?? 0) * (value(sample) ?? 0),
				0
			);
			if (declaredWeighted > 0) {
				return declaredWeighted / declaredTokens;
			}
		}
	}
	const measuredTokens = sum(samples.map(value));
	const measuredDuration = sum(
		samples.map((sample) =>
			sample.durationMs && sample.durationMs > 0 ? sample.durationMs : undefined
		)
	);
	if (
		measuredTokens !== undefined &&
		measuredDuration !== undefined &&
		measuredDuration > 0
	) {
		return (measuredTokens / measuredDuration) * 1000;
	}
	const weighted = samples.reduce((total, sample) => {
		const speed = declaredSpeed(sample);
		const tokens = value(sample);
		return speed === undefined ? total : total + speed * (tokens ?? 1);
	}, 0);
	const weight = sum(samples.map((sample) => value(sample) ?? 1));
	return weight && weighted > 0 ? weighted / weight : undefined;
}

function deriveCompactions(
	messages: readonly StatsMessage[]
): CompactionSummary & { latestPostTokens?: number } {
	const summary: CompactionSummary & { latestPostTokens?: number } = {
		auto: 0,
		count: 0,
		manual: 0,
		reclaimedTokens: 0,
		unknown: 0,
	};
	for (const part of allParts(messages)) {
		const marker = readCompaction(part);
		if (!marker) {
			continue;
		}
		summary.count += 1;
		summary[marker.trigger] += 1;
		if (marker.preTokens !== undefined && marker.postTokens !== undefined) {
			summary.reclaimedTokens += Math.max(
				0,
				marker.preTokens - marker.postTokens
			);
		}
		if (marker.postTokens !== undefined) {
			summary.latestPostTokens = marker.postTokens;
		}
	}
	return summary;
}

function deriveSteps(messages: readonly StatsMessage[]): number {
	const seen = new Set<string>();
	let anonymous = 0;
	for (const part of allParts(messages)) {
		const type = partType(part);
		const data = partData(part);
		const isTool =
			type.startsWith("tool-") ||
			type === "dynamic-tool" ||
			type === "tool-call" ||
			type === "tool-result";
		if (isTool && type !== "tool-step") {
			const id = stringFrom(data, ["toolCallId", "tool_call_id", "id"]);
			if (id) {
				seen.add(id);
			} else if (!(type.includes("input") || type.includes("output"))) {
				anonymous += 1;
			}
		}
		const details = firstRecord(data, ["details"]);
		const nested =
			details?.ryuSteps ?? data.ryuSteps ?? data.ryu_steps ?? data.steps;
		if (Array.isArray(nested)) {
			anonymous += nested.length;
		}
	}
	return seen.size + anonymous;
}

function withPreferences(options: DeriveStatsOptions): StatsPreferences {
	return { ...DEFAULT_STATS_PREFERENCES, ...options.preferences };
}

export function deriveSessionStats(
	messages: readonly StatsMessage[],
	options: DeriveStatsOptions = {}
): SessionStats {
	const preferences = withPreferences(options);
	const samples = messages
		.filter((message) => message.role === "assistant")
		.flatMap(turnSamples);
	const now = options.now ?? Date.now();
	const rollingWindow = Math.max(
		0,
		Math.min(120, preferences.rollingWindowSeconds)
	);
	const measuredSamples =
		rollingWindow === 0
			? samples
			: samples.filter(
					(sample) =>
						sample.observedAt === undefined ||
						sample.observedAt >= now - rollingWindow * 1000
				);
	const inputTokens = cumulativeOrSum(
		samples,
		(sample) => sample.inputCumulative,
		(sample) => sample.input
	);
	const outputTokens = cumulativeOrSum(
		samples,
		(sample) => sample.outputCumulative,
		(sample) => sample.output
	);
	const contextInputFallback = latest(
		samples.map((sample) => sample.contextInput)
	);
	const contextOutputFallback = latest(
		samples.map((sample) => sample.contextOutput)
	);
	const resolvedInputTokens = inputTokens ?? contextInputFallback;
	const resolvedOutputTokens = outputTokens ?? contextOutputFallback;
	const totalTokens = cumulativeOrSum(
		samples,
		(sample) => sample.totalCumulative,
		(sample) =>
			sample.total ??
			(sample.input !== undefined && sample.output !== undefined
				? sample.input + sample.output
				: undefined)
	);
	const latestCacheSample = [...samples]
		.reverse()
		.find(
			(sample) =>
				sample.cacheRead !== undefined || sample.cacheWrite !== undefined
		);
	const cacheRead =
		preferences.cacheScope === "latest"
			? latestCacheSample?.cacheRead
			: cumulativeOrSum(
					samples,
					(sample) => sample.cacheReadCumulative,
					(sample) => sample.cacheRead
				);
	const cacheWrite =
		preferences.cacheScope === "latest"
			? latestCacheSample?.cacheWrite
			: cumulativeOrSum(
					samples,
					(sample) => sample.cacheWriteCumulative,
					(sample) => sample.cacheWrite
				);
	const cacheDenominator =
		preferences.cacheScope === "latest"
			? (latestCacheSample?.input ??
				(latestCacheSample?.cacheRead !== undefined &&
				latestCacheSample.cacheWrite !== undefined
					? latestCacheSample.cacheRead + latestCacheSample.cacheWrite
					: undefined))
			: resolvedInputTokens;
	const cacheActivity = (cacheRead ?? 0) + (cacheWrite ?? 0);
	const cacheTimerSample = [...samples]
		.reverse()
		.find(
			(sample) =>
				(sample.cacheRead ?? 0) + (sample.cacheWrite ?? 0) > 0 &&
				sample.observedAt !== undefined
		);
	const cacheTimer =
		preferences.showCacheTimer && cacheTimerSample?.observedAt !== undefined
			? (() => {
					const anchorAt = cacheTimerSample.observedAt as number;
					const ttlMs = preferences.cacheTimerTtlMinutes * 60_000;
					const remainingMs = anchorAt + ttlMs - now;
					return {
						anchorAt,
						remainingMs: options.isMainChainActive
							? null
							: Math.max(0, remainingMs),
						state: options.isMainChainActive
							? ("hot" as const)
							: remainingMs > 0
								? ("countdown" as const)
								: ("cold" as const),
					};
				})()
			: undefined;
	const latestContext = [...samples]
		.reverse()
		.find(
			(sample) =>
				sample.contextLength !== undefined ||
				sample.contextWindow !== undefined ||
				sample.contextInput !== undefined
		);
	const compactions = deriveCompactions(messages);
	const orderedParts = allParts(messages);
	const latestCompactionIndex = orderedParts.reduce(
		(index, part, partIndex) => (readCompaction(part) ? partIndex : index),
		-1
	);
	const contextAfterCompaction =
		latestCompactionIndex >= 0
			? orderedParts
					.slice(latestCompactionIndex + 1)
					.map((part) => readTurnSample(part))
					.filter((sample): sample is TurnSample => sample !== null)
					.reverse()
					.find(
						(sample) =>
							sample.contextLength !== undefined ||
							sample.contextWindow !== undefined ||
							sample.contextInput !== undefined
					)
			: undefined;
	const contextLength =
		contextAfterCompaction?.contextLength ??
		(latestCompactionIndex >= 0
			? compactions.latestPostTokens
			: latestContext?.contextLength);
	const contextWindow =
		contextAfterCompaction?.contextWindow ??
		(latestCompactionIndex < 0 ? latestContext?.contextWindow : undefined) ??
		modelContextHint(options.modelName) ??
		(options.contextWindowOverride && options.contextWindowOverride > 0
			? Math.floor(options.contextWindowOverride)
			: undefined) ??
		resolveContextFallback(options.contextFallback);
	const usableWindow =
		contextAfterCompaction?.contextUsableWindow ??
		latestContext?.contextUsableWindow ??
		contextWindow;
	const contextPercent =
		contextLength !== undefined && contextWindow > 0
			? Math.max(0, Math.min(100, (contextLength / contextWindow) * 100))
			: undefined;
	const contextPercentUsable =
		contextLength !== undefined && usableWindow > 0
			? Math.max(0, Math.min(100, (contextLength / usableWindow) * 100))
			: undefined;
	const inputSpeed = speedForSamples(
		measuredSamples,
		(sample) => sample.input,
		(sample) => sample.inputSpeed,
		true
	);
	const outputSpeed = speedForSamples(
		measuredSamples,
		(sample) => sample.output,
		(sample) => sample.outputSpeed
	);
	const totalSpeed = speedForSamples(
		measuredSamples,
		(sample) =>
			sample.total ??
			(sample.input !== undefined && sample.output !== undefined
				? sample.input + sample.output
				: undefined),
		(sample) => {
			const total = (sample.inputSpeed ?? 0) + (sample.outputSpeed ?? 0);
			return total > 0 ? total : undefined;
		}
	);
	const costCumulative = latest(samples.map((sample) => sample.costCumulative));
	const costAmount =
		costCumulative ?? sum(samples.map((sample) => sample.costAmount));
	const costCurrency = [...samples]
		.reverse()
		.find((sample) => sample.costCurrency)?.costCurrency;
	const usage = deriveUsageSummary(options.usage);
	return {
		cacheHitRate:
			cacheActivity > 0 ? (cacheRead ?? 0) / cacheActivity : undefined,
		cacheRead,
		cacheReadShare:
			cacheRead !== undefined && cacheDenominator && cacheDenominator > 0
				? cacheRead / cacheDenominator
				: undefined,
		cacheTimer,
		cacheWrite,
		cacheWriteShare:
			cacheWrite !== undefined && cacheDenominator && cacheDenominator > 0
				? cacheWrite / cacheDenominator
				: undefined,
		compactions: {
			auto: compactions.auto,
			count: compactions.count,
			manual: compactions.manual,
			reclaimedTokens: compactions.reclaimedTokens,
			unknown: compactions.unknown,
		},
		contextLength,
		contextPercent,
		contextPercentUsable,
		contextRemaining:
			contextLength === undefined
				? undefined
				: Math.max(0, contextWindow - contextLength),
		contextWindow,
		costAmount,
		costCurrency,
		inputSpeed,
		inputTokens: resolvedInputTokens,
		outputSpeed,
		outputTokens: resolvedOutputTokens,
		steps: deriveSteps(messages),
		totalSpeed,
		totalTokens,
		turns: messages.filter((message) => message.role === "user").length,
		usage,
	};
}

export function formatStatsCount(value: number | undefined): string | null {
	if (value === undefined || !Number.isFinite(value)) {
		return null;
	}
	if (Math.abs(value) >= 1_000_000) {
		return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
	}
	if (Math.abs(value) >= 1000) {
		return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;
	}
	return Math.round(value).toLocaleString();
}

export function formatStatsDuration(milliseconds: number): string {
	const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${seconds % 60}s`;
}
