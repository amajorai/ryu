import { z } from "zod";

export const gatewayConfigProvidersShape = {
	providers: z
		.object({
			accountDrainThresholds: z.record(z.string(), z.number()).optional(),
			accountStrategies: z
				.record(
					z.string(),
					z.union([
						z.literal("round_robin"),
						z.literal("quota_first"),
						z.literal("fill_first"),
						z.literal("reset_first"),
					])
				)
				.optional(),
			accounts: z
				.record(
					z.string(),
					z.array(
						z
							.object({
								drainThresholdPercent: z
									.union([z.number(), z.null()])
									.optional(),
								enabled: z.boolean(),
								id: z.string(),
								name: z.string(),
								priority: z.number(),
								source: z
									.union([
										z.literal("stored"),
										z.literal("environment"),
										z.literal("fleet"),
									])
									.optional(),
							})
							.passthrough()
					)
				)
				.optional(),
			anthropic: z.union([
				z
					.object({
						api_key: z.string(),
						api_key_count: z.number().optional(),
						base_url: z.string(),
					})
					.passthrough(),
				z.null(),
			]),
			assemblyai: z
				.union([
					z
						.object({
							api_key: z.string(),
							api_key_count: z.number().optional(),
							base_url: z.string(),
						})
						.passthrough(),
					z.null(),
				])
				.optional(),
			bfl: z
				.union([
					z
						.object({
							api_key: z.string(),
							api_key_count: z.number().optional(),
							base_url: z.string(),
						})
						.passthrough(),
					z.null(),
				])
				.optional(),
			cohere: z
				.union([
					z
						.object({
							api_key: z.string(),
							api_key_count: z.number().optional(),
							base_url: z.string(),
						})
						.passthrough(),
					z.null(),
				])
				.optional(),
			compatible: z
				.record(
					z.string(),
					z
						.object({
							api_key: z.string(),
							api_key_count: z.number().optional(),
							base_url: z.string(),
						})
						.passthrough()
				)
				.optional(),
			core: z.union([
				z
					.object({ base_url: z.string(), has_token: z.boolean() })
					.passthrough(),
				z.null(),
			]),
			deepgram: z
				.union([
					z
						.object({
							api_key: z.string(),
							api_key_count: z.number().optional(),
							base_url: z.string(),
						})
						.passthrough(),
					z.null(),
				])
				.optional(),
			elevenlabs: z
				.union([
					z
						.object({
							api_key: z.string(),
							api_key_count: z.number().optional(),
							base_url: z.string(),
						})
						.passthrough(),
					z.null(),
				])
				.optional(),
			fal: z
				.union([
					z
						.object({
							api_key: z.string(),
							api_key_count: z.number().optional(),
							base_url: z.string(),
						})
						.passthrough(),
					z.null(),
				])
				.optional(),
			genai: z.union([
				z
					.object({
						gemini_account_count: z.number().optional(),
						keys: z.array(z.string()),
						sdk_providers: z
							.array(
								z
									.object({
										account_count: z.number(),
										account_scope: z.union([
											z.literal("openai"),
											z.literal("anthropic"),
											z.literal("openrouter"),
											z.literal("gemini"),
											z.literal("voyage"),
											z.literal("jina"),
											z.literal("mistral"),
											z.literal("huggingface"),
											z.literal("nvidia"),
											z.literal("together"),
											z.literal("fireworks"),
											z.literal("qwen"),
											z.literal("cohere"),
											z.literal("deepgram"),
											z.literal("assemblyai"),
											z.literal("elevenlabs"),
											z.literal("inworld"),
											z.literal("modal"),
											z.literal("replicate"),
											z.literal("fal"),
											z.literal("recraft"),
											z.literal("stability"),
											z.literal("bfl"),
											z.literal("minimax"),
											z.literal("runway"),
											z.literal("topaz"),
											z.templateLiteral(["genai-", z.string()]),
										]),
										accounts: z.array(
											z
												.object({
													id: z.string(),
													source: z.union([
														z.literal("stored"),
														z.literal("environment"),
														z.literal("fleet"),
													]),
												})
												.passthrough()
										),
										activation_error: z
											.union([z.string(), z.null()])
											.optional(),
										auth_kind: z.union([
											z.literal("api_key"),
											z.literal("bearer_token"),
											z.literal("no_auth"),
										]),
										brand: z.string(),
										configured: z.boolean(),
										context: z
											.union([
												z.union([
													z
														.object({ kind: z.literal("default") })
														.passthrough(),
													z
														.object({
															kind: z.literal("vertex"),
															project: z.string(),
															location: z.string(),
														})
														.passthrough(),
													z
														.object({
															kind: z.literal("bedrock_api"),
															region: z.string(),
														})
														.passthrough(),
													z
														.object({
															kind: z.literal("ollama"),
															base_url: z.string(),
														})
														.passthrough(),
												]),
												z.null(),
											])
											.optional(),
										context_kind: z.union([
											z.literal("default"),
											z.literal("vertex"),
											z.literal("bedrock_api"),
											z.literal("ollama"),
										]),
										kind: z.string(),
										label: z.string(),
										operations: z.array(
											z.union([
												z.literal("chat"),
												z.literal("stream"),
												z.literal("image"),
											])
										),
										provider_id: z.string(),
									})
									.passthrough()
							)
							.optional(),
					})
					.passthrough(),
				z.null(),
			]),
			google_tts: z
				.union([
					z
						.object({ account_count: z.number(), mode: z.string() })
						.passthrough(),
					z.null(),
				])
				.optional(),
			inworld: z
				.union([
					z
						.object({
							api_key: z.string(),
							api_key_count: z.number().optional(),
							base_url: z.string(),
						})
						.passthrough(),
					z.null(),
				])
				.optional(),
			local: z.union([
				z.object({ base_url: z.string() }).passthrough(),
				z.null(),
			]),
			minimax: z
				.union([
					z
						.object({
							api_key: z.string(),
							api_key_count: z.number().optional(),
							base_url: z.string(),
						})
						.passthrough(),
					z.null(),
				])
				.optional(),
			modal: z
				.union([
					z
						.object({
							api_key: z.string(),
							api_key_count: z.number().optional(),
							base_url: z.string(),
						})
						.passthrough(),
					z.null(),
				])
				.optional(),
			openai: z.union([
				z
					.object({
						api_key: z.string(),
						api_key_count: z.number().optional(),
						base_url: z.string(),
					})
					.passthrough(),
				z.null(),
			]),
			openrouter: z.union([
				z
					.object({
						api_key: z.string(),
						api_key_count: z.number().optional(),
						base_url: z.string(),
					})
					.passthrough(),
				z.null(),
			]),
			polly: z
				.union([
					z
						.object({
							account_count: z.number(),
							mode: z.string(),
							region: z.string(),
						})
						.passthrough(),
					z.null(),
				])
				.optional(),
			recraft: z
				.union([
					z
						.object({
							api_key: z.string(),
							api_key_count: z.number().optional(),
							base_url: z.string(),
						})
						.passthrough(),
					z.null(),
				])
				.optional(),
			replicate: z
				.union([
					z
						.object({
							api_key: z.string(),
							api_key_count: z.number().optional(),
							base_url: z.string(),
						})
						.passthrough(),
					z.null(),
				])
				.optional(),
			runway: z
				.union([
					z
						.object({
							api_key: z.string(),
							api_key_count: z.number().optional(),
							base_url: z.string(),
						})
						.passthrough(),
					z.null(),
				])
				.optional(),
			stability: z
				.union([
					z
						.object({
							api_key: z.string(),
							api_key_count: z.number().optional(),
							base_url: z.string(),
						})
						.passthrough(),
					z.null(),
				])
				.optional(),
			topaz: z
				.union([
					z
						.object({
							api_key: z.string(),
							api_key_count: z.number().optional(),
							base_url: z.string(),
						})
						.passthrough(),
					z.null(),
				])
				.optional(),
		})
		.passthrough(),
};
