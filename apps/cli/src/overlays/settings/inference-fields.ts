type FieldKind = "number" | "text" | "string-array" | "object" | "logit-bias";

export interface SamplingField {
	group: string;
	hint?: string;
	integer?: boolean;
	key: string;
	kind: FieldKind;
	label: string;
	max?: number;
	min?: number;
}

function field(
	key: string,
	label: string,
	options: Omit<SamplingField, "key" | "label"> = {
		group: "Sampling",
		kind: "number",
	}
): SamplingField {
	return { key, label, ...options };
}

const COMMON_FIELDS: readonly SamplingField[] = [
	field("temperature", "Temperature", {
		group: "Sampling",
		hint: "0 = deterministic, higher = more random",
		kind: "number",
		max: 2,
		min: 0,
	}),
	field("top_p", "Top P", {
		group: "Sampling",
		kind: "number",
		max: 1,
		min: 0,
	}),
	field("max_tokens", "Max tokens", {
		group: "Sampling",
		integer: true,
		kind: "number",
		min: 1,
	}),
	field("seed", "Seed", {
		group: "Sampling",
		hint: "Reproducible output when set",
		integer: true,
		kind: "number",
	}),
	field("stop", "Stop sequences (JSON array)", {
		group: "Sampling",
		hint: 'Example: ["###", "</s>"]',
		kind: "string-array",
	}),
	field("frequency_penalty", "Frequency penalty", {
		group: "Penalties",
		kind: "number",
		max: 2,
		min: -2,
	}),
	field("presence_penalty", "Presence penalty", {
		group: "Penalties",
		kind: "number",
		max: 2,
		min: -2,
	}),
	field("prefill", "Prefill", {
		group: "Output control",
		hint: "Text the assistant reply must start with",
		kind: "text",
	}),
	field("response_format", "Response format (JSON)", {
		group: "Output control",
		hint: 'Example: {"type":"json_object"}',
		kind: "object",
	}),
	field("logit_bias", "Logit bias (JSON)", {
		group: "Output control",
		hint: "Token IDs map to a bias from -100 to 100; -100 bans a token.",
		kind: "logit-bias",
	}),
	field("extra", "Extra body fields (JSON)", {
		group: "Raw passthrough",
		hint: "Merged verbatim into the request body; supported fields depend on the engine.",
		kind: "object",
	}),
];

const EXTENDED_LOCAL_FIELDS: readonly SamplingField[] = [
	field("top_k", "Top K", {
		group: "Sampling",
		hint: "0 = off",
		integer: true,
		kind: "number",
		min: 0,
	}),
	field("min_p", "Min P", {
		group: "Sampling",
		kind: "number",
		max: 1,
		min: 0,
	}),
	field("typical_p", "Typical P", {
		group: "Sampling",
		kind: "number",
		max: 1,
		min: 0,
	}),
	field("top_n_sigma", "Top-N sigma", {
		group: "Sampling",
		kind: "number",
	}),
	field("repeat_penalty", "Repeat penalty", {
		group: "Penalties",
		hint: "1.0 = off",
		kind: "number",
		min: 0,
	}),
	field("repeat_last_n", "Repeat last N", {
		group: "Penalties",
		hint: "Tokens to scan; -1 uses context",
		integer: true,
		kind: "number",
	}),
	field("mirostat", "Mirostat mode", {
		group: "Mirostat",
		integer: true,
		kind: "number",
		max: 2,
		min: 0,
	}),
	field("mirostat_tau", "Mirostat tau", {
		group: "Mirostat",
		kind: "number",
		min: 0,
	}),
	field("mirostat_eta", "Mirostat eta", {
		group: "Mirostat",
		kind: "number",
		min: 0,
	}),
	field("dynatemp_range", "DynaTemp range", {
		group: "Advanced samplers",
		kind: "number",
	}),
	field("dynatemp_exponent", "DynaTemp exponent", {
		group: "Advanced samplers",
		kind: "number",
	}),
	field("xtc_probability", "XTC probability", {
		group: "Advanced samplers",
		kind: "number",
		max: 1,
		min: 0,
	}),
	field("xtc_threshold", "XTC threshold", {
		group: "Advanced samplers",
		kind: "number",
	}),
	field("dry_multiplier", "DRY multiplier", {
		group: "Advanced samplers",
		kind: "number",
	}),
	field("dry_base", "DRY base", {
		group: "Advanced samplers",
		kind: "number",
	}),
	field("dry_allowed_length", "DRY allowed length", {
		group: "Advanced samplers",
		integer: true,
		kind: "number",
	}),
	field("dry_penalty_last_n", "DRY penalty last N", {
		group: "Advanced samplers",
		integer: true,
		kind: "number",
	}),
	field("samplers", "Sampler order", {
		group: "Advanced samplers",
		hint: "Example: penalties;dry;top_k;top_p;min_p;temperature",
		kind: "text",
	}),
	field("grammar", "Grammar (GBNF)", {
		group: "Output control",
		hint: "llama.cpp grammar syntax; only llama.cpp consumes this field.",
		kind: "text",
	}),
];

const OLLAMA_FIELDS: readonly SamplingField[] = [
	field("top_k", "Top K", {
		group: "Ollama Modelfile sampling",
		integer: true,
		kind: "number",
		min: 0,
	}),
	field("min_p", "Min P", {
		group: "Ollama Modelfile sampling",
		kind: "number",
		max: 1,
		min: 0,
	}),
	field("typical_p", "Typical P", {
		group: "Ollama Modelfile sampling",
		kind: "number",
		max: 1,
		min: 0,
	}),
	field("repeat_penalty", "Repeat penalty", {
		group: "Ollama Modelfile sampling",
		kind: "number",
		min: 0,
	}),
	field("repeat_last_n", "Repeat window", {
		group: "Ollama Modelfile sampling",
		integer: true,
		kind: "number",
		min: 0,
	}),
	field("mirostat", "Mirostat mode", {
		group: "Ollama Modelfile sampling",
		integer: true,
		kind: "number",
		max: 2,
		min: 0,
	}),
	field("mirostat_tau", "Mirostat tau", {
		group: "Ollama Modelfile sampling",
		kind: "number",
	}),
	field("mirostat_eta", "Mirostat eta", {
		group: "Ollama Modelfile sampling",
		kind: "number",
	}),
];

const MLX_FIELDS: readonly SamplingField[] = [
	field("repeat_penalty", "Repetition penalty", {
		group: "MLX",
		kind: "number",
	}),
];

export function fieldsForEngine(engineName: string): readonly SamplingField[] {
	const engine = engineName.trim().toLowerCase().replace(/^acp:/u, "");
	if (["llamacpp", "vllm", "sglang"].includes(engine)) {
		return [
			...COMMON_FIELDS.slice(0, 4),
			...EXTENDED_LOCAL_FIELDS.slice(0, 4),
			COMMON_FIELDS[4],
			...COMMON_FIELDS.slice(5, 7),
			...EXTENDED_LOCAL_FIELDS.slice(4, 6),
			...EXTENDED_LOCAL_FIELDS.slice(6, 18),
			...COMMON_FIELDS.slice(7),
			...EXTENDED_LOCAL_FIELDS.slice(18),
		];
	}
	if (engine === "ollama") {
		return [
			...COMMON_FIELDS.slice(0, 4),
			...OLLAMA_FIELDS.slice(0, 3),
			...COMMON_FIELDS.slice(4, 7),
			...OLLAMA_FIELDS.slice(3, 8),
			...COMMON_FIELDS.slice(7),
		];
	}
	if (engine === "mlx") {
		return [
			...COMMON_FIELDS.slice(0, 4),
			...COMMON_FIELDS.slice(4, 7),
			...MLX_FIELDS,
			...COMMON_FIELDS.slice(7),
		];
	}
	return COMMON_FIELDS;
}

const ENGINE_LAUNCH_ADAPTERS = new Set([
	"llamacpp",
	"ollama",
	"vllm",
	"sglang",
	"mlx",
	"mlx-vlm",
	"mlx-serve",
	"omlx",
	"apfel",
	"mesh-llm",
]);

const LLAMACPP_LAUNCH_FIELDS: readonly SamplingField[] = [
	field("ctx_size", "Context size", {
		group: "Context & hardware",
		hint: "--ctx-size · applies on the next engine start",
		integer: true,
		kind: "number",
		min: 0,
	}),
	field("gpu_layers", "GPU layers", {
		group: "Context & hardware",
		hint: "-ngl · -1 means all layers on GPU",
		integer: true,
		kind: "number",
		min: -1,
	}),
	field("threads", "Threads", {
		group: "Context & hardware",
		integer: true,
		kind: "number",
	}),
	field("extra_args", "Extra launch arguments (JSON array)", {
		group: "Raw launch arguments",
		hint: 'Example: ["--mlock", "--no-mmap"]',
		kind: "string-array",
	}),
];

const OLLAMA_LAUNCH_FIELDS: readonly SamplingField[] = [
	field("ctx_size", "Context size", {
		group: "Context & hardware",
		hint: "Modelfile PARAMETER num_ctx",
		integer: true,
		kind: "number",
		min: 0,
	}),
	field("gpu_layers", "GPU layers", {
		group: "Context & hardware",
		hint: "Modelfile PARAMETER num_gpu · -1 means all layers on GPU",
		integer: true,
		kind: "number",
		min: -1,
	}),
	field("threads", "Threads", {
		group: "Context & hardware",
		hint: "Modelfile PARAMETER num_thread",
		integer: true,
		kind: "number",
	}),
];

const VLLM_LAUNCH_FIELDS: readonly SamplingField[] = [
	field("ctx_size", "Context size", {
		group: "Context & hardware",
		hint: "--max-model-len · applies on the next engine start",
		integer: true,
		kind: "number",
		min: 0,
	}),
	field("gpu_memory_utilization", "GPU memory utilization", {
		group: "Context & hardware",
		kind: "number",
		max: 1,
		min: 0,
	}),
	field("tensor_parallel", "Tensor parallel", {
		group: "Context & hardware",
		integer: true,
		kind: "number",
	}),
	field("extra_args", "Extra launch arguments (JSON array)", {
		group: "Raw launch arguments",
		hint: 'Example: ["--disable-log-requests"]',
		kind: "string-array",
	}),
];

const SGLANG_LAUNCH_FIELDS: readonly SamplingField[] = [
	field("ctx_size", "Context size", {
		group: "Context & hardware",
		hint: "--context-length · applies on the next engine start",
		integer: true,
		kind: "number",
		min: 0,
	}),
	field("mem_fraction_static", "Memory fraction static", {
		group: "Context & hardware",
		kind: "number",
		max: 1,
		min: 0,
	}),
	field("tensor_parallel", "Tensor parallel", {
		group: "Context & hardware",
		integer: true,
		kind: "number",
	}),
	field("extra_args", "Extra launch arguments (JSON array)", {
		group: "Raw launch arguments",
		hint: 'Example: ["--disable-cuda-graph"]',
		kind: "string-array",
	}),
];

const RAW_LAUNCH_ARGUMENT_FIELDS: readonly SamplingField[] = [
	field("extra_args", "Extra launch arguments (JSON array)", {
		group: "Raw launch arguments",
		hint: "Arguments are forwarded when Ryu starts this engine.",
		kind: "string-array",
	}),
];

export function launchFieldsForEngine(
	engineName: string
): readonly SamplingField[] {
	const engine = engineName.trim().toLowerCase();
	if (engine === "llamacpp") {
		return LLAMACPP_LAUNCH_FIELDS;
	}
	if (engine === "ollama") {
		return OLLAMA_LAUNCH_FIELDS;
	}
	if (engine === "vllm") {
		return VLLM_LAUNCH_FIELDS;
	}
	if (engine === "sglang") {
		return SGLANG_LAUNCH_FIELDS;
	}
	return ENGINE_LAUNCH_ADAPTERS.has(engine) ? RAW_LAUNCH_ARGUMENT_FIELDS : [];
}
