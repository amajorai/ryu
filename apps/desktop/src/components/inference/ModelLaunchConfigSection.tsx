// apps/desktop/src/components/inference/ModelLaunchConfigSection.tsx
//
// Per-model "Engine / Hardware" launch-config editor, shown in the model detail
// panel. These flags (context size, GPU layers, MoE offload, chat template,
// speculative decoding, quantization) are passed to the engine when the model is
// loaded, so changes take effect the next time the model is served, not live.

import { ArrowDown01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import { Spinner } from "@ryu/ui/components/spinner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	getModelLaunchConfig,
	type LaunchConfig,
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

type Key = keyof LaunchConfig;

export function ModelLaunchConfigSection({
	modelId,
	subtitle,
	subtitleTitle,
}: {
	modelId: string;
	/** Optional model name shown beside the header (used in the agent editor). */
	subtitle?: string;
	/** Optional hover text for the subtitle (e.g. the raw model id + quant info). */
	subtitleTitle?: string;
}) {
	const activeNode = useActiveNode();
	const target: ApiTarget = {
		url: activeNode.url,
		token: activeNode.token ?? null,
	};
	const { url } = target;
	const qc = useQueryClient();
	const [open, setOpen] = useState(false);

	const configQuery = useQuery({
		queryKey: ["models", "launch-config", url, modelId],
		queryFn: () => getModelLaunchConfig(target, modelId),
		enabled: open,
	});

	// Local editable draft, seeded from the loaded config.
	const [draft, setDraft] = useState<LaunchConfig>({});
	useEffect(() => {
		if (configQuery.data) {
			setDraft(configQuery.data);
		}
	}, [configQuery.data]);

	const saveMutation = useMutation({
		mutationFn: (config: LaunchConfig) =>
			saveModelLaunchConfig(target, modelId, config),
		onSuccess: () => {
			Promise.resolve(
				qc.invalidateQueries({
					queryKey: ["models", "launch-config", url, modelId],
				})
			).catch(() => undefined);
		},
	});

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
	const num = (key: Key) => (draft[key] as number | undefined) ?? undefined;
	const str = (key: Key) => (draft[key] as string | undefined) ?? undefined;
	const bool = (key: Key) => (draft[key] as boolean | undefined) ?? undefined;

	return (
		<section aria-label="Engine and hardware" className="flex flex-col gap-2">
			<button
				className="flex w-full items-center gap-2 rounded-lg bg-card px-4 py-3 text-left hover:bg-muted/50"
				onClick={() => setOpen((o) => !o)}
				type="button"
			>
				<span className="font-semibold text-sm">Engine / Hardware</span>
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
				<SettingsSection caption="Launch flags for this model. Changes apply the next time the model is loaded. Leave a field blank to use the engine default.">
					<SettingsCard className="flex flex-col gap-6">
						{configQuery.isLoading ? (
							<div className="flex items-center gap-2 text-muted-foreground text-xs">
								<Spinner className="size-3" />
								Loading config…
							</div>
						) : (
							<>
								<FieldGroup title="Context & hardware">
									<FieldGrid>
										<NumberField
											hint="-c / --ctx-size (llama.cpp), num_ctx (Ollama)"
											label="Context size"
											min={0}
											onChange={(v) => set("ctx_size", v)}
											step={512}
											value={num("ctx_size")}
										/>
										<NumberField
											hint="-ngl (-1 = all to GPU)"
											label="GPU layers"
											onChange={(v) => set("gpu_layers", v)}
											step={1}
											value={num("gpu_layers")}
										/>
										<NumberField
											label="Batch size"
											onChange={(v) => set("batch_size", v)}
											step={1}
											value={num("batch_size")}
										/>
										<NumberField
											label="uBatch size"
											onChange={(v) => set("ubatch_size", v)}
											step={1}
											value={num("ubatch_size")}
										/>
										<NumberField
											label="Threads"
											onChange={(v) => set("threads", v)}
											step={1}
											value={num("threads")}
										/>
										<EnumField
											label="Flash attention"
											onChange={(v) =>
												set("flash_attn", v as LaunchConfig["flash_attn"])
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
									</FieldGrid>
									<div className="flex flex-col gap-1">
										<BoolField
											hint="Lock the model into RAM (--mlock)"
											label="Lock in RAM"
											onChange={(v) => set("mlock", v)}
											value={bool("mlock")}
										/>
										<BoolField
											hint="Disable memory-mapping (--no-mmap)"
											label="No mmap"
											onChange={(v) => set("no_mmap", v)}
											value={bool("no_mmap")}
										/>
									</div>
								</FieldGroup>

								<FieldGroup
									description="Batch multiple requests in one decode loop (llama.cpp). More slots ⇒ higher throughput for Ryu's fan-out (delegate / threads / teams), sharing KV-cache memory across slots. Leave slots blank for a memory-aware default."
									title="Continuous batching"
								>
									<FieldGrid>
										<NumberField
											hint="--parallel: server slots = batch width. Blank ⇒ auto by memory."
											label="Parallel slots"
											min={1}
											onChange={(v) => set("parallel", v)}
											step={1}
											value={num("parallel")}
										/>
										<NumberField
											hint="--cache-reuse: min prefix KV chunk reused across requests (0 = off)"
											label="Cache reuse"
											min={0}
											onChange={(v) => set("cache_reuse", v)}
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
											onChange={(v) => set("n_cpu_moe", v)}
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
								</FieldGroup>

								<FieldGroup
									description="Speed up generation with a draft model or MTP (llama.cpp / SGLang; vLLM via speculative config)."
									title="Speculative decoding / MTP"
								>
									<FieldGrid>
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
										<TextField
											hint="-md / draft model. For Gemma-4 MTP, the *-assist-*.gguf"
											label="Draft model"
											onChange={(v) => set("draft_model", v)}
											value={str("draft_model")}
										/>
										<NumberField
											hint="--spec-draft-n-max (MTP: tokens drafted per step)"
											label="Draft max"
											onChange={(v) => set("draft_max", v)}
											step={1}
											value={num("draft_max")}
										/>
										<NumberField
											hint="--spec-draft-n-min"
											label="Draft min"
											onChange={(v) => set("draft_min", v)}
											step={1}
											value={num("draft_min")}
										/>
										<TextField
											hint="SGLang: eagle | ngram"
											label="Speculative algorithm"
											onChange={(v) => set("speculative_algorithm", v)}
											value={str("speculative_algorithm")}
										/>
									</FieldGrid>
									<p className="text-muted-foreground text-xs">
										MTP needs a model with MTP heads. Some (e.g. Gemma-4
										E2B/E4B) need a separate <code>*-assist-*.gguf</code> as the
										draft model; others carry the head in-file (leave draft
										model blank).
									</p>
								</FieldGroup>

								<FieldGroup
									description="Applied when serving this model with vLLM or SGLang."
									title="vLLM / SGLang"
								>
									<FieldGrid>
										<NumberField
											hint="vLLM 0.0–1.0"
											label="GPU memory utilization"
											max={1}
											min={0}
											onChange={(v) => set("gpu_memory_utilization", v)}
											step={0.05}
											value={num("gpu_memory_utilization")}
										/>
										<NumberField
											hint="SGLang 0.0–1.0"
											label="Mem fraction static"
											max={1}
											min={0}
											onChange={(v) => set("mem_fraction_static", v)}
											step={0.05}
											value={num("mem_fraction_static")}
										/>
										<NumberField
											label="Tensor parallel"
											onChange={(v) => set("tensor_parallel", v)}
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
									</FieldGrid>
								</FieldGroup>

								<FieldGroup
									description="Raw CLI args appended verbatim to the engine command. For flags not listed above (n-gram / MTP speculative decoding, research knobs)."
									title="Raw passthrough"
								>
									<StringListField
										hint="One arg per entry, e.g. --spec-type, ngram-cache"
										label="Extra args"
										onChange={(v) => set("extra_args", v)}
										placeholder="--flag, value"
										value={draft.extra_args}
									/>
								</FieldGroup>

								<div className="flex items-center gap-2">
									<Button
										disabled={saveMutation.isPending}
										onClick={() => saveMutation.mutate(draft)}
									>
										{saveMutation.isPending ? (
											<Spinner className="size-3.5" />
										) : null}
										Save launch config
									</Button>
									{saveMutation.isSuccess ? (
										<span className="text-muted-foreground text-xs">Saved</span>
									) : null}
									{saveMutation.isError ? (
										<span className="text-destructive text-xs">
											Could not save (the backend may not support this yet)
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
