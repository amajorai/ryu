// apps/desktop/src/components/inference/AdvancedInferenceSection.tsx
//
// Collapsible "Advanced inference" editor for an agent's per-request SAMPLING
// defaults (temperature, top_p, penalties, mirostat, DRY/XTC, raw passthrough).
// Standard OpenAI fields show for every agent; the non-standard sampler fields
// only show when the agent's chat engine is a local engine (llama.cpp / Ollama /
// vLLM / SGLang), since a remote OpenAI endpoint rejects them.

import { ArrowDown01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Label } from "@ryu/ui/components/label";
import { Textarea } from "@ryu/ui/components/textarea";
import { useMemo, useState } from "react";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { SamplingConfig } from "@/src/lib/api/inference.ts";
import {
	EnumField,
	FieldGrid,
	FieldGroup,
	NumberField,
	StringListField,
	TextField,
} from "./fields.tsx";

type Key = keyof SamplingConfig;

/**
 * A validated JSON-object editor (used for response_format and logit_bias).
 * Empty text clears the field; invalid or non-object JSON shows an inline error
 * and leaves the last valid value in place. Mirrors the raw-passthrough editor.
 */
function JsonObjectField({
	id,
	label,
	hint,
	placeholder,
	value,
	onChange,
	disabled,
}: {
	id: string;
	label: string;
	hint?: string;
	placeholder?: string;
	value: Record<string, unknown> | undefined;
	onChange: (v: Record<string, unknown> | undefined) => void;
	disabled?: boolean;
}) {
	const [text, setText] = useState<string>(() =>
		value && Object.keys(value).length > 0 ? JSON.stringify(value, null, 2) : ""
	);
	const [error, setError] = useState<string | null>(null);

	const handle = (next: string) => {
		setText(next);
		if (next.trim() === "") {
			setError(null);
			onChange(undefined);
			return;
		}
		try {
			const parsed = JSON.parse(next) as unknown;
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				Array.isArray(parsed)
			) {
				setError("Must be a JSON object");
				return;
			}
			setError(null);
			onChange(parsed as Record<string, unknown>);
		} catch {
			setError("Invalid JSON");
		}
	};

	return (
		<div className="flex flex-col gap-1.5">
			<Label htmlFor={id}>{label}</Label>
			<Textarea
				className="min-h-20 font-mono text-xs"
				disabled={disabled}
				id={id}
				onChange={(e) => handle(e.target.value)}
				placeholder={placeholder}
				value={text}
			/>
			{error ? <p className="text-destructive text-xs">{error}</p> : null}
			{hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
		</div>
	);
}

export function AdvancedInferenceSection({
	value,
	onChange,
	disabled,
	localEngine,
}: {
	value: SamplingConfig;
	onChange: (next: SamplingConfig) => void;
	disabled?: boolean;
	/** True when the agent's chat engine accepts the non-standard sampler fields. */
	localEngine: boolean;
}) {
	const [open, setOpen] = useState(false);

	// Set or clear a single field, returning a fresh object (no key when unset).
	const set = useMemo(
		() =>
			<K extends Key>(key: K, v: SamplingConfig[K] | undefined): void => {
				const next: SamplingConfig = { ...value };
				if (v === undefined) {
					delete next[key];
				} else {
					next[key] = v;
				}
				onChange(next);
			},
		[value, onChange]
	);

	const num = (key: Key) => (value[key] as number | undefined) ?? undefined;

	// The raw `extra` passthrough is edited as JSON text with inline validation.
	const [extraText, setExtraText] = useState<string>(() =>
		value.extra && Object.keys(value.extra).length > 0
			? JSON.stringify(value.extra, null, 2)
			: ""
	);
	const [extraError, setExtraError] = useState<string | null>(null);

	const onExtraChange = (text: string) => {
		setExtraText(text);
		if (text.trim() === "") {
			setExtraError(null);
			set("extra", undefined);
			return;
		}
		try {
			const parsed = JSON.parse(text) as unknown;
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				Array.isArray(parsed)
			) {
				setExtraError("Must be a JSON object");
				return;
			}
			setExtraError(null);
			set("extra", parsed as Record<string, unknown>);
		} catch {
			setExtraError("Invalid JSON");
		}
	};

	return (
		<section aria-label="Advanced inference" className="flex flex-col gap-2">
			<button
				className="flex w-full items-center gap-2 rounded-lg bg-card px-4 py-3 text-left hover:bg-muted/50"
				onClick={() => setOpen((o) => !o)}
				type="button"
			>
				<span className="font-semibold text-sm">Advanced inference</span>
				<span className="ml-auto text-muted-foreground">
					<HugeiconsIcon
						className="size-4"
						icon={open ? ArrowDown01Icon : ArrowRight01Icon}
					/>
				</span>
			</button>

			{open ? (
				<SettingsSection caption="Sampling defaults applied to every chat turn for this agent. Leave a field blank to use the engine default.">
					<SettingsCard className="flex flex-col gap-6">
						<FieldGroup title="Sampling">
							<FieldGrid>
								<NumberField
									disabled={disabled}
									hint="0 = deterministic, higher = more random"
									label="Temperature"
									max={2}
									min={0}
									onChange={(v) => set("temperature", v)}
									step={0.05}
									value={num("temperature")}
								/>
								<NumberField
									disabled={disabled}
									label="Top P"
									max={1}
									min={0}
									onChange={(v) => set("top_p", v)}
									step={0.05}
									value={num("top_p")}
								/>
								<NumberField
									disabled={disabled}
									label="Max tokens"
									min={1}
									onChange={(v) => set("max_tokens", v)}
									step={1}
									value={num("max_tokens")}
								/>
								<NumberField
									disabled={disabled}
									hint="Reproducible output when set"
									label="Seed"
									onChange={(v) => set("seed", v)}
									step={1}
									value={num("seed")}
								/>
								{localEngine ? (
									<>
										<NumberField
											disabled={disabled}
											hint="Top-K tokens (0 = off)"
											label="Top K"
											min={0}
											onChange={(v) => set("top_k", v)}
											step={1}
											value={num("top_k")}
										/>
										<NumberField
											disabled={disabled}
											label="Min P"
											max={1}
											min={0}
											onChange={(v) => set("min_p", v)}
											step={0.01}
											value={num("min_p")}
										/>
										<NumberField
											disabled={disabled}
											label="Typical P"
											max={1}
											min={0}
											onChange={(v) => set("typical_p", v)}
											step={0.01}
											value={num("typical_p")}
										/>
										<NumberField
											disabled={disabled}
											label="Top-N sigma"
											onChange={(v) => set("top_n_sigma", v)}
											step={0.1}
											value={num("top_n_sigma")}
										/>
									</>
								) : null}
							</FieldGrid>
							<StringListField
								disabled={disabled}
								hint="Generation halts at any of these strings"
								label="Stop sequences"
								onChange={(v) => set("stop", v)}
								placeholder="e.g. ###, </s>"
								value={value.stop}
							/>
						</FieldGroup>

						<FieldGroup title="Penalties">
							<FieldGrid>
								<NumberField
									disabled={disabled}
									label="Frequency penalty"
									max={2}
									min={-2}
									onChange={(v) => set("frequency_penalty", v)}
									step={0.05}
									value={num("frequency_penalty")}
								/>
								<NumberField
									disabled={disabled}
									label="Presence penalty"
									max={2}
									min={-2}
									onChange={(v) => set("presence_penalty", v)}
									step={0.05}
									value={num("presence_penalty")}
								/>
								{localEngine ? (
									<>
										<NumberField
											disabled={disabled}
											hint="1.0 = off"
											label="Repeat penalty"
											onChange={(v) => set("repeat_penalty", v)}
											step={0.05}
											value={num("repeat_penalty")}
										/>
										<NumberField
											disabled={disabled}
											hint="Tokens to scan (-1 = ctx)"
											label="Repeat last N"
											onChange={(v) => set("repeat_last_n", v)}
											step={1}
											value={num("repeat_last_n")}
										/>
									</>
								) : null}
							</FieldGrid>
						</FieldGroup>

						{localEngine ? (
							<>
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
											onChange={(v) => set("mirostat_tau", v)}
											step={0.1}
											value={num("mirostat_tau")}
										/>
										<NumberField
											disabled={disabled}
											label="Eta (learning rate)"
											onChange={(v) => set("mirostat_eta", v)}
											step={0.01}
											value={num("mirostat_eta")}
										/>
									</FieldGrid>
								</FieldGroup>

								<FieldGroup
									description="llama.cpp dynamic-temperature, XTC, and DRY repetition controls."
									title="Advanced samplers"
								>
									<FieldGrid>
										<NumberField
											disabled={disabled}
											label="DynaTemp range"
											onChange={(v) => set("dynatemp_range", v)}
											step={0.05}
											value={num("dynatemp_range")}
										/>
										<NumberField
											disabled={disabled}
											label="DynaTemp exponent"
											onChange={(v) => set("dynatemp_exponent", v)}
											step={0.05}
											value={num("dynatemp_exponent")}
										/>
										<NumberField
											disabled={disabled}
											label="XTC probability"
											max={1}
											min={0}
											onChange={(v) => set("xtc_probability", v)}
											step={0.01}
											value={num("xtc_probability")}
										/>
										<NumberField
											disabled={disabled}
											label="XTC threshold"
											onChange={(v) => set("xtc_threshold", v)}
											step={0.01}
											value={num("xtc_threshold")}
										/>
										<NumberField
											disabled={disabled}
											label="DRY multiplier"
											onChange={(v) => set("dry_multiplier", v)}
											step={0.05}
											value={num("dry_multiplier")}
										/>
										<NumberField
											disabled={disabled}
											label="DRY base"
											onChange={(v) => set("dry_base", v)}
											step={0.05}
											value={num("dry_base")}
										/>
										<NumberField
											disabled={disabled}
											label="DRY allowed length"
											onChange={(v) => set("dry_allowed_length", v)}
											step={1}
											value={num("dry_allowed_length")}
										/>
										<NumberField
											disabled={disabled}
											label="DRY penalty last N"
											onChange={(v) => set("dry_penalty_last_n", v)}
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
							</>
						) : (
							<p className="rounded-md border border-dashed px-3 py-2 text-muted-foreground text-xs">
								Bind this agent to a local engine (llama.cpp, Ollama, vLLM, or
								SGLang) to unlock top-k, min-p, mirostat, DRY, and other
								advanced samplers.
							</p>
						)}

						<FieldGroup
							description="Force the shape of the output: prefill the reply, constrain it to JSON or a grammar, or bias individual tokens."
							title="Output control"
						>
							<TextField
								disabled={disabled}
								hint="Assistant reply is forced to start with this text (e.g. { to force JSON)."
								label="Prefill"
								onChange={(v) => set("prefill", v)}
								value={value.prefill}
							/>
							<JsonObjectField
								disabled={disabled}
								hint='OpenAI response_format, e.g. {"type":"json_object"} or a json_schema block.'
								id="sampling-response-format"
								label="Response format (JSON)"
								onChange={(v) => set("response_format", v)}
								placeholder={'{\n  "type": "json_object"\n}'}
								value={value.response_format}
							/>
							<JsonObjectField
								disabled={disabled}
								hint="Token-id to bias (~ -100..100). -100 bans a token, +100 forces it."
								id="sampling-logit-bias"
								label="Logit bias (JSON)"
								onChange={(v) =>
									set("logit_bias", v as Record<string, number> | undefined)
								}
								placeholder={'{\n  "50256": -100\n}'}
								value={value.logit_bias}
							/>
							{localEngine ? (
								<div className="flex flex-col gap-1.5">
									<Label htmlFor="sampling-grammar">
										Grammar (GBNF, llama.cpp)
									</Label>
									<Textarea
										className="min-h-20 font-mono text-xs"
										disabled={disabled}
										id="sampling-grammar"
										onChange={(e) =>
											set(
												"grammar",
												e.target.value === "" ? undefined : e.target.value
											)
										}
										placeholder={'root ::= "yes" | "no"'}
										value={value.grammar ?? ""}
									/>
									<p className="text-muted-foreground text-xs">
										Constrains decoding to a GBNF grammar. llama.cpp only.
									</p>
								</div>
							) : null}
						</FieldGroup>

						<FieldGroup
							description="Raw JSON merged verbatim into the request body, overriding the fields above. Use for engine knobs not listed here."
							title="Raw passthrough"
						>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="sampling-extra">Extra body fields (JSON)</Label>
								<Textarea
									className="min-h-24 font-mono text-xs"
									disabled={disabled}
									id="sampling-extra"
									onChange={(e) => onExtraChange(e.target.value)}
									placeholder={'{\n  "min_keep": 1\n}'}
									value={extraText}
								/>
								{extraError ? (
									<p className="text-destructive text-xs">{extraError}</p>
								) : null}
							</div>
						</FieldGroup>
					</SettingsCard>
				</SettingsSection>
			) : null}
		</section>
	);
}
