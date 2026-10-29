import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";

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

import { samplingConfigSchema as coreSamplingConfigSchema } from "@ryuhq/core-client/inference.ts";
import { z } from "zod";
import { ApiError, type ApiTarget, request } from "./client.ts";
import {
	type GatewayJsonValue,
	gatewayJsonValueSchema,
} from "./gateway-json-contracts.ts";
import { getPreference, setPreference } from "./preferences.ts";

// Core's `LaunchConfig` fields, shared by the endpoint reply and the persisted
// engine-wide preference (which also retains future JSON-valued keys).
const launchConfigShape = {
	batch_size: z.number().optional(),
	cache_reuse: z.number().optional(),
	cache_type_k: z.string().optional(),
	cache_type_v: z.string().optional(),
	chat_template: z.string().optional(),
	chat_template_file: z.string().optional(),
	cont_batching: z.boolean().optional(),
	cpu_moe: z.boolean().optional(),
	ctx_size: z.number().optional(),
	draft_max: z.number().optional(),
	draft_min: z.number().optional(),
	draft_model: z.string().optional(),
	draft_p_min: z.number().optional(),
	dtype: z.string().optional(),
	enable_prefix_caching: z.boolean().optional(),
	extra_args: z.array(z.string()).optional(),
	flash_attn: z.enum(["on", "off", "auto"]).optional(),
	gpu_layers: z.number().optional(),
	gpu_memory_utilization: z.number().optional(),
	jinja: z.boolean().optional(),
	kv_cache_dtype: z.string().optional(),
	kv_unified: z.boolean().optional(),
	max_num_seqs: z.number().optional(),
	max_running_requests: z.number().optional(),
	mem_fraction_static: z.number().optional(),
	mlock: z.boolean().optional(),
	n_cpu_moe: z.number().optional(),
	native: z.record(z.string(), gatewayJsonValueSchema).optional(),
	no_mmap: z.boolean().optional(),
	override_tensor: z.string().optional(),
	parallel: z.number().optional(),
	quantization: z.string().optional(),
	rope_freq_base: z.number().optional(),
	rope_freq_scale: z.number().optional(),
	rope_scale: z.number().optional(),
	rope_scaling: z.string().optional(),
	sleep_idle_secs: z.number().optional(),
	spec_type: z.string().optional(),
	speculative_algorithm: z.string().optional(),
	speculative_config: z.record(z.string(), gatewayJsonValueSchema).optional(),
	tensor_parallel: z.number().optional(),
	threads: z.number().optional(),
	ubatch_size: z.number().optional(),
};
const getModelLaunchConfigResponseSchema = z.looseObject(launchConfigShape);
const jsonResponseSchema = z.looseObject({
	contextLength: z.union([z.null(), z.number()]).optional(),
});
/** Core's `{ "ok": true }` acknowledgement (sampling save echoes the `id`). */
const okAckSchema = z.looseObject({ ok: z.literal(true) });
const samplingConfigSavedSchema = okAckSchema.extend({ id: z.string() });

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
	extra?: Record<string, GatewayJsonValue>;
	frequency_penalty?: number;
	/** llama.cpp GBNF grammar for constrained decoding (llama.cpp only). */
	grammar?: string;
	/** OpenAI-standard token-id → additive logit bias (~-100..100; -100 bans). */
	logit_bias?: Record<string, number>;
	max_tokens?: number;
	min_p?: number;
	// llama.cpp / Ollama.
	mirostat?: number;
	mirostat_eta?: number;
	mirostat_tau?: number;
	/** Assistant-message prefill: text the model continues from (force a format). */
	prefill?: string;
	presence_penalty?: number;
	repeat_last_n?: number;
	repeat_penalty?: number;
	/** OpenAI-standard structured output, e.g. { type: "json_object" }. */
	response_format?: Record<string, GatewayJsonValue>;
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
	/** Min chunk size reused from the prompt cache via KV shifting (--cache-reuse). */
	cache_reuse?: number;
	cache_type_k?: string;
	cache_type_v?: string;
	chat_template?: string;
	chat_template_file?: string;
	/**
	 * Continuous (dynamic) batching — default ON in modern llama-server. Set
	 * false to emit --no-cont-batching. Leave unset to keep the default.
	 */
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
	flash_attn?: "on" | "off" | "auto";
	gpu_layers?: number;
	// vLLM / SGLang.
	gpu_memory_utilization?: number;
	// Chat template (jinja).
	jinja?: boolean;
	kv_cache_dtype?: string;
	/** Single unified KV buffer shared across slots (--kv-unified). */
	kv_unified?: boolean;
	max_num_seqs?: number;
	max_running_requests?: number;
	mem_fraction_static?: number;
	mlock?: boolean;
	n_cpu_moe?: number;
	/**
	 * Engine-native options keyed by the catalog from
	 * `GET /api/engines/{engine}/launch-options` (see {@link NativeLaunchOption}).
	 */
	native?: Record<string, GatewayJsonValue>;
	no_mmap?: boolean;
	override_tensor?: string;
	/**
	 * Number of server slots = the continuous-batching width (--parallel). More
	 * slots ⇒ higher fan-out throughput, at the cost of shared KV-cache memory.
	 * Unset ⇒ Core picks a memory-aware default at engine spawn.
	 */
	parallel?: number;
	quantization?: string;
	rope_freq_base?: number;
	rope_freq_scale?: number;
	rope_scale?: number;
	// RoPE / YaRN.
	rope_scaling?: string;
	/**
	 * Idle timeout (seconds) before llama-server unloads the model + KV cache
	 * (`--sleep-idle-seconds`). Auto-reloads on the next request. This is a
	 * node-level lifecycle policy, not a per-model tuning knob, so it is
	 * normally resolved from the `engine.llamacpp.sleep-idle-seconds` preference
	 * at spawn rather than persisted here.
	 */
	sleep_idle_secs?: number;
	/**
	 * llama.cpp `--spec-type`: "draft-mtp" (multi-token prediction) or an n-gram
	 * variant (ngram-cache | ngram-simple | ngram-map-k | ngram-map-k4v | ngram-mod).
	 */
	spec_type?: string;
	speculative_algorithm?: string;
	speculative_config?: Record<string, GatewayJsonValue>;
	tensor_parallel?: number;
	threads?: number;
	ubatch_size?: number;
}

const samplingConfigSchema = coreSamplingConfigSchema.extend({
	grammar: z.string().optional(),
	prefill: z.string().optional(),
	logit_bias: z.record(z.string(), z.number()).optional(),
	response_format: z.record(z.string(), gatewayJsonValueSchema).optional(),
}) satisfies z.ZodType<SamplingConfig>;
const launchConfigSchema = z
	.object(launchConfigShape)
	.catchall(gatewayJsonValueSchema) satisfies z.ZodType<LaunchConfig>;

function parsePreferenceConfig<T>(raw: string | null, schema: z.ZodType<T>): T {
	const value: unknown = raw ? JSON.parse(raw) : {};
	const record = z.record(z.string(), gatewayJsonValueSchema).safeParse(value);
	return schema.parse(record.success ? value : {});
}

function engineSamplingPreferenceKey(engineId: string): string {
	return `inference.engine.${engineId}`;
}

function engineLaunchPreferenceKey(engineId: string): string {
	return `model.launch.engine.${engineId}`;
}

/** Read the node-wide sampling defaults for one engine. */
export async function getEngineSamplingConfig(
	target: ApiTarget,
	engineId: string
): Promise<SamplingConfig> {
	return parsePreferenceConfig(
		await getPreference(target, engineSamplingPreferenceKey(engineId)),
		samplingConfigSchema
	);
}

/** Save the node-wide sampling defaults for one engine. */
export async function saveEngineSamplingConfig(
	target: ApiTarget,
	engineId: string,
	config: SamplingConfig
): Promise<void> {
	const saved = await setPreference(
		target,
		engineSamplingPreferenceKey(engineId),
		JSON.stringify(config)
	);
	if (!saved) {
		throw new Error("Could not save engine sampling defaults");
	}
}

/** Read engine-wide launch defaults. They apply to every model served by it. */
export async function getEngineLaunchConfig(
	target: ApiTarget,
	engineId: string
): Promise<LaunchConfig> {
	return parsePreferenceConfig(
		await getPreference(target, engineLaunchPreferenceKey(engineId)),
		launchConfigSchema
	);
}

/** Save engine-wide launch defaults in Core's existing preference contract. */
export async function saveEngineLaunchConfig(
	target: ApiTarget,
	engineId: string,
	config: LaunchConfig
): Promise<void> {
	const saved = await setPreference(
		target,
		engineLaunchPreferenceKey(engineId),
		JSON.stringify(config)
	);
	if (!saved) {
		throw new Error("Could not save engine launch settings");
	}
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
		// Core returns the `LaunchConfig` object directly (not wrapped).
		return await request(
			target,
			`/api/models/${encodeURIComponent(id)}/launch-config`,
			undefined,
			getModelLaunchConfigResponseSchema
		);
	} catch (error) {
		if (error instanceof ApiError && error.status === 404) {
			return {};
		}
		throw error;
	}
}

/**
 * Best-effort context window for a model id via models.dev (cached in Core).
 * Fills the gap for ACP / cloud models that don't have a local launch config.
 * Returns `null` when unknown or unreachable — the composer meter hides.
 */
export async function getModelContextWindow(
	target: ApiTarget,
	model: string
): Promise<number | null> {
	try {
		const json = await request(
			target,
			`/api/models/context-window?model=${encodeURIComponent(model)}`,
			undefined,
			jsonResponseSchema
		);
		const n = json.contextLength;
		return isNativeNumber(n) && n > 0 ? n : null;
	} catch {
		return null;
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
		gatewayJsonValueSchema
	);
}

// ── Native launch option catalogs ─────────────────────────────────────────────
//
// Core describes each local runtime's own flags and server environment as a
// catalog. The settings UI renders from it and stores values under
// `LaunchConfig.native`, so a newly catalogued flag needs no desktop change.

const nativeLaunchKindSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("int"),
		min: z.number().optional(),
		max: z.number().optional(),
	}),
	z.object({
		type: z.literal("float"),
		min: z.number().optional(),
		max: z.number().optional(),
	}),
	z.object({ type: z.literal("text") }),
	z.object({ type: z.literal("bool") }),
	z.object({ type: z.literal("enum"), values: z.array(z.string()) }),
]);

const nativeLaunchOptionSchema = z.object({
	key: z.string(),
	label: z.string(),
	group: z.string(),
	help: z.string(),
	target: z.object({
		type: z.enum(["flag", "env"]),
		name: z.string(),
	}),
	kind: nativeLaunchKindSchema,
});

const engineLaunchOptionsSchema = z.object({
	engine: z.string(),
	options: z.array(nativeLaunchOptionSchema),
});

export type NativeLaunchKind = z.infer<typeof nativeLaunchKindSchema>;
export type NativeLaunchOption = z.infer<typeof nativeLaunchOptionSchema>;

/**
 * Read an engine's native launch option catalog. Returns an empty list when
 * the node predates the endpoint, so the editor still renders typed fields.
 */
export async function getEngineLaunchOptions(
	target: ApiTarget,
	engineId: string
): Promise<NativeLaunchOption[]> {
	try {
		const reply = await request(
			target,
			`/api/engines/${encodeURIComponent(engineId)}/launch-options`,
			undefined,
			engineLaunchOptionsSchema
		);
		return reply.options;
	} catch (error) {
		if (error instanceof ApiError && error.status === 404) {
			return [];
		}
		throw error;
	}
}

/** Engine ids whose OpenAI-compat endpoint accepts the non-standard sampler fields. */
const LOCAL_ENGINES = new Set(["llamacpp", "ollama", "vllm", "sglang"]);
const ACP_PREFIX = /^acp:/;

/** Whether an agent's Chat binding is a local engine we can tune fully. */
export function isLocalEngine(engine: string | null | undefined): boolean {
	if (!engine) {
		return false;
	}
	return LOCAL_ENGINES.has(engine.trim().replace(ACP_PREFIX, "").toLowerCase());
}

// ── Per-model sampling and node presets ────────────────────────────────────────
//
// Per-model sampling applies to local AND cloud models (it rides in the request
// body), layered over engine defaults. Presets are named parameter bundles saved
// once per node; applying one copies its values into a model's settings.

/** Read a model's sampling overrides on this node (`{}` when unset). */
export async function getModelSamplingConfig(
	target: ApiTarget,
	id: string
): Promise<SamplingConfig> {
	return await request(
		target,
		`/api/models/${encodeURIComponent(id)}/sampling-config`,
		undefined,
		samplingConfigSchema
	);
}

/** Save a model's sampling overrides. `{}` clears them. */
export async function saveModelSamplingConfig(
	target: ApiTarget,
	id: string,
	config: SamplingConfig
): Promise<void> {
	await request(
		target,
		`/api/models/${encodeURIComponent(id)}/sampling-config`,
		{ method: "PUT", body: config },
		samplingConfigSavedSchema
	);
}

export interface SamplingFieldSupport {
	fields: string[];
	/** True when `engine` named a local runtime (launch settings apply). */
	local: boolean;
}

const samplingFieldSupportSchema = z.object({
	fields: z.array(z.string()),
	local: z.boolean(),
}) satisfies z.ZodType<SamplingFieldSupport>;

/**
 * The sampling fields a model actually receives: by local engine id, else by
 * the cloud provider id behind the model.
 */
export async function getSamplingFieldSupport(
	target: ApiTarget,
	source: { engine?: string | null; provider?: string | null }
): Promise<SamplingFieldSupport> {
	const params = new URLSearchParams();
	if (source.engine) {
		params.set("engine", source.engine);
	}
	if (source.provider) {
		params.set("provider", source.provider);
	}
	return await request(
		target,
		`/api/inference/sampling-fields?${params.toString()}`,
		undefined,
		samplingFieldSupportSchema
	);
}

export type PresetTarget = "any" | "local" | "cloud";

export interface InferencePreset {
	builtin: boolean;
	created_at: number;
	description?: string;
	id: string;
	/** Engine-launch flags; applied to local models only. */
	launch?: LaunchConfig;
	name: string;
	sampling: SamplingConfig;
	target: PresetTarget;
	updated_at: number;
}

// Core's `InferencePreset`: `description` and `launch` are omitted when unset.
const inferencePresetSchema = z.object({
	builtin: z.boolean(),
	created_at: z.number(),
	description: z.string().optional(),
	id: z.string(),
	launch: launchConfigSchema.optional(),
	name: z.string(),
	sampling: samplingConfigSchema,
	target: z.enum(["any", "local", "cloud"]),
	updated_at: z.number(),
}) satisfies z.ZodType<InferencePreset>;
const inferencePresetListSchema = z.object({
	presets: z.array(inferencePresetSchema).optional(),
});
const inferencePresetResponseSchema = z.object({
	preset: inferencePresetSchema,
});

export type InferencePresetInput = Pick<
	InferencePreset,
	"description" | "launch" | "name" | "sampling" | "target"
>;

/** Built-in and saved presets on this node. */
export async function listInferencePresets(
	target: ApiTarget
): Promise<InferencePreset[]> {
	const json = await request(
		target,
		"/api/inference/presets",
		undefined,
		inferencePresetListSchema
	);
	return json.presets ?? [];
}

/** Save a new preset on this node. */
export async function createInferencePreset(
	target: ApiTarget,
	preset: InferencePresetInput
): Promise<InferencePreset> {
	const json = await request(
		target,
		"/api/inference/presets",
		{ method: "POST", body: preset },
		inferencePresetResponseSchema
	);
	return json.preset;
}

/** Replace a saved preset. Built-in presets are read-only. */
export async function updateInferencePreset(
	target: ApiTarget,
	id: string,
	preset: InferencePresetInput
): Promise<InferencePreset> {
	const json = await request(
		target,
		`/api/inference/presets/${encodeURIComponent(id)}`,
		{ method: "PUT", body: preset },
		inferencePresetResponseSchema
	);
	return json.preset;
}

/** Delete a saved preset. */
export async function deleteInferencePreset(
	target: ApiTarget,
	id: string
): Promise<void> {
	await request(
		target,
		`/api/inference/presets/${encodeURIComponent(id)}`,
		{ method: "DELETE" },
		okAckSchema
	);
}

/** Keep only the sampling fields a model accepts, so any preset applies safely. */
export function retainSamplingFields(
	config: SamplingConfig,
	fields: ReadonlySet<string>
): SamplingConfig {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(config)) {
		if (fields.has(key)) {
			out[key] = value;
		}
	}
	// SAFETY: every retained key came from a `SamplingConfig` with its value intact.
	return out as SamplingConfig;
}

/**
 * Save a preset to one model: sampling filtered to the model's accepted fields,
 * plus the preset's launch flags merged over the model's own (local models
 * only). Returns the sampling that was saved.
 */
export async function applyInferencePreset(
	target: ApiTarget,
	model: { id: string; local: boolean },
	preset: InferencePreset,
	fields: ReadonlySet<string>
): Promise<SamplingConfig> {
	const sampling = retainSamplingFields(preset.sampling, fields);
	await saveModelSamplingConfig(target, model.id, sampling);
	if (model.local && preset.launch) {
		const current = await getModelLaunchConfig(target, model.id);
		await saveModelLaunchConfig(target, model.id, {
			...current,
			...preset.launch,
		});
	}
	return sampling;
}
