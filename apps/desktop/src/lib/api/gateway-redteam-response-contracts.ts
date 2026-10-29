// Response schemas for online eval scores and red-team runs that `gateway.ts`
// reads. Split out of `gateway.ts`; the public client API stays there.

import { appJsonValueSchema } from "@ryuhq/core-client/app-request-json.ts";
import { z } from "zod";
import type { EvalCaseScore, RedTeamRunResult } from "./gateway.ts";
import { retainValidatedResponse } from "./gateway-status-response-contracts.ts";

export const rawStatusResponseSchema9: z.ZodType<{
	kind: "online_score";
	score: EvalCaseScore;
	scored_at: string;
}> = retainValidatedResponse(
	z
		.object({
			kind: z.literal("online_score"),
			score: z
				.object({
					assertion_score: z.number(),
					assertions: z.array(
						z
							.object({
								detail: z.string(),
								executed: z.boolean().optional(),
								kind: z.string(),
								pass: z.boolean(),
								score: z.number(),
							})
							.passthrough()
					),
					assertions_pass: z.boolean(),
					cache_hit: z.boolean().optional(),
					context: appJsonValueSchema.optional(),
					cost_micro_usd: z.union([z.number(), z.null()]).optional(),
					description: z.string().optional(),
					error: z.union([z.string(), z.null()]).optional(),
					evaluators: z
						.array(
							z
								.object({
									category: z.string(),
									detail: z.string(),
									executed: z.boolean(),
									id: z.string(),
									pass: z.boolean(),
									score: z.number(),
								})
								.passthrough()
						)
						.optional(),
					id: z.string().optional(),
					input_tokens: z.number().optional(),
					latency_available: z.boolean().optional(),
					latency_ms: z.number().optional(),
					latency_score: z.number(),
					metadata: z.record(z.string(), appJsonValueSchema).optional(),
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
					substring_match: z.union([z.number(), z.null()]),
					token_efficiency: z.number(),
					total_tokens: z.number().optional(),
					vars: z.record(z.string(), appJsonValueSchema).optional(),
				})
				.passthrough(),
			scored_at: z.string(),
		})
		.passthrough()
);

export const fetchClassifyWeightsPresentResponseSchema0: z.ZodType<RedTeamRunResult> =
	retainValidatedResponse(
		z
			.object({
				campaign_id: z.string(),
				model: z.string(),
				result: z
					.object({
						aggregate: z
							.object({
								assertion_pass_rate: z.number().optional(),
								evaluators: z
									.record(
										z.string(),
										z
											.object({
												executedCount: z.number(),
												meanScore: z.number(),
												passRate: z.number(),
											})
											.passthrough()
									)
									.optional(),
								latency_available_cases: z.number().optional(),
								mean_latency: z.number(),
								mean_overall: z.number(),
								mean_substring_match: z.union([z.number(), z.null()]),
								mean_token_efficiency: z.number(),
								policy_available_cases: z.number().optional(),
								policy_pass_rate: z.number(),
								total_cases: z.number(),
								total_cost_micro_usd: z
									.union([z.number(), z.null()])
									.optional(),
								total_input_tokens: z.number().optional(),
								total_output_tokens: z.number().optional(),
							})
							.passthrough(),
						cases: z.array(
							z
								.object({
									assertion_score: z.number(),
									assertions: z.array(
										z
											.object({
												detail: z.string(),
												executed: z.boolean().optional(),
												kind: z.string(),
												pass: z.boolean(),
												score: z.number(),
											})
											.passthrough()
									),
									assertions_pass: z.boolean(),
									cache_hit: z.boolean().optional(),
									context: appJsonValueSchema.optional(),
									cost_micro_usd: z.union([z.number(), z.null()]).optional(),
									description: z.string().optional(),
									error: z.union([z.string(), z.null()]).optional(),
									evaluators: z
										.array(
											z
												.object({
													category: z.string(),
													detail: z.string(),
													executed: z.boolean(),
													id: z.string(),
													pass: z.boolean(),
													score: z.number(),
												})
												.passthrough()
										)
										.optional(),
									id: z.string().optional(),
									input_tokens: z.number().optional(),
									latency_available: z.boolean().optional(),
									latency_ms: z.number().optional(),
									latency_score: z.number(),
									metadata: z.record(z.string(), appJsonValueSchema).optional(),
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
									substring_match: z.union([z.number(), z.null()]),
									token_efficiency: z.number(),
									total_tokens: z.number().optional(),
									vars: z.record(z.string(), appJsonValueSchema).optional(),
								})
								.passthrough()
						),
						finished_at: z.string().optional(),
						models: z
							.array(
								z
									.object({
										aggregate: z
											.object({
												assertion_pass_rate: z.number().optional(),
												evaluators: z
													.record(
														z.string(),
														z
															.object({
																executedCount: z.number(),
																meanScore: z.number(),
																passRate: z.number(),
															})
															.passthrough()
													)
													.optional(),
												latency_available_cases: z.number().optional(),
												mean_latency: z.number(),
												mean_overall: z.number(),
												mean_substring_match: z.union([z.number(), z.null()]),
												mean_token_efficiency: z.number(),
												policy_available_cases: z.number().optional(),
												policy_pass_rate: z.number(),
												total_cases: z.number(),
												total_cost_micro_usd: z
													.union([z.number(), z.null()])
													.optional(),
												total_input_tokens: z.number().optional(),
												total_output_tokens: z.number().optional(),
											})
											.passthrough(),
										cases: z.array(
											z
												.object({
													assertion_score: z.number(),
													assertions: z.array(
														z
															.object({
																detail: z.string(),
																executed: z.boolean().optional(),
																kind: z.string(),
																pass: z.boolean(),
																score: z.number(),
															})
															.passthrough()
													),
													assertions_pass: z.boolean(),
													cache_hit: z.boolean().optional(),
													context: appJsonValueSchema.optional(),
													cost_micro_usd: z
														.union([z.number(), z.null()])
														.optional(),
													description: z.string().optional(),
													error: z.union([z.string(), z.null()]).optional(),
													evaluators: z
														.array(
															z
																.object({
																	category: z.string(),
																	detail: z.string(),
																	executed: z.boolean(),
																	id: z.string(),
																	pass: z.boolean(),
																	score: z.number(),
																})
																.passthrough()
														)
														.optional(),
													id: z.string().optional(),
													input_tokens: z.number().optional(),
													latency_available: z.boolean().optional(),
													latency_ms: z.number().optional(),
													latency_score: z.number(),
													metadata: z
														.record(z.string(), appJsonValueSchema)
														.optional(),
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
													substring_match: z.union([z.number(), z.null()]),
													token_efficiency: z.number(),
													total_tokens: z.number().optional(),
													vars: z
														.record(z.string(), appJsonValueSchema)
														.optional(),
												})
												.passthrough()
										),
										model: z.string(),
									})
									.passthrough()
							)
							.optional(),
						run_id: z.string().optional(),
						started_at: z.string().optional(),
						tags: z.record(z.string(), z.string()).optional(),
					})
					.passthrough()
					.optional(),
				strategies: z.array(
					z
						.object({
							detail: z.string(),
							evaluator: z.string(),
							id: z.string(),
							name: z.string(),
							protected: z.boolean(),
						})
						.passthrough()
				),
				summary: z
					.object({
						needs_attention: z.number(),
						protected: z.number(),
						total: z.number(),
					})
					.passthrough(),
			})
			.passthrough()
	);
