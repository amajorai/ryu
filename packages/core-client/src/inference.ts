// apps/desktop/src/lib/api/inference.ts
//
// Typed client + shapes for the advanced local-model inference settings
// (jan.ai / LM Studio parity). Two layers, two homes:
//
//   - SamplingConfig: per-request generation knobs. Stored per-agent (the agent
//     record's `inference` field) and optionally overridden per chat request.
//     Sent verbatim to Core, which translates field names per engine.
//   - LaunchConfig: per-model engine-launch flags (context size, GPU layers, MoE
//     offload, chat template, speculative decoding, quantization). Stored per
//     model id via the `/api/models/{id}/launch-config` endpoints; applied the
//     next time that model is loaded.
//
// All keys are snake_case to match Core's serde field names so the objects pass
// through with no remapping. Every field is optional: an absent field means
// "leave the engine default".

import { z } from "zod";
import {
	type AppRequestValue,
	appResponseValueSchema,
} from "./app-request-json.ts";
import { type ApiTarget, request } from "./client.ts";

/** Per-request generation params (per-agent defaults; per-request override). */
export interface SamplingConfig {
	dry_allowed_length?: number;
	dry_base?: number;
	dry_multiplier?: number;
	dry_penalty_last_n?: number;
	dynatemp_exponent?: number;
	// llama.cpp advanced research samplers.
	dynatemp_range?: number;
	/** Raw passthrough: arbitrary body fields merged verbatim, overriding the above. */
	extra?: Record<string, AppRequestValue>;
	frequency_penalty?: number;
	max_tokens?: number;
	min_p?: number;
	// llama.cpp / Ollama.
	mirostat?: number;
	mirostat_eta?: number;
	mirostat_tau?: number;
	presence_penalty?: number;
	repeat_last_n?: number;
	repeat_penalty?: number;
	samplers?: string;
	seed?: number;
	stop?: string[];
	temperature?: number;
	// Local-engine extensions (llama.cpp / vLLM / SGLang).
	top_k?: number;
	top_n_sigma?: number;
	top_p?: number;
	typical_p?: number;
	xtc_probability?: number;
	xtc_threshold?: number;
}

/** Validate actual authored generation fields while retaining future JSON metadata. */
export const samplingConfigSchema = z
	.object({
		dry_allowed_length: z.number().optional(),
		dry_base: z.number().optional(),
		dry_multiplier: z.number().optional(),
		dry_penalty_last_n: z.number().optional(),
		dynatemp_exponent: z.number().optional(),
		dynatemp_range: z.number().optional(),
		extra: z.record(z.string(), z.json()).optional(),
		frequency_penalty: z.number().optional(),
		max_tokens: z.number().optional(),
		min_p: z.number().optional(),
		mirostat: z.number().optional(),
		mirostat_eta: z.number().optional(),
		mirostat_tau: z.number().optional(),
		presence_penalty: z.number().optional(),
		repeat_last_n: z.number().optional(),
		repeat_penalty: z.number().optional(),
		samplers: z.string().optional(),
		seed: z.number().optional(),
		stop: z.array(z.string()).optional(),
		temperature: z.number().optional(),
		top_k: z.number().optional(),
		top_n_sigma: z.number().optional(),
		top_p: z.number().optional(),
		typical_p: z.number().optional(),
		xtc_probability: z.number().optional(),
		xtc_threshold: z.number().optional(),
	})
	.catchall(z.json()) satisfies z.ZodType<SamplingConfig>;

/** Per-model engine-launch flags (require an engine restart to take effect). */
export interface LaunchConfig {
	batch_size?: number;
	cache_reuse?: number;
	cache_type_k?: string;
	cache_type_v?: string;
	chat_template?: string;
	chat_template_file?: string;
	cont_batching?: boolean;
	// MoE offload (llama.cpp).
	cpu_moe?: boolean;
	// Context + hardware.
	ctx_size?: number;
	draft_max?: number;
	draft_min?: number;
	// Speculative decoding (draft model / MTP).
	draft_model?: string;
	draft_p_min?: number;
	dtype?: string;
	enable_prefix_caching?: boolean;
	/** Raw passthrough: extra CLI args appended verbatim to the spawn command. */
	extra_args?: string[];
	flash_attn?: string;
	gpu_layers?: number;
	// vLLM / SGLang.
	gpu_memory_utilization?: number;
	// Chat template (jinja).
	jinja?: boolean;
	kv_cache_dtype?: string;
	kv_unified?: boolean;
	max_num_seqs?: number;
	max_running_requests?: number;
	mem_fraction_static?: number;
	mlock?: boolean;
	n_cpu_moe?: number;
	/**
	 * Engine-native options keyed by the catalog from
	 * `GET /api/engines/{engine}/launch-options`.
	 */
	native?: Record<string, AppRequestValue>;
	no_mmap?: boolean;
	override_tensor?: string;
	parallel?: number;
	quantization?: string;
	rope_freq_base?: number;
	rope_freq_scale?: number;
	rope_scale?: number;
	// RoPE / YaRN.
	rope_scaling?: string;
	sleep_idle_secs?: number;
	/**
	 * llama.cpp `--spec-type`: "draft-mtp" (multi-token prediction) or an n-gram
	 * variant (ngram-cache | ngram-simple | ngram-map-k | ngram-map-k4v | ngram-mod).
	 */
	spec_type?: string;
	speculative_algorithm?: string;
	speculative_config?: AppRequestValue;
	tensor_parallel?: number;
	threads?: number;
	ubatch_size?: number;
}

// Complete Rust LaunchConfig fields. Current Core publishes this object directly;
// the older nested launch_config envelope remains accepted for existing nodes.
// Preserve the current client's {} fallback for direct native replies.
const launchConfigFields = z.object({
	ctx_size: z.number().optional(),
	gpu_layers: z.number().optional(),
	batch_size: z.number().optional(),
	ubatch_size: z.number().optional(),
	threads: z.number().optional(),
	flash_attn: z.string().optional(),
	cache_type_k: z.string().optional(),
	cache_type_v: z.string().optional(),
	mlock: z.boolean().optional(),
	no_mmap: z.boolean().optional(),
	sleep_idle_secs: z.number().optional(),
	parallel: z.number().optional(),
	kv_unified: z.boolean().optional(),
	cache_reuse: z.number().optional(),
	cont_batching: z.boolean().optional(),
	cpu_moe: z.boolean().optional(),
	n_cpu_moe: z.number().optional(),
	override_tensor: z.string().optional(),
	jinja: z.boolean().optional(),
	chat_template: z.string().optional(),
	chat_template_file: z.string().optional(),
	spec_type: z.string().optional(),
	draft_model: z.string().optional(),
	draft_max: z.number().optional(),
	draft_min: z.number().optional(),
	draft_p_min: z.number().optional(),
	rope_scaling: z.string().optional(),
	rope_scale: z.number().optional(),
	rope_freq_base: z.number().optional(),
	rope_freq_scale: z.number().optional(),
	gpu_memory_utilization: z.number().optional(),
	mem_fraction_static: z.number().optional(),
	tensor_parallel: z.number().optional(),
	dtype: z.string().optional(),
	quantization: z.string().optional(),
	kv_cache_dtype: z.string().optional(),
	max_num_seqs: z.number().optional(),
	max_running_requests: z.number().optional(),
	enable_prefix_caching: z.boolean().optional(),
	speculative_algorithm: z.string().optional(),
	speculative_config: appResponseValueSchema.optional(),
	extra_args: z.array(z.string()).optional(),
	native: z.record(z.string(), appResponseValueSchema).optional(),
});
const launchResponseFields = launchConfigFields.extend({
	launch_config: launchConfigFields.nullable().optional(),
});
const launchResponseSchema = z.custom<z.output<typeof launchResponseFields>>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		launchResponseFields.safeParse(value).success
);
const savedLaunchResponseFields = z.object({ ok: z.boolean(), id: z.string() });
const savedLaunchResponseSchema = z.custom<
	z.output<typeof savedLaunchResponseFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		savedLaunchResponseFields.safeParse(value).success
);

/**
 * Fetch the saved launch config for a model. Returns an empty object when none
 * is saved, and also degrades to empty when the endpoint is unavailable (the
 * backend may not be deployed yet) so the editor still renders.
 */
export async function getModelLaunchConfig(
	target: ApiTarget,
	id: string
): Promise<LaunchConfig> {
	try {
		const json = await request(
			target,
			`/api/models/${encodeURIComponent(id)}/launch-config`,
			undefined,
			launchResponseSchema
		);
		// Current Core sends the config flat; an older node wraps it (null when
		// nothing is saved, which leaves the flat remainder empty).
		const { launch_config: legacy, ...flat } = json;
		return legacy ?? flat;
	} catch {
		return {};
	}
}

/** Persist the launch config for a model. Applied on the model's next load. */
export async function saveModelLaunchConfig(
	target: ApiTarget,
	id: string,
	config: LaunchConfig
): Promise<void> {
	await request(
		target,
		`/api/models/${encodeURIComponent(id)}/launch-config`,
		{ method: "PUT", body: config },
		savedLaunchResponseSchema
	);
}

/** Engine ids whose OpenAI-compat endpoint accepts the non-standard sampler fields. */
const LOCAL_ENGINES = new Set(["llamacpp", "ollama", "vllm", "sglang"]);
const ACP_PREFIX = /^acp:/;

/** Whether an agent's Chat binding is a local engine we can tune fully. */
export function isLocalEngine(engine: string | null | undefined): boolean {
	if (!engine) {
		return false;
	}
	// Lowercase BEFORE stripping so `ACP:llamacpp` and `acp:llamacpp` agree.
	return LOCAL_ENGINES.has(engine.trim().toLowerCase().replace(ACP_PREFIX, ""));
}
