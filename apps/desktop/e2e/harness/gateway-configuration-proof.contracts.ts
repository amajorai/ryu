import { z } from "zod";
import { ALERT_TIERS, MODALITIES } from "../../src/lib/api/gateway.ts";

const provider = z.enum([
	"openai",
	"anthropic",
	"local",
	"openrouter",
	"core",
	"genai",
	"mistral",
	"huggingface",
	"nvidia",
	"together",
	"fireworks",
]);
export const routingProofSchema = z.object({
	default_provider: provider,
	fallback_chain: z.array(provider),
	model_map: z.record(
		z.string(),
		z.object({
			provider: z.string(),
			provider_model: z.string().nullable().optional(),
		})
	),
	modality_map: z
		.partialRecord(
			z.enum(MODALITIES),
			z.object({
				provider: z.string(),
				model: z.string().nullable().optional(),
			})
		)
		.optional(),
	provider_tiers: z.record(z.string(), z.number()).optional(),
	eval_routing: z
		.object({
			candidates: z.array(z.string()),
			enabled: z.boolean(),
			explore_ratio: z.number(),
		})
		.optional(),
	smart_routing: z
		.object({
			cache_by_session: z.boolean(),
			classifier_model: z.string(),
			embedding_model: z.string(),
			enabled: z.boolean(),
			rules: z.array(
				z.object({
					description: z.string(),
					model: z.string(),
					weight: z.number().optional(),
				})
			),
			similarity_threshold: z.number(),
			strategy: z.enum(["llm", "embedding", "keyword"]),
			timeout_ms: z.number(),
		})
		.optional(),
});
export const firewallProofSchema = z.object({
	alert: z.enum(ALERT_TIERS).optional(),
	custom_patterns: z
		.array(
			z.object({
				kind: z.enum(["pii", "secret", "prompt_injection"]),
				name: z.string(),
				regex: z.string(),
			})
		)
		.optional(),
	enabled: z.boolean(),
	inspector: z
		.object({
			action: z.enum(["block", "warn_and_continue", "sanitize"]),
			enabled: z.boolean(),
			min_chars: z.number(),
			mode: z.enum(["injection", "dlp", "both"]),
			model: z.string(),
			timeout_ms: z.number(),
		})
		.optional(),
	locked_fields: z.array(z.string()).optional(),
	log_detections: z.boolean(),
	policy: z.enum(["block", "warn_and_continue", "sanitize"]),
	redact_pii: z.boolean(),
	redact_secrets: z.boolean(),
	scan_inbound: z.boolean(),
	scan_outbound: z.boolean(),
	wrap_untrusted_tool_results: z.boolean().optional(),
});
export const doctorProofSchema = z.object({
	counts: z.object({
		errors: z.number(),
		warnings: z.number(),
		info: z.number(),
	}),
	findings: z.array(
		z.object({
			canAutoFix: z.boolean(),
			category: z.string(),
			checkId: z.string(),
			detail: z.string(),
			recommendedAction: z.string().optional(),
			settingPath: z.string().optional(),
			severity: z.enum(["error", "warning", "info"]),
			summary: z.string(),
		})
	),
	generatedAt: z.number().optional(),
	posture: z.string().optional(),
	reachable: z.boolean().optional(),
	rulesetVersion: z.string().optional(),
	schemaVersion: z.string().optional(),
});
