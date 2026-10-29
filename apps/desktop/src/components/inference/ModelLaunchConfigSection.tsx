import { z } from "zod";
// apps/desktop/src/components/inference/ModelLaunchConfigSection.tsx
//
// Per-model "Engine / Hardware" launch-config editor, shown in the model detail
// panel. These flags (context size, GPU layers, MoE offload, chat template,
// speculative decoding, quantization) are passed to the engine when the model is
// loaded, so changes take effect the next time the model is served, not live.

import { ArrowDown01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { ApiError, type ApiTarget } from "@/src/lib/api/client.ts";
import {
	getEngineLaunchConfig,
	getEngineSamplingConfig,
	getModelLaunchConfig,
	type LaunchConfig,
	type SamplingConfig,
	saveEngineLaunchConfig,
	saveModelLaunchConfig,
} from "@/src/lib/api/inference.ts";
import {
	BoolField,
	EnumField,
	FieldGrid,
	FieldGroup,
	NumberField,
	StringListField,
	TextField,
} from "./fields.tsx";
import { NativeLaunchOptions } from "./NativeLaunchOptions.tsx";

type Key = keyof LaunchConfig;

/** Engine ids whose launch settings become `llama-server` flags. */
const LLAMA_SERVER_ENGINES = new Set([
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
const MODEL_SCOPE_NATIVE_ENGINES = [
	"llamacpp",
	"vllm",
	"sglang",
	"mlx",
	"mlx-vlm",
];

type NumberKey = {
	[K in Key]-?: Exclude<LaunchConfig[K], undefined> extends number ? K : never;
}[Key];

type StringKey = {
	[K in Key]-?: Exclude<LaunchConfig[K], undefined> extends string ? K : never;
}[Key];

type BooleanKey = {
	[K in Key]-?: Exclude<LaunchConfig[K], undefined> extends boolean ? K : never;
}[Key];

interface LaunchNumberRule {
	integer?: boolean;
	label: string;
	max?: number;
	min?: number;
}

/** Mesh LLM parses `--draft-max` as a u16; Core drops larger values. */
const MESH_DRAFT_MAX_LIMIT = 65_535;

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

function launchNumberError(
	key: Key,
	value: number,
	ruleOverride?: Partial<LaunchNumberRule>
): string | null {
	const rule = { ...LAUNCH_NUMBER_RULES.get(key), ...ruleOverride };
	const label = rule.label ?? key;
	if (!Number.isFinite(value)) {
		return `${label} must be a finite number.`;
	}
	if (rule?.integer && !Number.isSafeInteger(value)) {
		return `${label} must be a whole number.`;
	}
	if (rule?.min !== undefined && value < rule.min) {
		return `${label} must be at least ${rule.min}.`;
	}
	if (rule?.max !== undefined && value > rule.max) {
		return `${label} must be no greater than ${rule.max}.`;
	}
	return null;
}

function launchSaveError<TError>(error: TError): string {
	if (error instanceof ApiError && error.serverMessage) {
		return error.serverMessage;
	}
	return error instanceof Error
		? error.message
		: "Could not save launch config";
}

function rawLaunchDescription(
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

export function ModelLaunchConfigSection({
	modelId,
	engineId,
	launchAdapterSupported = true,
	subtitle,
	subtitleTitle,
}: {
	modelId?: string;
	/** Engine-wide defaults shown on the Engine details page. */
	engineId?: string;
	/** False when the runtime owns its process and Ryu cannot apply launch flags. */
	launchAdapterSupported?: boolean;
	/** Optional model name shown beside the header (used in the agent editor). */
	subtitle?: string;
	/** Optional hover text for the subtitle (e.g. the raw model id + quant info). */
	subtitleTitle?: string;
}) {
	const isEngineScope = Boolean(engineId);
	const configOwnerId = engineId ?? modelId ?? "";
	const configQueryKey = isEngineScope
		? ["engines", "launch-config", configOwnerId]
		: ["models", "launch-config", configOwnerId];
	const ownerLabel = isEngineScope ? "engine" : "model";
	const activeNode = useActiveNode();
	const target: ApiTarget = {
		url: activeNode.url,
		token: activeNode.token ?? null,
		userJwt: activeNode.userJwt ?? null,
	};
	const { url } = target;
	const qc = useQueryClient();
	const [open, setOpen] = useState(false);
	const [numberErrors, setNumberErrors] = useState<
		Partial<Record<Key, string>>
	>({});
	const [numberDrafts, setNumberDrafts] = useState<
		Partial<Record<Key, number>>
	>({});
	const previousOwnerId = useRef(`${ownerLabel}:${configOwnerId}`);

	const configQuery = useQuery({
		queryKey: [...configQueryKey, url],
		queryFn: () =>
			engineId
				? getEngineLaunchConfig(target, engineId)
				: getModelLaunchConfig(target, configOwnerId),
		enabled: open,
	});
	const ollamaSamplingQuery = useQuery({
		queryKey: ["engine", "sampling-config", url, "ollama"],
		queryFn: () => getEngineSamplingConfig(target, "ollama"),
		enabled: open && engineId === "ollama",
	});

	// Local editable draft, seeded from the loaded config.
	const [draft, setDraft] = useState<LaunchConfig>({});
	const [speculativeConfigText, setSpeculativeConfigText] = useState("");
	const [speculativeConfigError, setSpeculativeConfigError] = useState<
		string | null
	>(null);
	const [profileCopied, setProfileCopied] = useState(false);
	const [nativeValid, setNativeValid] = useState(true);
	const [profileCopyError, setProfileCopyError] = useState(false);
	useEffect(() => {
		if (configQuery.data) {
			setDraft(configQuery.data);
			setSpeculativeConfigText(
				configQuery.data.speculative_config
					? JSON.stringify(configQuery.data.speculative_config, null, 2)
					: ""
			);
			setSpeculativeConfigError(null);
		}
	}, [configQuery.data]);

	const saveMutation = useMutation({
		mutationFn: (config: LaunchConfig) =>
			engineId
				? saveEngineLaunchConfig(target, engineId, config)
				: saveModelLaunchConfig(target, configOwnerId, config),
		onSuccess: () => {
			Promise.resolve(
				qc.invalidateQueries({ queryKey: [...configQueryKey, url] })
			).catch(() => undefined);
		},
	});
	const resetSaveMutation = saveMutation.reset;
	useEffect(() => {
		const owner = `${ownerLabel}:${configOwnerId}`;
		if (previousOwnerId.current === owner) {
			return;
		}
		previousOwnerId.current = owner;
		setNumberErrors({});
		setNumberDrafts({});
		resetSaveMutation();
	}, [ownerLabel, configOwnerId, resetSaveMutation]);

	const set = <K extends Key>(key: K, v: LaunchConfig[K] | undefined): void => {
		setDraft((prev) => {
			const next: LaunchConfig = { ...prev };
			if (v === undefined) {
				delete next[key];
			} else {
				next[key] = v;
			}
			return next;
		});
	};
	const setSpeculativeConfig = (text: string) => {
		setSpeculativeConfigText(text);
		if (!text.trim()) {
			setSpeculativeConfigError(null);
			set("speculative_config", undefined);
			return;
		}
		try {
			const parsed = z.record(z.string(), z.json()).safeParse(JSON.parse(text));
			if (!parsed.success) {
				setSpeculativeConfigError("Speculative config must be a JSON object.");
				return;
			}
			setSpeculativeConfigError(null);
			set("speculative_config", parsed.data);
		} catch {
			setSpeculativeConfigError("Invalid JSON.");
		}
	};
	const num = (key: NumberKey) => numberDrafts[key] ?? draft[key] ?? undefined;
	const str = (key: StringKey) => draft[key] ?? undefined;
	const bool = (key: BooleanKey) => draft[key] ?? undefined;
	const setNumber = (
		key: Key,
		value: number | undefined,
		ruleOverride?: Partial<LaunchNumberRule>
	) => {
		if (value === undefined) {
			setNumberErrors((current) => {
				const next = { ...current };
				delete next[key];
				return next;
			});
			setNumberDrafts((current) => {
				const next = { ...current };
				delete next[key];
				return next;
			});
			set(key, undefined);
			return;
		}
		const error = launchNumberError(key, value, ruleOverride);
		if (error) {
			setNumberErrors((current) => ({ ...current, [key]: error }));
			setNumberDrafts((current) => ({ ...current, [key]: value }));
			return;
		}
		setNumberErrors((current) => {
			const next = { ...current };
			delete next[key];
			return next;
		});
		setNumberDrafts((current) => {
			const next = { ...current };
			delete next[key];
			return next;
		});
		set(key, value);
	};
	const saveError = saveMutation.isError
		? launchSaveError(saveMutation.error)
		: null;
	const llamaCppEngine = !engineId || LLAMA_SERVER_ENGINES.has(engineId);
	const vllmEngine = !engineId || engineId === "vllm";
	const sglangEngine = !engineId || engineId === "sglang";
	const ollamaEngine = engineId === "ollama";
	const whisperEngine = engineId === "whispercpp";
	const mlxServeEngine = engineId === "mlx-serve";
	const meshLlmEngine = engineId === "mesh-llm";
	const manualRuntimeLaunch = isEngineScope && !launchAdapterSupported;
	const rawArgEngine =
		manualRuntimeLaunch ||
		llamaCppEngine ||
		vllmEngine ||
		sglangEngine ||
		engineId === "mlx" ||
		engineId === "mlx-vlm" ||
		engineId === "mlx-serve" ||
		engineId === "omlx" ||
		engineId === "apfel" ||
		engineId === "mesh-llm" ||
		engineId === "sdcpp" ||
		engineId === "outetts" ||
		engineId === "audiocpp" ||
		whisperEngine;
	const ollamaSampling: SamplingConfig = ollamaSamplingQuery.data ?? {};
	const ollamaProfile = [
		"FROM <model-id>",
		draft.ctx_size === undefined ? null : `PARAMETER num_ctx ${draft.ctx_size}`,
		draft.gpu_layers === undefined
			? null
			: `PARAMETER num_gpu ${draft.gpu_layers}`,
		draft.batch_size === undefined
			? null
			: `PARAMETER num_batch ${draft.batch_size}`,
		draft.threads === undefined
			? null
			: `PARAMETER num_thread ${draft.threads}`,
		draft.mlock === true ? "PARAMETER use_mlock true" : null,
		draft.no_mmap === true ? "PARAMETER use_mmap false" : null,
		ollamaSampling.top_k === undefined
			? null
			: `PARAMETER top_k ${ollamaSampling.top_k}`,
		ollamaSampling.min_p === undefined
			? null
			: `PARAMETER min_p ${ollamaSampling.min_p}`,
		ollamaSampling.typical_p === undefined
			? null
			: `PARAMETER typical_p ${ollamaSampling.typical_p}`,
		ollamaSampling.repeat_penalty === undefined
			? null
			: `PARAMETER repeat_penalty ${ollamaSampling.repeat_penalty}`,
		ollamaSampling.repeat_last_n === undefined
			? null
			: `PARAMETER repeat_last_n ${ollamaSampling.repeat_last_n}`,
		ollamaSampling.mirostat === undefined
			? null
			: `PARAMETER mirostat ${ollamaSampling.mirostat}`,
		ollamaSampling.mirostat_tau === undefined
			? null
			: `PARAMETER mirostat_tau ${ollamaSampling.mirostat_tau}`,
		ollamaSampling.mirostat_eta === undefined
			? null
			: `PARAMETER mirostat_eta ${ollamaSampling.mirostat_eta}`,
	]
		.filter((line): line is string => line !== null)
		.join("\n");
	const copyOllamaProfile = async () => {
		try {
			await navigator.clipboard.writeText(ollamaProfile);
			setProfileCopied(true);
			setProfileCopyError(false);
		} catch {
			setProfileCopied(false);
			setProfileCopyError(true);
		}
	};
	const copyRuntimeArgs = async () => {
		try {
			await navigator.clipboard.writeText((draft.extra_args ?? []).join("\n"));
			setProfileCopied(true);
			setProfileCopyError(false);
		} catch {
			setProfileCopied(false);
			setProfileCopyError(true);
		}
	};

	return (
		<section
			aria-label={
				isEngineScope ? "Engine launch defaults" : "Engine and hardware"
			}
			className="flex flex-col gap-2"
		>
			<button
				aria-expanded={open}
				className="flex w-full items-center gap-2 rounded-lg bg-card px-4 py-3 text-left hover:bg-muted/50"
				onClick={() => setOpen((o) => !o)}
				type="button"
			>
				<span className="font-medium text-sm">
					{isEngineScope ? "Engine launch settings" : "Engine / Hardware"}
				</span>
				{subtitle ? (
					<span
						className="truncate text-muted-foreground text-xs"
						title={subtitleTitle}
					>
						{subtitle}
					</span>
				) : null}
				<span className="ml-auto text-muted-foreground">
					<HugeiconsIcon
						className="size-4"
						icon={open ? ArrowDown01Icon : ArrowRight01Icon}
					/>
				</span>
			</button>

			{open ? (
				<SettingsSection
					caption={
						manualRuntimeLaunch
							? "This is a saved copy only. Paste the arguments into the external runtime; Ryu cannot apply them to that process."
							: isEngineScope
								? "Launch defaults for every model served by this engine. Changes apply on the next engine start. Leave a field blank to keep the engine default."
								: "Launch flags for this model. Changes apply the next time the model is loaded. Leave a field blank to use the engine default."
					}
				>
					<SettingsCard className="flex flex-col gap-6">
						{Object.entries(numberErrors).map(([key, message]) => (
							<p
								className="text-status-destructive text-xs"
								key={key}
								role="alert"
							>
								{message}
							</p>
						))}
						{configQuery.isLoading && !configQuery.data ? (
							<SkeletonRows label="Loading config…" spacing="comfortable" />
						) : configQuery.isError && !configQuery.data ? (
							<div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
								<p className="text-status-destructive text-xs" role="alert">
									Could not load {ownerLabel} launch config:{" "}
									{launchSaveError(configQuery.error)}
								</p>
								<Button
									disabled={configQuery.isFetching}
									loading={configQuery.isFetching}
									onClick={() => void configQuery.refetch()}
									size="sm"
								>
									Retry {ownerLabel} config
								</Button>
							</div>
						) : (
							<>
								{configQuery.isError ? (
									<div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
										<p className="text-status-destructive text-xs" role="alert">
											Could not refresh {ownerLabel} launch config:{" "}
											{launchSaveError(configQuery.error)}
										</p>
										<Button
											disabled={configQuery.isFetching}
											loading={configQuery.isFetching}
											onClick={() => void configQuery.refetch()}
											size="sm"
										>
											Retry {ownerLabel} config
										</Button>
									</div>
								) : null}
								{llamaCppEngine ||
								vllmEngine ||
								sglangEngine ||
								whisperEngine ||
								ollamaEngine ||
								mlxServeEngine ||
								meshLlmEngine ? (
									<FieldGroup title="Context & hardware">
										<FieldGrid>
											{llamaCppEngine ||
											vllmEngine ||
											sglangEngine ||
											ollamaEngine ||
											mlxServeEngine ||
											meshLlmEngine ? (
												<NumberField
													hint={
														llamaCppEngine || mlxServeEngine || meshLlmEngine
															? "--ctx-size"
															: ollamaEngine
																? "Modelfile PARAMETER num_ctx"
																: vllmEngine
																	? "--max-model-len"
																	: "--context-length"
													}
													label="Context size"
													min={0}
													onChange={(v) => setNumber("ctx_size", v)}
													step={512}
													value={num("ctx_size")}
												/>
											) : null}
											{meshLlmEngine ? (
												<NumberField
													hint="--parallel: concurrent sequences per served model."
													label="Parallel lanes"
													min={1}
													onChange={(v) => setNumber("parallel", v)}
													step={1}
													value={num("parallel")}
												/>
											) : null}
											{llamaCppEngine || ollamaEngine ? (
												<>
													<NumberField
														hint={
															ollamaEngine
																? "Modelfile PARAMETER num_gpu"
																: "-ngl (-1 = all to GPU)"
														}
														label="GPU layers"
														min={-1}
														onChange={(v) => setNumber("gpu_layers", v)}
														step={1}
														value={num("gpu_layers")}
													/>
													<NumberField
														hint={
															ollamaEngine
																? "Modelfile PARAMETER num_batch"
																: undefined
														}
														label="Batch size"
														onChange={(v) => setNumber("batch_size", v)}
														step={1}
														value={num("batch_size")}
													/>
													{llamaCppEngine ? (
														<NumberField
															label="uBatch size"
															onChange={(v) => setNumber("ubatch_size", v)}
															step={1}
															value={num("ubatch_size")}
														/>
													) : null}
													<NumberField
														hint={
															ollamaEngine
																? "Modelfile PARAMETER num_thread"
																: undefined
														}
														label="Threads"
														onChange={(v) => setNumber("threads", v)}
														step={1}
														value={num("threads")}
													/>
													{llamaCppEngine ? (
														<>
															<EnumField
																label="Flash attention"
																onChange={(v) =>
																	set(
																		"flash_attn",
																		/* SAFETY: This private EnumField mounts only auto/on/off, and its Default sentinel publishes undefined. These are exactly the optional flash_attn values; no stored launch configuration is validated by this cast. */ v as LaunchConfig["flash_attn"]
																	)
																}
																options={[
																	{ value: "auto", label: "Auto" },
																	{ value: "on", label: "On" },
																	{ value: "off", label: "Off" },
																]}
																value={str("flash_attn")}
															/>
															<TextField
																hint="KV cache type, e.g. q8_0, f16"
																label="Cache type K"
																onChange={(v) => set("cache_type_k", v)}
																value={str("cache_type_k")}
															/>
															<TextField
																label="Cache type V"
																onChange={(v) => set("cache_type_v", v)}
																value={str("cache_type_v")}
															/>
														</>
													) : null}
												</>
											) : null}
											{whisperEngine ? (
												<NumberField
													label="Threads"
													onChange={(v) => setNumber("threads", v)}
													step={1}
													value={num("threads")}
												/>
											) : null}
											{llamaCppEngine || ollamaEngine ? (
												<div className="col-span-full flex flex-col gap-1">
													<BoolField
														hint={
															ollamaEngine
																? "Modelfile PARAMETER use_mlock"
																: "Lock the model into RAM (--mlock)"
														}
														label="Lock in RAM"
														onChange={(v) => set("mlock", v)}
														value={bool("mlock")}
													/>
													<BoolField
														hint={
															ollamaEngine
																? "Modelfile PARAMETER use_mmap false"
																: "Disable memory-mapping (--no-mmap)"
														}
														label="No mmap"
														onChange={(v) => set("no_mmap", v)}
														value={bool("no_mmap")}
													/>
												</div>
											) : null}
										</FieldGrid>
									</FieldGroup>
								) : null}

								{ollamaEngine ? (
									<FieldGroup
										description="Ryu does not create a derived Ollama model yet. Copy this profile, replace the model id, then use it in your Ollama Modelfile."
										title="Generated Modelfile profile"
									>
										<Textarea
											aria-label="Generated Ollama Modelfile"
											className="min-h-24"
											readOnly
											value={ollamaProfile}
											variant="code-caption"
										/>
										<div className="flex items-center gap-2">
											<Button
												onClick={() => void copyOllamaProfile()}
												size="sm"
												variant="outline"
											>
												Copy Modelfile profile
											</Button>
											{profileCopied ? (
												<span className="text-muted-foreground text-xs">
													Copied
												</span>
											) : null}
											{profileCopyError ? (
												<p
													className="text-status-destructive text-xs"
													role="alert"
												>
													Clipboard access was unavailable.
												</p>
											) : null}
										</div>
									</FieldGroup>
								) : null}

								{llamaCppEngine ? (
									<FieldGroup
										description="Release the model and KV cache after an idle period."
										title="Idle unloading"
									>
										<NumberField
											hint="--sleep-idle-seconds; 0 disables the timer"
											label="Unload after idle (seconds)"
											min={0}
											onChange={(value) => setNumber("sleep_idle_secs", value)}
											step={1}
											value={num("sleep_idle_secs")}
										/>
									</FieldGroup>
								) : null}

								{llamaCppEngine ? (
									<FieldGroup
										description="Batch multiple requests in one decode loop (llama.cpp). More slots ⇒ higher throughput for Ryu's fan-out (delegate / threads / teams), sharing KV-cache memory across slots. Leave slots blank for a memory-aware default."
										title="Continuous batching"
									>
										<FieldGrid>
											<NumberField
												hint="--parallel: server slots = batch width. Blank ⇒ auto by memory."
												label="Parallel slots"
												min={1}
												onChange={(v) => setNumber("parallel", v)}
												step={1}
												value={num("parallel")}
											/>
											<NumberField
												hint="--cache-reuse: min prefix KV chunk reused across requests (0 = off)"
												label="Cache reuse"
												min={0}
												onChange={(v) => setNumber("cache_reuse", v)}
												step={64}
												value={num("cache_reuse")}
											/>
										</FieldGrid>
										<div className="flex flex-col gap-1">
											<BoolField
												hint="--kv-unified: one shared KV buffer across slots (avoids the per-slot context split). Auto-on with multiple slots."
												label="Unified KV cache"
												onChange={(v) => set("kv_unified", v)}
												value={bool("kv_unified")}
											/>
											<BoolField
												hint="Continuous batching is ON by default; turn off to emit --no-cont-batching"
												label="Continuous batching"
												onChange={(v) => set("cont_batching", v)}
												value={bool("cont_batching")}
											/>
										</div>
									</FieldGroup>
								) : null}

								{llamaCppEngine ? (
									<FieldGroup
										description="Keep mixture-of-experts weights on CPU to fit larger models (llama.cpp)."
										title="MoE offload"
									>
										<BoolField
											label="Keep all experts on CPU (--cpu-moe)"
											onChange={(v) => set("cpu_moe", v)}
											value={bool("cpu_moe")}
										/>
										<FieldGrid>
											<NumberField
												label="CPU MoE layers (--n-cpu-moe)"
												onChange={(v) => setNumber("n_cpu_moe", v)}
												step={1}
												value={num("n_cpu_moe")}
											/>
											<TextField
												hint="Raw -ot pattern, e.g. .ffn_.*_exps.=CPU"
												label="Override tensor"
												onChange={(v) => set("override_tensor", v)}
												value={str("override_tensor")}
											/>
										</FieldGrid>
									</FieldGroup>
								) : null}

								{llamaCppEngine ? (
									<FieldGroup
										description="Use a custom Jinja chat template (llama.cpp)."
										title="Chat template"
									>
										<BoolField
											label="Enable Jinja (--jinja)"
											onChange={(v) => set("jinja", v)}
											value={bool("jinja")}
										/>
										<TextField
											hint="Path to a .jinja template file"
											label="Chat template file"
											onChange={(v) => set("chat_template_file", v)}
											value={str("chat_template_file")}
										/>
										<div className="flex flex-col gap-1.5">
											<Label htmlFor={`launch-chat-template-${configOwnerId}`}>
												Inline Jinja template
											</Label>
											<Textarea
												className="min-h-24"
												id={`launch-chat-template-${configOwnerId}`}
												onChange={(event) =>
													set("chat_template", event.target.value || undefined)
												}
												placeholder="{{- if .System }}…"
												value={str("chat_template")}
												variant="code-caption"
											/>
										</div>
									</FieldGroup>
								) : null}

								{llamaCppEngine ? (
									<FieldGroup
										description="Adjust RoPE and YaRN context scaling when the model's training setup calls for it."
										title="RoPE / YaRN"
									>
										<FieldGrid>
											<TextField
												hint="none, linear, yarn, longrope"
												label="RoPE scaling"
												onChange={(v) => set("rope_scaling", v)}
												value={str("rope_scaling")}
											/>
											<NumberField
												label="RoPE scale"
												onChange={(v) => setNumber("rope_scale", v)}
												step={0.1}
												value={num("rope_scale")}
											/>
											<NumberField
												label="RoPE frequency base"
												onChange={(v) => setNumber("rope_freq_base", v)}
												step={1000}
												value={num("rope_freq_base")}
											/>
											<NumberField
												label="RoPE frequency scale"
												onChange={(v) => setNumber("rope_freq_scale", v)}
												step={0.1}
												value={num("rope_freq_scale")}
											/>
										</FieldGrid>
									</FieldGroup>
								) : null}

								{llamaCppEngine || sglangEngine || meshLlmEngine ? (
									<FieldGroup
										description="Speed up generation with a draft model or MTP (llama.cpp / SGLang / Mesh LLM; vLLM via speculative config)."
										title="Speculative decoding / MTP"
									>
										<FieldGrid>
											{llamaCppEngine ? (
												<EnumField
													hint="llama.cpp --spec-type. draft-mtp = multi-token prediction."
													label="Speculative type"
													onChange={(v) => set("spec_type", v)}
													options={[
														{ value: "draft-mtp", label: "MTP (draft-mtp)" },
														{ value: "ngram-cache", label: "n-gram cache" },
														{ value: "ngram-simple", label: "n-gram simple" },
														{ value: "ngram-map-k", label: "n-gram map-k" },
														{ value: "ngram-map-k4v", label: "n-gram map-k4v" },
														{ value: "ngram-mod", label: "n-gram mod" },
													]}
													value={str("spec_type")}
												/>
											) : null}
											{llamaCppEngine || sglangEngine || meshLlmEngine ? (
												<>
													<TextField
														hint={
															meshLlmEngine ? "--draft" : "Draft model path."
														}
														label="Draft model"
														onChange={(v) => set("draft_model", v)}
														value={str("draft_model")}
													/>
													<NumberField
														hint={
															meshLlmEngine
																? "--draft-max (up to 65535)"
																: "Maximum draft tokens per step."
														}
														label="Draft max"
														max={
															meshLlmEngine ? MESH_DRAFT_MAX_LIMIT : undefined
														}
														onChange={(v) =>
															setNumber(
																"draft_max",
																v,
																meshLlmEngine
																	? { max: MESH_DRAFT_MAX_LIMIT }
																	: undefined
															)
														}
														step={1}
														value={num("draft_max")}
													/>
												</>
											) : null}
											{llamaCppEngine ? (
												<>
													<NumberField
														hint="--spec-draft-n-min"
														label="Draft min"
														onChange={(v) => setNumber("draft_min", v)}
														step={1}
														value={num("draft_min")}
													/>
													<NumberField
														hint="MTP draft probability threshold."
														label="Draft P min"
														onChange={(v) => setNumber("draft_p_min", v)}
														step={0.01}
														value={num("draft_p_min")}
													/>
												</>
											) : null}
											{sglangEngine ? (
												<TextField
													hint="eagle | ngram"
													label="Speculative algorithm"
													onChange={(v) => set("speculative_algorithm", v)}
													value={str("speculative_algorithm")}
												/>
											) : null}
										</FieldGrid>
										{llamaCppEngine ? (
											<p className="text-muted-foreground text-xs">
												MTP needs a model with MTP heads. Some (e.g. Gemma-4
												E2B/E4B) need a separate <code>*-assist-*.gguf</code> as
												the draft model; others carry the head in-file (leave
												draft model blank).
											</p>
										) : null}
									</FieldGroup>
								) : null}

								{vllmEngine || sglangEngine ? (
									<FieldGroup
										description="Applied when serving this model with vLLM or SGLang."
										title="vLLM / SGLang"
									>
										<FieldGrid>
											{vllmEngine ? (
												<NumberField
													hint="vLLM 0.0–1.0"
													label="GPU memory utilization"
													max={1}
													min={0}
													onChange={(v) =>
														setNumber("gpu_memory_utilization", v)
													}
													step={0.05}
													value={num("gpu_memory_utilization")}
												/>
											) : null}
											{sglangEngine ? (
												<NumberField
													hint="SGLang 0.0–1.0"
													label="Mem fraction static"
													max={1}
													min={0}
													onChange={(v) => setNumber("mem_fraction_static", v)}
													step={0.05}
													value={num("mem_fraction_static")}
												/>
											) : null}
											<NumberField
												label="Tensor parallel"
												onChange={(v) => setNumber("tensor_parallel", v)}
												step={1}
												value={num("tensor_parallel")}
											/>
											<TextField
												hint="auto | float16 | bfloat16"
												label="Dtype"
												onChange={(v) => set("dtype", v)}
												value={str("dtype")}
											/>
											<TextField
												hint="awq | gptq | fp8 | …"
												label="Quantization"
												onChange={(v) => set("quantization", v)}
												value={str("quantization")}
											/>
											<TextField
												label="KV cache dtype"
												onChange={(v) => set("kv_cache_dtype", v)}
												value={str("kv_cache_dtype")}
											/>
											{vllmEngine ? (
												<NumberField
													label="Maximum sequences"
													min={1}
													onChange={(v) => setNumber("max_num_seqs", v)}
													step={1}
													value={num("max_num_seqs")}
												/>
											) : null}
											{sglangEngine ? (
												<NumberField
													label="Maximum running requests"
													min={1}
													onChange={(v) => setNumber("max_running_requests", v)}
													step={1}
													value={num("max_running_requests")}
												/>
											) : null}
										</FieldGrid>
										{vllmEngine ? (
											<BoolField
												label="Enable prefix caching"
												onChange={(value) =>
													set("enable_prefix_caching", value)
												}
												value={bool("enable_prefix_caching")}
											/>
										) : null}
										{vllmEngine ? (
											<>
												<FieldGrid>
													<TextField
														hint="Draft model path from the vLLM speculative config."
														label="Draft model"
														onChange={(v) => set("draft_model", v)}
														value={str("draft_model")}
													/>
													<NumberField
														label="Draft tokens"
														min={1}
														onChange={(v) =>
															setNumber("draft_max", v, {
																label: "Draft tokens",
																min: 1,
															})
														}
														step={1}
														value={num("draft_max")}
													/>
												</FieldGrid>
												<div className="flex flex-col gap-1.5">
													<Label
														htmlFor={`launch-speculative-config-${configOwnerId}`}
													>
														Speculative config (JSON)
													</Label>
													<Textarea
														aria-invalid={Boolean(speculativeConfigError)}
														className="min-h-24"
														id={`launch-speculative-config-${configOwnerId}`}
														onChange={(event) =>
															setSpeculativeConfig(event.target.value)
														}
														placeholder={'{\n  "num_speculative_tokens": 5\n}'}
														value={speculativeConfigText}
														variant="code-caption"
													/>
													{speculativeConfigError ? (
														<p
															className="text-status-destructive text-xs"
															role="alert"
														>
															{speculativeConfigError}
														</p>
													) : null}
												</div>
											</>
										) : null}
									</FieldGroup>
								) : null}

								{manualRuntimeLaunch ? null : (
									<NativeLaunchOptions
										engineChoices={
											isEngineScope ? undefined : MODEL_SCOPE_NATIVE_ENGINES
										}
										engineId={engineId ?? "llamacpp"}
										key={`${ownerLabel}:${configOwnerId}`}
										onChange={(native) => set("native", native)}
										onValidityChange={setNativeValid}
										value={draft.native}
									/>
								)}

								{rawArgEngine ? (
									<FieldGroup
										description={rawLaunchDescription(
											engineId,
											manualRuntimeLaunch
										)}
										title={
											manualRuntimeLaunch
												? "Runtime launch profile"
												: "Raw passthrough"
										}
									>
										<StringListField
											hint="One arg per entry, e.g. --spec-type, ngram-cache"
											label={
												manualRuntimeLaunch ? "Runtime args" : "Extra args"
											}
											onChange={(v) => set("extra_args", v)}
											placeholder="--flag, value"
											value={draft.extra_args}
										/>
										{manualRuntimeLaunch ? (
											<div className="flex items-center gap-2">
												<Button
													disabled={!draft.extra_args?.length}
													onClick={() => void copyRuntimeArgs()}
													size="sm"
													variant="outline"
												>
													Copy runtime args
												</Button>
												{profileCopied ? (
													<span className="text-muted-foreground text-xs">
														Copied
													</span>
												) : null}
												{profileCopyError ? (
													<p
														className="text-status-destructive text-xs"
														role="alert"
													>
														Clipboard access was unavailable.
													</p>
												) : null}
											</div>
										) : null}
									</FieldGroup>
								) : null}

								<div className="flex items-center gap-2">
									<Button
										disabled={
											saveMutation.isPending ||
											Object.keys(numberErrors).length > 0 ||
											Boolean(speculativeConfigError) ||
											!nativeValid ||
											configQuery.isError ||
											!configQuery.data
										}
										loading={saveMutation.isPending}
										onClick={() => saveMutation.mutate(draft)}
									>
										Save {ownerLabel} launch settings
									</Button>
									{saveMutation.isSuccess ? (
										<span className="text-muted-foreground text-xs">Saved</span>
									) : null}
									{saveError ? (
										<span
											className="text-status-destructive text-xs"
											role="alert"
										>
											Could not save: {saveError}
										</span>
									) : null}
								</div>
							</>
						)}
					</SettingsCard>
				</SettingsSection>
			) : null}
		</section>
	);
}

/** Global launch defaults, hosted on the selected Engine detail page. */
export function EngineLaunchConfigSection({
	engineId,
	launchAdapterSupported = true,
}: {
	engineId: string;
	launchAdapterSupported?: boolean;
}) {
	return (
		<ModelLaunchConfigSection
			engineId={engineId}
			launchAdapterSupported={launchAdapterSupported}
		/>
	);
}
