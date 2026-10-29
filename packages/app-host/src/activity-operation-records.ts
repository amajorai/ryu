import { z } from "zod";
import {
	jsonResponseDocumentSchema,
	jsonResponseValueSchema,
} from "./json-values.ts";

/** Gateway observability replies are forwarded with their original JSON fields.
 * These contracts describe complete client DTOs without imposing retention or
 * scoring policy on Core-owned values. */
function preserveActivityRecord<S extends z.ZodObject>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			jsonResponseDocumentSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}

export const activityAuditEntrySchema = preserveActivityRecord(
	z.object({
		agent_id: z.string().nullable(),
		api_key: z.string().nullable(),
		backend: z.string().nullable(),
		cache_read_tokens: z.number().nullish(),
		cache_write_tokens: z.number().nullish(),
		command: z.string().nullable(),
		cost_micro_usd: z.number().nullable(),
		duration_ms: z.number().nullable(),
		error: z.string().nullable(),
		eval_score: z.number().nullable(),
		event_type: z.string().nullable(),
		feature: z.string().nullable(),
		id: z.string(),
		input_tokens: z.number().nullable(),
		latency_ms: z.number().nullable(),
		model: z.string().nullable(),
		output_tokens: z.number().nullable(),
		prompt_cache_outcome: z.string().nullable(),
		prompt_cache_read_tokens: z.number().nullable(),
		prompt_cache_write_tokens: z.number().nullable(),
		provider: z.string().nullable(),
		request_id: z.string(),
		session_id: z.string().nullable(),
		source: z.string().optional(),
		timestamp: z.string(),
		user_id: z.string().nullable(),
		user_name: z.string().nullable(),
		widget_instance_id: z.string().nullish(),
	})
);
export const activityAuditResponseSchema = preserveActivityRecord(
	z.object({
		count: z.number(),
		entries: z.array(activityAuditEntrySchema),
		reachable: z.boolean(),
	})
);
export type ActivityAuditResponse = z.output<
	typeof activityAuditResponseSchema
>;

export const activityPruneResponseSchema = preserveActivityRecord(
	z.object({
		// Core also forwards its complete unreachable receipt. Preserve both
		// fields alongside the existing native/legacy retention result fields.
		reachable: z.literal(false).optional(),
		error: z.string().optional(),
		deleted_rows: z.number().optional(),
		kind: z.string().optional(),
		max_rows: z.number().nullish(),
		retention_days: z.number().nullish(),
	})
);
export type ActivityPruneResponse = z.output<
	typeof activityPruneResponseSchema
>;

export const activityTraceSpanSchema = preserveActivityRecord(
	z.object({
		argsHash: z.string().nullable(),
		conversationId: z.string(),
		endedAt: z.number().nullable(),
		error: z.string().nullable(),
		id: z.string(),
		kind: z.string(),
		name: z.string(),
		seq: z.number(),
		sessionId: z.string().nullable(),
		startedAt: z.number(),
	})
);
export const activityTraceResponseSchema = preserveActivityRecord(
	z.object({ spans: z.array(activityTraceSpanSchema) })
);
export type ActivityTraceResponse = z.output<
	typeof activityTraceResponseSchema
>;

const assertionResultSchema = preserveActivityRecord(
	z.object({
		detail: z.string(),
		executed: z.boolean().optional(),
		kind: z.string(),
		pass: z.boolean(),
		score: z.number(),
	})
);
const evaluatorScoreSchema = preserveActivityRecord(
	z.object({
		category: z.string(),
		detail: z.string(),
		executed: z.boolean(),
		id: z.string(),
		pass: z.boolean(),
		score: z.number(),
	})
);
const evaluatorAggregateSchema = preserveActivityRecord(
	z.object({
		executedCount: z.number(),
		meanScore: z.number(),
		passRate: z.number(),
	})
);
function activityRecordMap<S extends z.ZodType>(item: S) {
	return z.custom<Record<string, z.output<S>>>((value) => {
		if (
			!(
				jsonResponseDocumentSchema.safeParse(value).success &&
				z.record(z.string(), item).safeParse(value).success
			)
		) {
			return false;
		}
		const prototypeEntry = Object.getOwnPropertyDescriptor(value, "__proto__");
		return !prototypeEntry || item.safeParse(prototypeEntry.value).success;
	});
}

export const activityEvalCaseScoreSchema = preserveActivityRecord(
	z.object({
		assertion_score: z.number(),
		assertions: z.array(assertionResultSchema),
		assertions_pass: z.boolean(),
		cache_hit: z.boolean().optional(),
		context: jsonResponseValueSchema.optional(),
		cost_micro_usd: z.number().nullish(),
		description: z.string().optional(),
		error: z.string().nullish(),
		evaluators: z.array(evaluatorScoreSchema).optional(),
		id: z.string().optional(),
		input_tokens: z.number().optional(),
		latency_available: z.boolean().optional(),
		latency_ms: z.number().optional(),
		latency_score: z.number(),
		metadata: jsonResponseDocumentSchema.optional(),
		model: z.string().optional(),
		output_tokens: z.number().optional(),
		overall: z.number(),
		policy_available: z.boolean().optional(),
		policy_pass: z.boolean(),
		prompt: z.string(),
		prompt_id: z.string().optional(),
		provider: z.string().optional(),
		rendered_prompt: z.string().optional(),
		response_text: z.string(),
		substring_match: z.number().nullable(),
		token_efficiency: z.number(),
		total_tokens: z.number().optional(),
		vars: jsonResponseDocumentSchema.optional(),
	})
);
export type ActivityEvalCaseScore = z.output<
	typeof activityEvalCaseScoreSchema
>;

export const activityEvalAggregateSchema = preserveActivityRecord(
	z.object({
		assertion_pass_rate: z.number().optional(),
		evaluators: activityRecordMap(evaluatorAggregateSchema).optional(),
		latency_available_cases: z.number().optional(),
		mean_latency: z.number(),
		mean_overall: z.number(),
		mean_substring_match: z.number().nullable(),
		mean_token_efficiency: z.number(),
		policy_available_cases: z.number().optional(),
		policy_pass_rate: z.number(),
		total_cases: z.number(),
		total_cost_micro_usd: z.number().nullish(),
		total_input_tokens: z.number().optional(),
		total_output_tokens: z.number().optional(),
	})
);
const modelEvalResultSchema = preserveActivityRecord(
	z.object({
		aggregate: activityEvalAggregateSchema,
		cases: z.array(activityEvalCaseScoreSchema),
		model: z.string(),
	})
);
export const activityEvalResponseSchema = preserveActivityRecord(
	z.object({
		aggregate: activityEvalAggregateSchema,
		cases: z.array(activityEvalCaseScoreSchema),
		finished_at: z.string().optional(),
		models: z.array(modelEvalResultSchema).optional(),
		run_id: z.string().optional(),
		started_at: z.string().optional(),
		tags: activityRecordMap(z.string()).optional(),
	})
);
export type ActivityEvalResponse = z.output<typeof activityEvalResponseSchema>;

export const activityScoreResponseSchema = preserveActivityRecord(
	z.object({
		kind: z.literal("online_score"),
		score: activityEvalCaseScoreSchema,
		scored_at: z.string(),
	})
);
export type ActivityScoreResponse = z.output<
	typeof activityScoreResponseSchema
>;

const redteamStrategySchema = preserveActivityRecord(
	z.object({
		detail: z.string(),
		evaluator: z.string(),
		id: z.string(),
		name: z.string(),
		protected: z.boolean(),
	})
);
export const activityRedteamResponseSchema = preserveActivityRecord(
	z.object({
		campaign_id: z.string(),
		model: z.string(),
		result: activityEvalResponseSchema.optional(),
		strategies: z.array(redteamStrategySchema),
		summary: z.object({
			needs_attention: z.number(),
			protected: z.number(),
			total: z.number(),
		}),
	})
);
export type ActivityRedteamResponse = z.output<
	typeof activityRedteamResponseSchema
>;
