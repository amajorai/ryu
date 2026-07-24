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
	extra?: Record<string, unknown>;
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

/** Per-model engine-launch flags (require an engine restart to take effect). */
export interface LaunchConfig {
	batch_size?: number;
	cache_type_k?: string;
	cache_type_v?: string;
	chat_template?: string;
	chat_template_file?: string;
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
	flash_attn?: "on" | "off" | "auto";
	gpu_layers?: number;
	// vLLM / SGLang.
	gpu_memory_utilization?: number;
	// Chat template (jinja).
	jinja?: boolean;
	kv_cache_dtype?: string;
	max_num_seqs?: number;
	max_running_requests?: number;
	mem_fraction_static?: number;
	mlock?: boolean;
	n_cpu_moe?: number;
	no_mmap?: boolean;
	override_tensor?: string;
	quantization?: string;
	rope_freq_base?: number;
	rope_freq_scale?: number;
	rope_scale?: number;
	// RoPE / YaRN.
	rope_scaling?: string;
	/**
	 * llama.cpp `--spec-type`: "draft-mtp" (multi-token prediction) or an n-gram
	 * variant (ngram-cache | ngram-simple | ngram-map-k | ngram-map-k4v | ngram-mod).
	 */
	spec_type?: string;
	speculative_algorithm?: string;
	speculative_config?: Record<string, unknown>;
	tensor_parallel?: number;
	threads?: number;
	ubatch_size?: number;
}

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
		const json = await request<{ launch_config?: LaunchConfig | null }>(
			target,
			`/api/models/${encodeURIComponent(id)}/launch-config`
		);
		return json.launch_config ?? {};
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
	await request<unknown>(
		target,
		`/api/models/${encodeURIComponent(id)}/launch-config`,
		{ method: "PUT", body: config }
	);
}

/** Engine ids whose OpenAI-compat endpoint accepts the non-standard sampler fields. */
const LOCAL_ENGINES = new Set(["llamacpp", "ollama", "vllm", "sglang"]);
const ACP_PREFIX = /^acp:/;

/** Whether an agent's chat-engine binding is a local engine we can tune fully. */
export function isLocalEngine(engine: string | null | undefined): boolean {
	if (!engine) {
		return false;
	}
	// Lowercase BEFORE stripping so `ACP:llamacpp` and `acp:llamacpp` agree.
	return LOCAL_ENGINES.has(engine.trim().toLowerCase().replace(ACP_PREFIX, ""));
}
