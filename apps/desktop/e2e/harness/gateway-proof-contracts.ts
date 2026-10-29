import { z } from "zod";

const providerKindSchema = z.enum([
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
const mappingSchema = z
	.object({
		provider: z.string(),
		provider_model: z.string().nullable().optional(),
	})
	.catchall(z.json());
const modalityMappingSchema = z
	.object({ provider: z.string(), model: z.string().optional() })
	.catchall(z.json());
export const smartRoutingProofSchema = z
	.object({
		cache_by_session: z.boolean().optional(),
		classifier_model: z.string().optional(),
		default_model: z.string().nullable().optional(),
		embedding_model: z.string().optional(),
		enabled: z.boolean(),
		escalation_confirmations: z.number().optional(),
		escalation_judge_model: z.string().optional(),
		escalation_message_chars: z.number().optional(),
		escalation_recent_message_window: z.number().optional(),
		escalation_strong_model: z.string().optional(),
		escalation_weak_model: z.string().optional(),
		random_seed: z.number().nullable().optional(),
		router_type: z
			.enum([
				"llm_classifier",
				"passthrough",
				"random",
				"stage_router",
				"escalation",
			])
			.optional(),
		rules: z
			.array(
				z.object({
					description: z.string(),
					model: z.string(),
					weight: z.number().optional(),
				})
			)
			.optional(),
		similarity_threshold: z.number(),
		stage_capable_model: z.string().optional(),
		stage_confidence_threshold: z.number().optional(),
		stage_efficient_model: z.string().optional(),
		stage_picker: z.enum(["capable_first", "efficient_first"]).optional(),
		stage_recent_message_window: z.number().optional(),
		strategy: z.enum(["llm", "embedding", "keyword"]),
		timeout_ms: z.number().optional(),
	})
	.catchall(z.json());
export const gatewayRoutingProofSchema = z
	.object({
		default_provider: providerKindSchema,
		fallback_chain: z.array(providerKindSchema),
		model_map: z.record(z.string(), mappingSchema),
		modality_map: z
			.object({
				image: modalityMappingSchema.optional(),
				video: modalityMappingSchema.optional(),
				tts: modalityMappingSchema.optional(),
				stt: modalityMappingSchema.optional(),
				embedding: modalityMappingSchema.optional(),
			})
			.catchall(z.json())
			.optional(),
		provider_tiers: z.record(z.string(), z.number()).optional(),
		smart_routing: smartRoutingProofSchema.optional(),
		eval_routing: z
			.object({
				candidates: z.array(z.string()),
				enabled: z.boolean(),
				explore_ratio: z.number(),
			})
			.optional(),
	})
	.catchall(z.json());
export const piConfigProofSchema = z
	.object({
		configDir: z.string(),
		model: z.string().nullable(),
		provider: z.string(),
		providerRouting: z.record(z.string(), z.string()).optional(),
		routing: z.string(),
		thinkingLevel: z.string().nullable(),
	})
	.catchall(z.json());
const accountProofSchema = z
	.object({
		accountId: z.string(),
		active: z.boolean(),
		connectionState: z
			.enum([
				"authorized",
				"identity-only",
				"reconnect-required",
				"unavailable",
			])
			.optional(),
		gatewayActive: z.boolean().optional(),
		kind: z.string(),
		label: z.string(),
		needsReauth: z.boolean().optional(),
		updatedAt: z.number(),
	})
	.catchall(z.json());
const providerProofSchema = z
	.object({
		accounts: z.array(accountProofSchema).optional(),
		active: z.boolean().optional(),
		api: z.string(),
		authEnv: z.string(),
		authKind: z.string(),
		configured: z.boolean(),
		custom: z.boolean(),
		id: z.string(),
		label: z.string(),
		modelOverrides: z.record(z.string(), z.boolean()).optional(),
		routing: z.string(),
		routingLocked: z.boolean().optional(),
		suggestedModels: z.array(z.string()),
		supportsDiscovery: z.boolean().optional(),
		supportsOAuth: z.boolean().optional(),
	})
	.catchall(z.json());
export const piCatalogProofSchema = z
	.object({
		apiTypes: z.array(z.string()),
		providers: z.array(providerProofSchema),
		thinkingLevels: z.array(z.string()),
	})
	.catchall(z.json());
