import { appJsonValueSchema } from "@ryuhq/core-client/app-request-json.ts";
import { z } from "zod";
import { MODALITIES } from "./gateway-provider-config.ts";
import { PROVIDER_POOL_STRATEGIES } from "./gateway-routing-config.ts";

export const gatewayConfigRoutingShape = {
	routing: z
		.object({
			// Open `ProviderId` registry ids (gateway `RoutingView`), not the closed
			// `ProviderKind` union: `modal`, `replicate`, `fal` and custom providers
			// are valid routing targets.
			default_provider: z.string(),
			eval_routing: z
				.object({
					candidates: z.array(z.string()),
					enabled: z.boolean(),
					explore_ratio: z.number(),
				})
				.passthrough()
				.optional(),
			fallback_chain: z.array(z.string()),
			modality_map: z
				.partialRecord(
					z.enum(MODALITIES),
					z
						.object({
							model: z.union([z.string(), z.null()]).optional(),
							provider: z.string(),
						})
						.passthrough()
				)
				.optional(),
			model_map: z.record(
				z.string(),
				z
					.object({
						provider: z.string(),
						provider_model: z.union([z.string(), z.null()]).optional(),
					})
					.passthrough()
			),
			provider_pools: z
				.record(
					z.string(),
					z
						.object({
							auto_weights: z
								.union([
									z
										.object({
											quota: z.number(),
											health: z.number(),
											cost_inv: z.number(),
											latency_inv: z.number(),
											task_fit: z.number(),
											stability: z.number(),
											tier_priority: z.number(),
											tier_affinity: z.number(),
											specificity_match: z.number(),
											context_affinity: z.number(),
											cache_affinity: z.number(),
											session_availability: z.number(),
											reset_window_affinity: z.number(),
											connection_density: z.number(),
											quality: z.number(),
											reliability: z.number(),
										})
										.passthrough()
										.partial(),
									z.null(),
								])
								.optional(),
							execution: z
								.object({
									grace_ms: z.number(),
									leg_timeout_ms: z.number(),
									max_output_bytes: z.number(),
									quorum: z.number(),
									total_timeout_ms: z.number(),
								})
								.passthrough()
								.optional(),
							judge: z
								.union([
									z
										.object({ provider: z.string(), model: z.string() })
										.passthrough(),
									z.null(),
								])
								.optional(),
							members: z.array(
								z
									.object({
										provider: z.string(),
										model: z.string(),
										priority: z.number(),
										weight: z.number(),
										enabled: z.boolean(),
										last_resort: z.boolean().optional(),
										context_tokens: z.union([z.number(), z.null()]).optional(),
									})
									.passthrough()
							),
							sticky_limit: z.number().optional(),
							strategy: z.enum(PROVIDER_POOL_STRATEGIES),
							wait_for_cooldown_ms: z.number().optional(),
						})
						.passthrough()
				)
				.optional(),
			provider_tiers: z.record(z.string(), z.number()).optional(),
			smart_routing: z
				.object({
					cache_by_session: z.boolean(),
					classifier_model: z.string(),
					default_model: z.union([z.string(), z.null()]).optional(),
					embedding_model: z.string(),
					enabled: z.boolean(),
					escalation_confirmations: z.number().optional(),
					escalation_judge_model: z.string().optional(),
					escalation_message_chars: z.number().optional(),
					escalation_recent_message_window: z.number().optional(),
					escalation_strong_model: z.string().optional(),
					escalation_weak_model: z.string().optional(),
					random_seed: z.union([z.number(), z.null()]).optional(),
					router_type: z
						.union([
							z.literal("llm_classifier"),
							z.literal("passthrough"),
							z.literal("random"),
							z.literal("stage_router"),
							z.literal("escalation"),
						])
						.optional(),
					rules: z.array(
						z
							.object({
								description: z.string(),
								model: z.string(),
								weight: z.number().optional(),
							})
							.passthrough()
					),
					similarity_threshold: z.number(),
					stage_capable_model: z.string().optional(),
					stage_confidence_threshold: z.number().optional(),
					stage_efficient_model: z.string().optional(),
					stage_picker: z
						.union([z.literal("capable_first"), z.literal("efficient_first")])
						.optional(),
					stage_recent_message_window: z.number().optional(),
					strategy: z.union([
						z.literal("llm"),
						z.literal("embedding"),
						z.literal("keyword"),
					]),
					timeout_ms: z.number(),
				})
				.passthrough()
				.optional(),
		})
		.passthrough()
		.nullish(),
	strategyCapabilities: z
		.object({
			chat: z.array(z.enum(PROVIDER_POOL_STRATEGIES)),
			web: z.array(z.enum(PROVIDER_POOL_STRATEGIES)),
		})
		.passthrough()
		.optional(),
	tools: z
		.object({
			always_on: z.array(appJsonValueSchema),
			describe_top_n: z.number(),
			enabled: z.boolean(),
			max_rounds: z.number(),
			parallel_reads: z.number().optional(),
			profiles: z.record(
				z.string(),
				z
					.object({
						allow: z.array(z.string()),
						deny: z.array(z.string()),
						unrestricted: z.boolean(),
					})
					.passthrough()
			),
		})
		.passthrough()
		.optional(),
	webServiceSchema: z.literal(1).optional(),
};
