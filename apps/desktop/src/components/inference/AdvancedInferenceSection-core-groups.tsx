// Sampling and penalty groups for AdvancedInferenceSection.

import type { SamplingFieldsProps } from "./AdvancedInferenceSection-rules.ts";
import {
	FieldGrid,
	FieldGroup,
	NumberField,
	StringListField,
} from "./fields.tsx";

/** Sampling and penalty field groups. */
export function SamplingCoreGroups({
	disabled,
	localEngine,
	num,
	set,
	setNumber,
	shows,
	supportedFields,
	value,
}: SamplingFieldsProps) {
	return (
		<>
			<FieldGroup title="Sampling">
				<FieldGrid>
					{shows("temperature") ? (
						<NumberField
							disabled={disabled}
							hint="0 = deterministic, higher = more random"
							label="Temperature"
							max={2}
							min={0}
							onChange={(v) => setNumber("temperature", v)}
							step={0.05}
							value={num("temperature")}
						/>
					) : null}
					{shows("top_p") ? (
						<NumberField
							disabled={disabled}
							label="Top P"
							max={1}
							min={0}
							onChange={(v) => setNumber("top_p", v)}
							step={0.05}
							value={num("top_p")}
						/>
					) : null}
					{shows("max_tokens") ? (
						<NumberField
							disabled={disabled}
							label="Max tokens"
							min={1}
							onChange={(v) => setNumber("max_tokens", v)}
							step={1}
							value={num("max_tokens")}
						/>
					) : null}
					{shows("seed") ? (
						<NumberField
							disabled={disabled}
							hint="Reproducible output when set"
							label="Seed"
							onChange={(v) => setNumber("seed", v)}
							step={1}
							value={num("seed")}
						/>
					) : null}
					{localEngine || supportedFields ? (
						<>
							{shows("top_k", localEngine) ? (
								<NumberField
									disabled={disabled}
									hint="Top-K tokens (0 = off)"
									label="Top K"
									min={0}
									onChange={(v) => setNumber("top_k", v)}
									step={1}
									value={num("top_k")}
								/>
							) : null}
							{shows("min_p", localEngine) ? (
								<NumberField
									disabled={disabled}
									label="Min P"
									max={1}
									min={0}
									onChange={(v) => setNumber("min_p", v)}
									step={0.01}
									value={num("min_p")}
								/>
							) : null}
							{shows("typical_p", localEngine) ? (
								<NumberField
									disabled={disabled}
									label="Typical P"
									max={1}
									min={0}
									onChange={(v) => setNumber("typical_p", v)}
									step={0.01}
									value={num("typical_p")}
								/>
							) : null}
							{shows("top_n_sigma", localEngine) ? (
								<NumberField
									disabled={disabled}
									label="Top-N sigma"
									onChange={(v) => setNumber("top_n_sigma", v)}
									step={0.1}
									value={num("top_n_sigma")}
								/>
							) : null}
						</>
					) : null}
				</FieldGrid>
				{shows("stop") ? (
					<StringListField
						disabled={disabled}
						hint="Generation halts at any of these strings"
						label="Stop sequences"
						onChange={(v) => set("stop", v)}
						placeholder="e.g. ###, </s>"
						value={value.stop}
					/>
				) : null}
			</FieldGroup>

			<FieldGroup title="Penalties">
				<FieldGrid>
					{shows("frequency_penalty") ? (
						<NumberField
							disabled={disabled}
							label="Frequency penalty"
							max={2}
							min={-2}
							onChange={(v) => setNumber("frequency_penalty", v)}
							step={0.05}
							value={num("frequency_penalty")}
						/>
					) : null}
					{shows("presence_penalty") ? (
						<NumberField
							disabled={disabled}
							label="Presence penalty"
							max={2}
							min={-2}
							onChange={(v) => setNumber("presence_penalty", v)}
							step={0.05}
							value={num("presence_penalty")}
						/>
					) : null}
					{localEngine || supportedFields ? (
						<>
							{shows("repeat_penalty", localEngine) ? (
								<NumberField
									disabled={disabled}
									hint="1.0 = off"
									label="Repeat penalty"
									onChange={(v) => setNumber("repeat_penalty", v)}
									step={0.05}
									value={num("repeat_penalty")}
								/>
							) : null}
							{shows("repeat_last_n", localEngine) ? (
								<NumberField
									disabled={disabled}
									hint="Tokens to scan (-1 = ctx)"
									label="Repeat last N"
									onChange={(v) => setNumber("repeat_last_n", v)}
									step={1}
									value={num("repeat_last_n")}
								/>
							) : null}
						</>
					) : null}
				</FieldGrid>
			</FieldGroup>
		</>
	);
}
