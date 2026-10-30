// Launch-config field rules shared by ModelLaunchConfigSection and its
// field-group sections: key types, number validation, and raw-arg copy.

import type { LiteralMessage } from "@ryu/i18n/react";
import { ApiError } from "@/src/lib/api/client.ts";
import type { LaunchConfig } from "@/src/lib/api/inference.ts";

export type Key = keyof LaunchConfig;

/** Engine ids whose launch settings become `llama-server` flags. */
export const LLAMA_SERVER_ENGINES = new Set([
	"llamacpp",
	"llamacpp-embed",
	"llamacpp-rerank",
	"llamacpp-classify",
	"llamacpp-speech",
]);

/**
 * Engines a per-model launch config can apply to, for native options. Engines
 * that read only engine-wide settings (multi-model servers and sidecars) are
 * edited on their engine page instead.
 */
export const MODEL_SCOPE_NATIVE_ENGINES = [
	"llamacpp",
	"vllm",
	"sglang",
	"mlx",
	"mlx-vlm",
];

export type NumberKey = {
	[K in Key]-?: Exclude<LaunchConfig[K], undefined> extends number ? K : never;
}[Key];

export type StringKey = {
	[K in Key]-?: Exclude<LaunchConfig[K], undefined> extends string ? K : never;
}[Key];

export type BooleanKey = {
	[K in Key]-?: Exclude<LaunchConfig[K], undefined> extends boolean ? K : never;
}[Key];

export interface LaunchNumberRule {
	integer?: boolean;
	label: string;
	max?: number;
	min?: number;
}

/** Mesh LLM parses `--draft-max` as a u16; Core drops larger values. */
export const MESH_DRAFT_MAX_LIMIT = 65_535;

const LAUNCH_NUMBER_RULES = new Map<Key, LaunchNumberRule>([
	["batch_size", { integer: true, label: "Batch size", min: 0 }],
	["cache_reuse", { integer: true, label: "Cache reuse", min: 0 }],
	["ctx_size", { integer: true, label: "Context size", min: 0 }],
	["draft_max", { integer: true, label: "Draft max", min: 0 }],
	["draft_min", { integer: true, label: "Draft min", min: 0 }],
	["draft_p_min", { label: "Draft P min", max: 1, min: 0 }],
	["gpu_layers", { integer: true, label: "GPU layers", min: -1 }],
	[
		"gpu_memory_utilization",
		{
			label: "GPU memory utilization",
			max: 1,
			min: 0,
		},
	],
	["mem_fraction_static", { label: "Mem fraction static", max: 1, min: 0 }],
	["max_num_seqs", { integer: true, label: "Maximum sequences", min: 1 }],
	[
		"max_running_requests",
		{
			integer: true,
			label: "Maximum running requests",
			min: 1,
		},
	],
	["sleep_idle_secs", { integer: true, label: "Idle timeout", min: 0 }],
	["n_cpu_moe", { integer: true, label: "CPU MoE layers", min: 0 }],
	["parallel", { integer: true, label: "Parallel slots", min: 1 }],
	["tensor_parallel", { integer: true, label: "Tensor parallel", min: 0 }],
	["threads", { integer: true, label: "Threads" }],
	["ubatch_size", { integer: true, label: "uBatch size", min: 0 }],
]);

export function launchNumberError(
	key: Key,
	value: number,
	ruleOverride: Partial<LaunchNumberRule> | undefined,
	tl: LiteralMessage
): string | null {
	const rule = { ...LAUNCH_NUMBER_RULES.get(key), ...ruleOverride };
	const label = rule.label ?? key;
	if (!Number.isFinite(value)) {
		return tl("{label} must be a finite number.", { label });
	}
	if (rule?.integer && !Number.isSafeInteger(value)) {
		return tl("{label} must be a whole number.", { label });
	}
	if (rule?.min !== undefined && value < rule.min) {
		return tl("{label} must be at least {min}.", {
			label,
			min: String(rule.min),
		});
	}
	if (rule?.max !== undefined && value > rule.max) {
		return tl("{label} must be no greater than {max}.", {
			label,
			max: String(rule.max),
		});
	}
	return null;
}

export function launchSaveError<TError>(error: TError): string {
	if (error instanceof ApiError && error.serverMessage) {
		return error.serverMessage;
	}
	return error instanceof Error
		? error.message
		: "Could not save launch config";
}

export function rawLaunchDescription(
	engineId: string | undefined,
	manualRuntimeLaunch: boolean
): string {
	if (manualRuntimeLaunch) {
		return "One argument per entry. Copy these into the external runtime's launch configuration.";
	}
	if (engineId === "apfel") {
		return "Raw flags appended to `apfel --serve` for options not listed above. Host, port, serve mode, and permissive mode stay managed by Ryu; sampling flags are rejected in serve mode.";
	}
	if (engineId === "mlx-serve") {
		return "Raw flags appended after the options above when Ryu starts MLX Serve. Use separate arguments (MLX Serve rejects --flag=value, and an unknown flag stops the engine from starting). Host, port, model directory, serve mode, API key, and LAN sharing stay managed by Ryu.";
	}
	if (engineId === "omlx") {
		return "Raw flags appended to `omlx serve` for options not listed above. Ryu manages the model directory, host, and port. oMLX saves explicitly passed flags to its own settings.";
	}
	if (engineId === "mlx-vlm") {
		return "Raw flags appended to `mlx_vlm.server` for options not listed above. Host, port, and model stay managed by Ryu.";
	}
	if (engineId === "mesh-llm") {
		return "Raw flags appended to `mesh-llm serve` for options not listed above. The API port, bind address, console, and headless mode stay managed by Ryu.";
	}
	if (engineId === "audiocpp") {
		return "Raw flags appended to `audiocpp_server`. The config file, listen address, web UI, backend, device, threads, and model limits stay managed by Ryu. For a flag also set above, the option above wins.";
	}
	if (engineId === "whispercpp") {
		return "Raw flags appended to `whisper-server` for options not listed above.";
	}
	if (engineId === "sdcpp") {
		return "Raw flags appended to `sd-server`. The model, companion weights, and listen address stay managed by Ryu.";
	}
	if (engineId === "outetts") {
		return "Raw flags appended to each `llama-tts` run. The model, vocoder, prompt, and output path stay managed by Ryu.";
	}
	return "Raw CLI args appended to this engine command for flags not listed above.";
}

/** Draft accessors the launch-config field-group sections read and write. */
export interface LaunchFieldsApi {
	bool: (key: BooleanKey) => boolean | undefined;
	num: (key: NumberKey) => number | undefined;
	set: <K extends Key>(key: K, v: LaunchConfig[K] | undefined) => void;
	setNumber: (
		key: Key,
		value: number | undefined,
		ruleOverride?: Partial<LaunchNumberRule>
	) => void;
	str: (key: StringKey) => string | undefined;
}
