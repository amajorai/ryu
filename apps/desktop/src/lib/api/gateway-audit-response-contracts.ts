// Response schemas for the gateway audit log, budget spend, audit retention
// and eval-run endpoints that `gateway.ts` reads. Split out of `gateway.ts`;
// the public client API stays there.

import { appJsonValueSchema } from "@ryuhq/core-client/app-request-json.ts";
import { z } from "zod";
import type {
	BudgetSpendWireResponse,
	EvalRunResult,
	GatewayAuditWireResponse,
} from "./gateway.ts";
import { retainValidatedResponse } from "./gateway-status-response-contracts.ts";

// Gateway audit rows as they really arrive. Every member is optional because
// an older gateway behind a mixed-version Core omits columns added since
// (prompt-cache counters, eval scores, widget and agent ids, ...), and the
// gateway serializes its SQLite row id as a number. Members that are present
// are still type-checked.
const gatewayAuditEntryWireSchema = z
	.object({
		agent_id: z.union([z.string(), z.null()]),
		api_key: z.union([z.string(), z.null()]),
		backend: z.union([z.string(), z.null()]),
		cache_read_tokens: z.union([z.number(), z.null()]),
		cache_write_tokens: z.union([z.number(), z.null()]),
		command: z.union([z.string(), z.null()]),
		cost_micro_usd: z.union([z.number(), z.null()]),
		duration_ms: z.union([z.number(), z.null()]),
		error: z.union([z.string(), z.null()]),
		eval_score: z.union([z.number(), z.null()]),
		event_type: z.union([z.string(), z.null()]),
		feature: z.union([z.string(), z.null()]),
		id: z.union([z.number(), z.string()]),
		input_tokens: z.union([z.number(), z.null()]),
		latency_ms: z.union([z.number(), z.null()]),
		model: z.union([z.string(), z.null()]),
		output_tokens: z.union([z.number(), z.null()]),
		prompt_cache_outcome: z.union([z.string(), z.null()]),
		prompt_cache_read_tokens: z.union([z.number(), z.null()]),
		prompt_cache_write_tokens: z.union([z.number(), z.null()]),
		provider: z.union([z.string(), z.null()]),
		purpose: z.union([z.string(), z.null()]),
		request_id: z.string(),
		session_id: z.union([z.string(), z.null()]),
		source: z.union([
			z.literal("byok"),
			z.literal("local"),
			z.literal("managed"),
			z.literal("self_hosted"),
			z.literal("unknown"),
		]),
		timestamp: z.string(),
		user_id: z.union([z.string(), z.null()]),
		user_name: z.union([z.string(), z.null()]),
		widget_instance_id: z.union([z.string(), z.null()]),
	})
	.partial()
	.passthrough();

// Core's audit proxy answers 200 `{ reachable: false, error, entries: [] }`
// with no `count` when the gateway is down or audit logging is disabled; the
// codec must accept that body so fetchGatewayAudit can resolve its documented
// empty state instead of throwing.
const gatewayAuditWireSchema = z
	.object({
		count: z.number().optional(),
		entries: z.array(gatewayAuditEntryWireSchema),
		reachable: z.boolean(),
	})
	.passthrough();

export const rawStatusResponseSchema5 = z.custom<GatewayAuditWireResponse>(
	(value) => gatewayAuditWireSchema.safeParse(value).success
);

// Core's budget proxy answers 200 with `limits: {}` both when the gateway is
// unreachable and when it replies non-2xx (and forwards `{}` when a reachable
// gateway omits limits), so every limits member is optional on the wire and
// fetchBudgetSpend normalizes them field by field.
export const rawStatusResponseSchema6: z.ZodType<BudgetSpendWireResponse> =
	retainValidatedResponse(
		z
			.object({
				agents: z.record(z.string(), z.number()),
				currency: z.literal("USD").optional(),
				limits: z
					.object({
						agents: z.record(z.string(), z.number()).optional(),
						session: z.number().optional(),
						users: z.record(z.string(), z.number()).optional(),
					})
					.passthrough()
					.optional(),
				reachable: z.boolean(),
				sessions: z.record(z.string(), z.number()),
				unit: z.literal("micro_usd").optional(),
				users: z.record(z.string(), z.number()),
			})
			.passthrough()
	);

export const rawStatusResponseSchema7 = retainValidatedResponse(
	z.custom<{
		deleted_rows?: number;
		kind?: string;
		max_rows?: number | null;
		retention_days?: number | null;
	}>(
		(value) =>
			z
				.object({
					deleted_rows: z.number().optional(),
					kind: z.string().optional(),
					max_rows: z.union([z.number(), z.null()]).optional(),
					retention_days: z.union([z.number(), z.null()]).optional(),
				})
				.passthrough()
				.safeParse(value).success
	)
);

export const rawStatusResponseSchema8: z.ZodType<EvalRunResult> =
	retainValidatedResponse(
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
						total_cost_micro_usd: z.union([z.number(), z.null()]).optional(),
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
											vars: z.record(z.string(), appJsonValueSchema).optional(),
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
	);
