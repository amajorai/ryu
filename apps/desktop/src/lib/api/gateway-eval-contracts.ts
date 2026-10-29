import { z } from "zod";
import type {
	EvalCaseScore,
	EvalRunAggregate,
	EvalRunResult,
	ModelEvalResult,
} from "./gateway.ts";

/** Existing Gateway eval result fields; additive owner fields pass through untouched. */
const assertionResultSchema = z.object({
	detail: z.string(),
	executed: z.boolean().optional(),
	kind: z.string(),
	pass: z.boolean(),
	score: z.number(),
});
const evaluatorScoreSchema = z.object({
	category: z.string(),
	detail: z.string(),
	executed: z.boolean(),
	id: z.string(),
	pass: z.boolean(),
	score: z.number(),
});
const evaluatorAggregateSchema = z.object({
	executedCount: z.number(),
	meanScore: z.number(),
	passRate: z.number(),
});
export const evalCaseScoreSchema = z
	.object({
		assertion_score: z.number(),
		assertions: z.array(assertionResultSchema),
		assertions_pass: z.boolean(),
		cache_hit: z.boolean().optional(),
		context: z.json().optional(),
		cost_micro_usd: z.number().nullable().optional(),
		description: z.string().optional(),
		error: z.string().nullable().optional(),
		evaluators: z.array(evaluatorScoreSchema).optional(),
		id: z.string().optional(),
		input_tokens: z.number().optional(),
		latency_available: z.boolean().optional(),
		latency_ms: z.number().optional(),
		latency_score: z.number(),
		metadata: z.record(z.string(), z.json()).optional(),
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
		vars: z.record(z.string(), z.json()).optional(),
	})
	.passthrough() satisfies z.ZodType<EvalCaseScore>;
export const evalRunAggregateSchema = z
	.object({
		assertion_pass_rate: z.number().optional(),
		evaluators: z.record(z.string(), evaluatorAggregateSchema).optional(),
		latency_available_cases: z.number().optional(),
		mean_latency: z.number(),
		mean_overall: z.number(),
		mean_substring_match: z.number().nullable(),
		mean_token_efficiency: z.number(),
		policy_available_cases: z.number().optional(),
		policy_pass_rate: z.number(),
		total_cases: z.number(),
		total_cost_micro_usd: z.number().nullable().optional(),
		total_input_tokens: z.number().optional(),
		total_output_tokens: z.number().optional(),
	})
	.passthrough() satisfies z.ZodType<EvalRunAggregate>;
export const modelEvalResultSchema = z
	.object({
		aggregate: evalRunAggregateSchema,
		cases: z.array(evalCaseScoreSchema),
		model: z.string(),
	})
	.passthrough() satisfies z.ZodType<ModelEvalResult>;
export const evalRunResultSchema = z
	.object({
		aggregate: evalRunAggregateSchema,
		cases: z.array(evalCaseScoreSchema),
		finished_at: z.string().optional(),
		models: z.array(modelEvalResultSchema).optional(),
		run_id: z.string().optional(),
		started_at: z.string().optional(),
		tags: z.record(z.string(), z.string()).optional(),
	})
	.passthrough() satisfies z.ZodType<EvalRunResult>;
