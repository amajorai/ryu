import { z } from "zod";
import type { StatsEnvironmentObject } from "./stats-environment.mjs";

/**
 * Known native aliases read by the statistics normalizer. Payload fields are
 * independently decoded at consumption; unrelated metadata and native object
 * identity stay with the original carrier. This is not a whole-message schema.
 */
export interface StatsFieldCarrier {
	amount?: unknown;
	cache_creation_input_tokens?: unknown;
	cache_read_tokens?: unknown;
	cache_write_tokens?: unknown;
	cached_read_tokens?: unknown;
	cached_tokens?: unknown;
	cached_write_tokens?: unknown;
	cachedReadTokens?: unknown;
	cachedTokens?: unknown;
	cachedWriteTokens?: unknown;
	cacheReadTokens?: unknown;
	cacheWriteTokens?: unknown;
	compact_boundary?: unknown;
	compactBoundary?: unknown;
	compaction?: unknown;
	compaction_trigger?: unknown;
	compactionTrigger?: unknown;
	completion_tokens?: unknown;
	completionTokens?: unknown;
	context_compaction?: unknown;
	context_length?: unknown;
	context_window?: unknown;
	context_window_size?: unknown;
	contextCompaction?: unknown;
	contextLength?: unknown;
	contextWindow?: unknown;
	contextWindowSize?: unknown;
	cost?: unknown;
	cost_amount?: unknown;
	cost_currency?: unknown;
	cost_info?: unknown;
	costAmount?: unknown;
	costCurrency?: unknown;
	costInfo?: unknown;
	created_at?: unknown;
	createdAt?: unknown;
	cumulativeCost?: unknown;
	cumulativeTotalTokens?: unknown;
	currency?: unknown;
	current_tokens?: unknown;
	current_usage?: unknown;
	currentTokens?: unknown;
	currentUsage?: unknown;
	data?: unknown;
	details?: unknown;
	duration_ms?: unknown;
	durationMs?: unknown;
	id?: unknown;
	input_tokens?: unknown;
	inputSpeed?: unknown;
	inputTokens?: unknown;
	observed_at?: unknown;
	observedAt?: unknown;
	output_tokens?: unknown;
	outputSpeed?: unknown;
	outputTokens?: unknown;
	post_tokens?: unknown;
	postTokens?: unknown;
	pre_tokens?: unknown;
	preTokens?: unknown;
	prompt_per_second?: unknown;
	prompt_tokens?: unknown;
	promptPerSecond?: unknown;
	promptTokens?: unknown;
	reason?: unknown;
	ryu_steps?: unknown;
	ryuSteps?: unknown;
	session_cost_amount?: unknown;
	session_total_cache_read_tokens?: unknown;
	session_total_cache_write_tokens?: unknown;
	session_total_input_tokens?: unknown;
	session_total_output_tokens?: unknown;
	session_total_tokens?: unknown;
	sessionCostAmount?: unknown;
	sessionCostCurrency?: unknown;
	sessionTotalCachedTokens?: unknown;
	sessionTotalCacheReadTokens?: unknown;
	sessionTotalCacheWriteTokens?: unknown;
	sessionTotalInputTokens?: unknown;
	sessionTotalOutputTokens?: unknown;
	sessionTotalTokens?: unknown;
	size?: unknown;
	steps?: unknown;
	timestamp?: unknown;
	tokens?: unknown;
	tokens_after?: unknown;
	tokens_before?: unknown;
	tokens_per_second?: unknown;
	tokensAfter?: unknown;
	tokensBefore?: unknown;
	tokensPerSecond?: unknown;
	tool_call_id?: unknown;
	toolCallId?: unknown;
	total?: unknown;
	total_input_tokens?: unknown;
	total_output_tokens?: unknown;
	total_tokens?: unknown;
	totalInputTokens?: unknown;
	totalOutputTokens?: unknown;
	totalTokens?: unknown;
	trigger?: unknown;
	type?: unknown;
	usable_context_window?: unknown;
	usable_window?: unknown;
	usableContextWindow?: unknown;
	usableWindow?: unknown;
	usage?: unknown;
	usage_snapshot?: unknown;
	usageSnapshot?: unknown;
	used?: unknown;
	value?: unknown;
	window_size?: unknown;
	windowSize?: unknown;
}

export type StatsFieldKey = keyof StatsFieldCarrier;

export const statsFieldCarrierSchema = z.custom<StatsFieldCarrier>(
	(value) => !Array.isArray(value) && z.object({}).safeParse(value).success
);

/** The kind projection preserves native lookup/read order on the original part. */
export const statsPartKindSchema = z.custom<
	StatsFieldCarrier & { type: string }
>((value) => {
	const carrier = statsFieldCarrierSchema.safeParse(value);
	return carrier.success && z.string().safeParse(carrier.data.type).success;
});

/** Preserve legacy finite numeric strings, including radix and exponent forms. */
export const statsFiniteNumberSchema = z.union([
	z.number(),
	z
		.string()
		.refine((value) => value.trim() !== "")
		.transform(Number)
		.pipe(z.number()),
]);

export const statsStringSchema = z.string();

/** Admit the complete native non-null property receiver without replacing primitives by boxes. */
const NativeObject = Object;
const statsEnvironmentObjectSchema = z.custom<StatsEnvironmentObject>(
	(value) => NativeObject(value) === value
);
export const statsEnvironmentReceiverSchema = z.union([
	z.string(),
	z.number(),
	z.nan(),
	z.literal(Number.POSITIVE_INFINITY),
	z.literal(Number.NEGATIVE_INFINITY),
	z.boolean(),
	z.bigint(),
	z.symbol(),
	statsEnvironmentObjectSchema,
]);
