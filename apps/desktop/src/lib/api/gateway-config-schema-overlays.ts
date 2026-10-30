import { z } from "zod";
import { ALERT_TIERS } from "./gateway-routing-config.ts";

export const gatewayConfigOverlaysShape = {
	firewall_agent_overlays: z
		.record(
			z.string(),
			z
				.object({
					alert: z.union([z.enum(ALERT_TIERS), z.null()]).optional(),
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
					enabled: z.union([z.boolean(), z.null()]).optional(),
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
						.union([
							z
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
							z.null(),
						])
						.optional(),
					locked_fields: z.array(z.string()).optional(),
					log_detections: z.union([z.boolean(), z.null()]).optional(),
					policy: z
						.union([
							z.union([
								z.literal("block"),
								z.literal("warn_and_continue"),
								z.literal("sanitize"),
							]),
							z.null(),
						])
						.optional(),
					redact_pii: z.union([z.boolean(), z.null()]).optional(),
					redact_secrets: z.union([z.boolean(), z.null()]).optional(),
					scan_inbound: z.union([z.boolean(), z.null()]).optional(),
					scan_outbound: z.union([z.boolean(), z.null()]).optional(),
					wrap_untrusted_tool_results: z
						.union([z.boolean(), z.null()])
						.optional(),
				})
				.passthrough()
		)
		.nullish(),
	firewall_org_overlays: z
		.record(
			z.string(),
			z
				.object({
					alert: z.union([z.enum(ALERT_TIERS), z.null()]).optional(),
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
					enabled: z.union([z.boolean(), z.null()]).optional(),
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
						.union([
							z
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
							z.null(),
						])
						.optional(),
					locked_fields: z.array(z.string()).optional(),
					log_detections: z.union([z.boolean(), z.null()]).optional(),
					policy: z
						.union([
							z.union([
								z.literal("block"),
								z.literal("warn_and_continue"),
								z.literal("sanitize"),
							]),
							z.null(),
						])
						.optional(),
					redact_pii: z.union([z.boolean(), z.null()]).optional(),
					redact_secrets: z.union([z.boolean(), z.null()]).optional(),
					scan_inbound: z.union([z.boolean(), z.null()]).optional(),
					scan_outbound: z.union([z.boolean(), z.null()]).optional(),
					wrap_untrusted_tool_results: z
						.union([z.boolean(), z.null()])
						.optional(),
				})
				.passthrough()
		)
		.nullish(),
	marketplace_recommendations: z
		.object({
			cadence: z.union([
				z.literal("daily"),
				z.literal("weekly"),
				z.literal("monthly"),
			]),
			enabled: z.boolean(),
		})
		.passthrough()
		.optional(),
	pipeline_stages: z.array(z.string()).optional(),
	providerEpoch: z
		.union([
			z.object({ boot: z.string(), sequence: z.number() }).passthrough(),
			z.null(),
		])
		.optional(),
};
