import { z } from "zod";
import { ALERT_TIERS } from "./gateway-routing-config.ts";

export const gatewayConfigPolicyShape = {
	acp: z
		.object({
			active_agents: z.number().optional(),
			auto_max_parallel_agents: z.number().optional(),
			effective_max_parallel_agents: z.number().optional(),
			hardware: z
				.object({
					cpu_cores: z.number(),
					physical_cores: z.number(),
					total_ram_bytes: z.number(),
				})
				.passthrough()
				.optional(),
			idle_timeout_minutes: z.number(),
			keep_computer_awake: z.boolean(),
			max_parallel_agents: z.union([z.number(), z.null()]),
		})
		.passthrough()
		.nullish(),
	appliedProviderRevision: z.union([z.string(), z.null()]).optional(),
	auth: z
		.object({
			api_keys: z.array(
				z
					.object({
						allowed_operations: z
							.array(
								z.union([
									z.literal("inference"),
									z.literal("web_search"),
									z.literal("web_fetch"),
								])
							)
							.optional(),
						key: z.string(),
						name: z.string(),
						org_id: z.union([z.string(), z.null()]).optional(),
						system_relay: z.boolean().optional(),
						team_id: z.union([z.string(), z.null()]).optional(),
						trusted_forwarder: z.boolean(),
					})
					.passthrough()
			),
			require_auth: z.boolean(),
		})
		.passthrough(),
	budgets: z
		.object({
			agents: z.record(
				z.string(),
				z
					.object({
						action: z.union([
							z.literal("notify"),
							z.literal("downgrade"),
							z.literal("restrict"),
							z.literal("stop"),
						]),
						alert: z.enum(ALERT_TIERS).optional(),
						downgrade_to: z.union([z.string(), z.null()]).optional(),
						include: z
							.object({
								media: z.boolean(),
								model: z.boolean(),
								tools: z.boolean(),
							})
							.passthrough()
							.optional(),
						limit: z.number(),
						restrict_max_tokens: z.number().optional(),
					})
					.passthrough()
			),
			session: z
				.object({
					action: z.union([
						z.literal("notify"),
						z.literal("downgrade"),
						z.literal("restrict"),
						z.literal("stop"),
					]),
					alert: z.enum(ALERT_TIERS).optional(),
					downgrade_to: z.union([z.string(), z.null()]).optional(),
					include: z
						.object({
							media: z.boolean(),
							model: z.boolean(),
							tools: z.boolean(),
						})
						.passthrough()
						.optional(),
					limit: z.number(),
					restrict_max_tokens: z.number().optional(),
				})
				.passthrough(),
			users: z.record(
				z.string(),
				z
					.object({
						action: z.union([
							z.literal("notify"),
							z.literal("downgrade"),
							z.literal("restrict"),
							z.literal("stop"),
						]),
						alert: z.enum(ALERT_TIERS).optional(),
						downgrade_to: z.union([z.string(), z.null()]).optional(),
						include: z
							.object({
								media: z.boolean(),
								model: z.boolean(),
								tools: z.boolean(),
							})
							.passthrough()
							.optional(),
						limit: z.number(),
						restrict_max_tokens: z.number().optional(),
					})
					.passthrough()
			),
		})
		.passthrough()
		.partial()
		.nullish(),
	computer_use: z
		.object({
			locked_use: z.boolean(),
			security_key: z.boolean().optional(),
		})
		.passthrough()
		.nullish(),
	configRevision: z.union([z.string(), z.null()]).optional(),
	drift: z
		.array(
			z
				.object({
					code: z.string(),
					message: z.string(),
					severity: z.union([
						z.literal("high"),
						z.literal("medium"),
						z.string(),
					]),
				})
				.passthrough()
		)
		.optional(),
	egress: z
		.object({
			assignments: z.record(z.string(), z.string()),
			pools: z.record(
				z.string(),
				z
					.object({
						include_direct: z.boolean(),
						direct_fallback_only: z.boolean().optional(),
						endpoints: z.array(
							z
								.object({
									id: z.string(),
									url: z.string(),
									enabled: z.boolean(),
									priority: z.number().optional(),
									username_env: z.union([z.string(), z.null()]),
									password_env: z.union([z.string(), z.null()]),
								})
								.passthrough()
						),
					})
					.passthrough()
			),
		})
		.passthrough()
		.optional(),
	firewall: z
		.intersection(
			z
				.object({
					alert: z.enum(ALERT_TIERS).optional(),
					custom_patterns: z
						.array(
							z
								.object({
									kind: z.union([
										z.literal("pii"),
										z.literal("secret"),
										z.literal("prompt_injection"),
									]),
									name: z.string(),
									regex: z.string(),
								})
								.passthrough()
						)
						.optional(),
					enabled: z.boolean().optional(),
					evaluators: z
						.array(
							z
								.object({
									enabled: z.boolean(),
									id: z.string(),
									inlineAction: z
										.union([
											z.union([
												z.literal("block"),
												z.literal("warn_and_continue"),
												z.literal("sanitize"),
											]),
											z.null(),
										])
										.optional(),
									locked: z.boolean().optional(),
									offline: z
										.union([
											z
												.object({
													judgeModel: z
														.union([z.string(), z.null()])
														.optional(),
													threshold: z.number(),
												})
												.passthrough(),
											z.null(),
										])
										.optional(),
								})
								.passthrough()
						)
						.optional(),
					inspector: z
						.object({
							action: z.union([
								z.literal("block"),
								z.literal("warn_and_continue"),
								z.literal("sanitize"),
							]),
							enabled: z.boolean(),
							min_chars: z.number(),
							mode: z.union([
								z.literal("injection"),
								z.literal("dlp"),
								z.literal("both"),
							]),
							model: z.string(),
							timeout_ms: z.number(),
						})
						.passthrough()
						.optional(),
					locked_fields: z.array(z.string()).optional(),
					log_detections: z.boolean().optional(),
					policy: z
						.union([
							z.literal("block"),
							z.literal("warn_and_continue"),
							z.literal("sanitize"),
						])
						.optional(),
					redact_pii: z.boolean().optional(),
					redact_secrets: z.boolean().optional(),
					scan_inbound: z.boolean().optional(),
					scan_outbound: z.boolean().optional(),
					wrap_untrusted_tool_results: z.boolean().optional(),
				})
				.passthrough(),
			z
				.object({
					alert: z.enum(ALERT_TIERS),
					custom_patterns: z.array(
						z
							.object({
								kind: z.union([
									z.literal("pii"),
									z.literal("secret"),
									z.literal("prompt_injection"),
								]),
								name: z.string(),
								regex: z.string(),
							})
							.passthrough()
					),
					inspector: z
						.object({
							action: z.union([
								z.literal("block"),
								z.literal("warn_and_continue"),
								z.literal("sanitize"),
							]),
							enabled: z.boolean(),
							min_chars: z.number(),
							mode: z.union([
								z.literal("injection"),
								z.literal("dlp"),
								z.literal("both"),
							]),
							model: z.string(),
							timeout_ms: z.number(),
						})
						.passthrough(),
					locked_fields: z.array(z.string()),
				})
				.passthrough()
				.partial()
		)
		.nullish(),
};
