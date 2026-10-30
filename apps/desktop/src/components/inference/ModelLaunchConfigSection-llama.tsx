// llama.cpp-specific field groups (MoE offload, chat template, RoPE / YaRN) and
// the speculative decoding group for ModelLaunchConfigSection.

import { Label } from "@ryu/ui/components/label.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import {
	BoolField,
	EnumField,
	FieldGrid,
	FieldGroup,
	NumberField,
	TextField,
} from "./fields.tsx";
import {
	type LaunchFieldsApi,
	MESH_DRAFT_MAX_LIMIT,
} from "./ModelLaunchConfigSection-rules.ts";

export function LaunchLlamaCppGroups({
	configOwnerId,
	fields: { bool, num, set, setNumber, str },
	llamaCppEngine,
}: {
	configOwnerId: string;
	fields: LaunchFieldsApi;
	llamaCppEngine: boolean;
}) {
	return (
		<>
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
		</>
	);
}

export function LaunchSpeculativeGroup({
	fields: { num, set, setNumber, str },
	llamaCppEngine,
	meshLlmEngine,
	sglangEngine,
}: {
	fields: LaunchFieldsApi;
	llamaCppEngine: boolean;
	meshLlmEngine: boolean;
	sglangEngine: boolean;
}) {
	return (
		<>
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
									hint={meshLlmEngine ? "--draft" : "Draft model path."}
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
									max={meshLlmEngine ? MESH_DRAFT_MAX_LIMIT : undefined}
									onChange={(v) =>
										setNumber(
											"draft_max",
											v,
											meshLlmEngine ? { max: MESH_DRAFT_MAX_LIMIT } : undefined
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
							MTP needs a model with MTP heads. Some (e.g. Gemma-4 E2B/E4B) need
							a separate <code>*-assist-*.gguf</code> as the draft model; others
							carry the head in-file (leave draft model blank).
						</p>
					) : null}
				</FieldGroup>
			) : null}
		</>
	);
}
