// Extended and engine-specific sampler groups for AdvancedInferenceSection.

import type { SamplingFieldsProps } from "./AdvancedInferenceSection-rules.ts";
import {
	EnumField,
	FieldGrid,
	FieldGroup,
	NumberField,
	TextField,
} from "./fields.tsx";

/** Extended local-engine samplers plus Ollama and MLX engine groups. */
export function SamplingEngineGroups({
	disabled,
	engineId,
	localEngine,
	num,
	scope,
	set,
	setNumber,
	shows,
	supportedFields,
	value,
}: SamplingFieldsProps) {
	return (
		<>
			{localEngine || supportedFields ? (
				<>
					{shows("mirostat", localEngine) ? (
						<FieldGroup
							description="Entropy-targeting sampler. Mode 0 disables it."
							title="Mirostat"
						>
							<FieldGrid>
								<EnumField
									disabled={disabled}
									label="Mode"
									onChange={(v) =>
										set("mirostat", v === undefined ? undefined : Number(v))
									}
									options={[
										{ value: "0", label: "Off" },
										{ value: "1", label: "Mirostat 1" },
										{ value: "2", label: "Mirostat 2" },
									]}
									value={
										value.mirostat === undefined
											? undefined
											: String(value.mirostat)
									}
								/>
								<NumberField
									disabled={disabled}
									label="Tau (target entropy)"
									onChange={(v) => setNumber("mirostat_tau", v)}
									step={0.1}
									value={num("mirostat_tau")}
								/>
								<NumberField
									disabled={disabled}
									label="Eta (learning rate)"
									onChange={(v) => setNumber("mirostat_eta", v)}
									step={0.01}
									value={num("mirostat_eta")}
								/>
							</FieldGrid>
						</FieldGroup>
					) : null}

					{shows("dry_multiplier", localEngine) ? (
						<FieldGroup
							description="llama.cpp dynamic-temperature, XTC, and DRY repetition controls."
							title="Advanced samplers"
						>
							<FieldGrid>
								<NumberField
									disabled={disabled}
									label="DynaTemp range"
									onChange={(v) => setNumber("dynatemp_range", v)}
									step={0.05}
									value={num("dynatemp_range")}
								/>
								<NumberField
									disabled={disabled}
									label="DynaTemp exponent"
									onChange={(v) => setNumber("dynatemp_exponent", v)}
									step={0.05}
									value={num("dynatemp_exponent")}
								/>
								<NumberField
									disabled={disabled}
									label="XTC probability"
									max={1}
									min={0}
									onChange={(v) => setNumber("xtc_probability", v)}
									step={0.01}
									value={num("xtc_probability")}
								/>
								<NumberField
									disabled={disabled}
									label="XTC threshold"
									onChange={(v) => setNumber("xtc_threshold", v)}
									step={0.01}
									value={num("xtc_threshold")}
								/>
								<NumberField
									disabled={disabled}
									label="DRY multiplier"
									onChange={(v) => setNumber("dry_multiplier", v)}
									step={0.05}
									value={num("dry_multiplier")}
								/>
								<NumberField
									disabled={disabled}
									label="DRY base"
									onChange={(v) => setNumber("dry_base", v)}
									step={0.05}
									value={num("dry_base")}
								/>
								<NumberField
									disabled={disabled}
									label="DRY allowed length"
									onChange={(v) => setNumber("dry_allowed_length", v)}
									step={1}
									value={num("dry_allowed_length")}
								/>
								<NumberField
									disabled={disabled}
									label="DRY penalty last N"
									onChange={(v) => setNumber("dry_penalty_last_n", v)}
									step={1}
									value={num("dry_penalty_last_n")}
								/>
							</FieldGrid>
							<TextField
								disabled={disabled}
								hint="Sampler chain order, e.g. penalties;dry;top_k;top_p;min_p;temperature"
								label="Sampler order"
								onChange={(v) => set("samplers", v)}
								value={value.samplers}
							/>
						</FieldGroup>
					) : null}
				</>
			) : (
				<p className="py-2 text-muted-foreground text-xs">
					{scope === "engine" && engineId === "ollama"
						? "Ollama's extra sampling controls appear below as Modelfile parameters. Ryu can generate a profile to copy, but does not create derived models automatically."
						: scope === "engine"
							? "This engine does not accept the extended sampler fields shown for llama.cpp, vLLM, and SGLang. Use Raw passthrough for request fields supported by this engine."
							: "Bind this agent to a local engine (llama.cpp, Ollama, vLLM, or SGLang) to unlock top-k, min-p, mirostat, DRY, and other advanced samplers."}
				</p>
			)}
			{scope === "engine" && engineId === "ollama" ? (
				<FieldGroup
					description="These Ollama-supported samplers are included in the generated Modelfile profile below."
					title="Ollama Modelfile sampling"
				>
					<FieldGrid>
						<NumberField
							label="Top K"
							min={0}
							onChange={(v) => setNumber("top_k", v)}
							step={1}
							value={num("top_k")}
						/>
						<NumberField
							label="Min P"
							max={1}
							min={0}
							onChange={(v) => setNumber("min_p", v)}
							step={0.01}
							value={num("min_p")}
						/>
						<NumberField
							label="Typical P"
							max={1}
							min={0}
							onChange={(v) => setNumber("typical_p", v)}
							step={0.01}
							value={num("typical_p")}
						/>
						<NumberField
							label="Repeat penalty"
							onChange={(v) => setNumber("repeat_penalty", v)}
							step={0.05}
							value={num("repeat_penalty")}
						/>
						<NumberField
							label="Repeat window"
							min={0}
							onChange={(v) => setNumber("repeat_last_n", v)}
							step={1}
							value={num("repeat_last_n")}
						/>
						<NumberField
							label="Mirostat mode"
							max={2}
							min={0}
							onChange={(v) => setNumber("mirostat", v)}
							step={1}
							value={num("mirostat")}
						/>
						<NumberField
							label="Mirostat tau"
							onChange={(v) => setNumber("mirostat_tau", v)}
							step={0.1}
							value={num("mirostat_tau")}
						/>
						<NumberField
							label="Mirostat eta"
							onChange={(v) => setNumber("mirostat_eta", v)}
							step={0.01}
							value={num("mirostat_eta")}
						/>
					</FieldGrid>
				</FieldGroup>
			) : null}
			{scope === "engine" && engineId === "mlx" ? (
				<FieldGroup
					description="MLX accepts repetition_penalty in its chat request body."
					title="MLX"
				>
					<NumberField
						label="Repetition penalty"
						onChange={(v) => setNumber("repeat_penalty", v)}
						step={0.05}
						value={num("repeat_penalty")}
					/>
				</FieldGroup>
			) : null}
		</>
	);
}
