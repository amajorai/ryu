import { z } from "zod";
// apps/desktop/src/components/inference/AdvancedInferenceSection.tsx
//
// Collapsible "Advanced inference" editor for per-request SAMPLING defaults
// (temperature, top_p, penalties, mirostat, DRY/XTC, raw passthrough) at agent,
// engine, or model scope. Standard OpenAI fields show everywhere; non-standard
// samplers show only for runtimes that read them. Model scope passes the exact
// field list Core reports for the model's engine or cloud provider, so a cloud
// model shows Top K only where its provider accepts it.

import { ArrowDown01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
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

const jsonObjectSchema = z.record(z.string(), z.json());
const logitBiasSchema = z.record(
	z.string().regex(/^\d+$/),
	z.number().min(-100).max(100)
);
type Key = keyof SamplingConfig;

type NumberKey = {
	[K in Key]-?: Exclude<SamplingConfig[K], undefined> extends number
		? K
		: never;
}[Key];

interface SamplingNumberRule {
	integer?: boolean;
	label: string;
	max?: number;
	min?: number;
}

const SAMPLING_NUMBER_RULES = new Map<Key, SamplingNumberRule>([
	["dry_allowed_length", { integer: true, label: "DRY allowed length" }],
	["dry_penalty_last_n", { integer: true, label: "DRY penalty last N" }],
	[
		"frequency_penalty",
		{
			label: "Frequency penalty",
			max: 2,
			min: -2,
		},
	],
	["max_tokens", { integer: true, label: "Max tokens", min: 1 }],
	["mirostat", { integer: true, label: "Mirostat mode", max: 2, min: 0 }],
	["mirostat_eta", { label: "Mirostat eta", min: 0 }],
	["mirostat_tau", { label: "Mirostat tau", min: 0 }],
	["min_p", { label: "Min P", max: 1, min: 0 }],
	[
		"presence_penalty",
		{
			label: "Presence penalty",
			max: 2,
			min: -2,
		},
	],
	["repeat_last_n", { integer: true, label: "Repeat last N" }],
	["repeat_penalty", { label: "Repeat penalty", min: 0 }],
	["seed", { integer: true, label: "Seed" }],
	["temperature", { label: "Temperature", max: 2, min: 0 }],
	["top_k", { integer: true, label: "Top K", min: 0 }],
	["top_p", { label: "Top P", max: 1, min: 0 }],
	["typical_p", { label: "Typical P", max: 1, min: 0 }],
	["xtc_probability", { label: "XTC probability", max: 1, min: 0 }],
]);

export type SamplingScope = "agent" | "engine" | "model";

function samplingNumberError(
	key: Key,
	value: number,
	scope: SamplingScope,
	engineId?: string
): string | null {
	const rule = SAMPLING_NUMBER_RULES.get(key);
	if (!Number.isFinite(value)) {
		return `${rule?.label ?? key} must be a finite number.`;
	}
	if (
		scope === "engine" &&
		engineId === "ollama" &&
		key === "repeat_last_n" &&
		value < 0
	) {
		return "Repeat window must be at least 0.";
	}
	if (rule?.integer && !Number.isSafeInteger(value)) {
		return `${rule.label} must be a whole number.`;
	}
	if (rule?.min !== undefined && value < rule.min) {
		return `${rule.label} must be at least ${rule.min}.`;
	}
	if (rule?.max !== undefined && value > rule.max) {
		return `${rule.label} must be no greater than ${rule.max}.`;
	}
	return null;
}

/**
 * A validated JSON-object editor (used for response_format and logit_bias).
 * Empty text clears the field; invalid or non-object JSON shows an inline error
 * and leaves the last valid value in place. Mirrors the raw-passthrough editor.
 */
function JsonObjectField<TValue extends z.infer<typeof jsonObjectSchema>>({
	id,
	label,
	hint,
	placeholder,
	value,
	onChange,
	disabled,
	schema,
}: {
	id: string;
	label: string;
	hint?: string;
	placeholder?: string;
	value: SamplingConfig["response_format"];
	onChange: (v: TValue | undefined) => void;
	disabled?: boolean;
	schema: z.ZodType<TValue>;
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
			const parsed = schema.safeParse(JSON.parse(next));
			if (!parsed.success) {
				setError(parsed.error.issues[0]?.message ?? "Must be a JSON object");
				return;
			}
			setError(null);
			onChange(parsed.data);
		} catch {
			setError("Invalid JSON");
		}
	};

	return (
		<div className="flex flex-col gap-1.5">
			<Label htmlFor={id}>{label}</Label>
			<Textarea
				aria-invalid={Boolean(error)}
				className="min-h-20"
				disabled={disabled}
				id={id}
				onChange={(e) => handle(e.target.value)}
				placeholder={placeholder}
				value={text}
				variant="code-caption"
			/>
			{error ? (
				<p className="text-status-destructive text-xs" role="alert">
					{error}
				</p>
			) : null}
			{hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
		</div>
	);
}

export function AdvancedInferenceSection({
	value,
	onChange,
	disabled,
	localEngine,
	scope = "agent",
	engineId,
	onSave,
	saving = false,
	saved = false,
	saveError,
	supportedFields,
	defaultOpen = false,
}: {
	value: SamplingConfig;
	onChange: (next: SamplingConfig) => void;
	disabled?: boolean;
	/** True when the selected Chat runtime accepts the non-standard sampler fields. */
	localEngine: boolean;
	/** Engine scope saves defaults for every agent using this runtime. */
	scope?: SamplingScope;
	/**
	 * Exact field names the target model honours (Core's
	 * `/api/inference/sampling-fields`). When set, it replaces the coarse
	 * `localEngine` gate field by field.
	 */
	supportedFields?: ReadonlySet<string>;
	defaultOpen?: boolean;
	/** Runtime id when rendering engine-scoped defaults. */
	engineId?: string;
	onSave?: () => void;
	saving?: boolean;
	saved?: boolean;
	saveError?: string | null;
}) {
	const [open, setOpen] = useState(defaultOpen);
	// Whether a field renders: the reported field list wins; otherwise standard
	// fields always show and extensions follow the legacy local-engine gate.
	const shows = (key: Key, legacy = true): boolean =>
		supportedFields ? supportedFields.has(key) : legacy;
	const [numberErrors, setNumberErrors] = useState<
		Partial<Record<Key, string>>
	>({});
	const [numberDrafts, setNumberDrafts] = useState<
		Partial<Record<Key, number>>
	>({});

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

	const num = (key: NumberKey) => numberDrafts[key] ?? value[key] ?? undefined;
	const setNumber = (key: Key, nextValue: number | undefined) => {
		if (nextValue === undefined) {
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
		const error = samplingNumberError(key, nextValue, scope, engineId);
		if (error) {
			setNumberErrors((current) => ({ ...current, [key]: error }));
			setNumberDrafts((current) => ({ ...current, [key]: nextValue }));
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
		set(key, nextValue);
	};

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
			const parsed = jsonObjectSchema.safeParse(JSON.parse(text));
			if (!parsed.success) {
				setExtraError("Must be a JSON object");
				return;
			}
			setExtraError(null);
			set("extra", parsed.data);
		} catch {
			setExtraError("Invalid JSON");
		}
	};

	return (
		<section
			aria-label={
				scope === "engine"
					? "Engine sampling defaults"
					: scope === "model"
						? "Model sampling parameters"
						: "Advanced inference"
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
					{scope === "engine"
						? "Sampling defaults"
						: scope === "model"
							? "Sampling parameters"
							: "Advanced inference"}
				</span>
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
						scope === "engine"
							? "Defaults for every chat turn sent to this engine. These settings override legacy agent defaults; request overrides still take precedence. Leave a field blank to use the engine default."
							: scope === "model"
								? "Applied to every chat turn that uses this model on this node, on top of engine defaults. Only parameters this model accepts are shown. Leave a field blank to use the default."
								: "Sampling defaults applied to every chat turn for this agent. Leave a field blank to use the engine default."
					}
				>
					{Object.entries(numberErrors).map(([key, message]) => (
						<p
							className="text-status-destructive text-xs"
							key={key}
							role="alert"
						>
							{message}
						</p>
					))}
					<SettingsCard className="flex flex-col gap-6">
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
													set(
														"mirostat",
														v === undefined ? undefined : Number(v)
													)
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
							<p className="rounded-md border border-dashed px-3 py-2 text-muted-foreground text-xs">
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

						<FieldGroup
							description="Force the shape of the output: prefill the reply, constrain it to JSON or a grammar, or bias individual tokens."
							title="Output control"
						>
							{shows("prefill") ? (
								<TextField
									disabled={disabled}
									hint="Assistant reply is forced to start with this text (e.g. { to force JSON)."
									label="Prefill"
									onChange={(v) => set("prefill", v)}
									value={value.prefill}
								/>
							) : null}
							{shows("response_format") ? (
								<JsonObjectField
									disabled={disabled}
									hint='OpenAI response_format, e.g. {"type":"json_object"} or a json_schema block.'
									id="sampling-response-format"
									label="Response format (JSON)"
									onChange={(v) => set("response_format", v)}
									placeholder={'{\n  "type": "json_object"\n}'}
									schema={jsonObjectSchema}
									value={value.response_format}
								/>
							) : null}
							{shows("logit_bias") ? (
								<JsonObjectField
									disabled={disabled}
									hint="Token-id to bias (~ -100..100). -100 bans a token, +100 forces it."
									id="sampling-logit-bias"
									label="Logit bias (JSON)"
									onChange={(v) => set("logit_bias", v)}
									placeholder={'{\n  "50256": -100\n}'}
									schema={logitBiasSchema}
									value={value.logit_bias}
								/>
							) : null}
							{shows("grammar", localEngine) ? (
								<div className="flex flex-col gap-1.5">
									<Label htmlFor="sampling-grammar">
										Grammar (GBNF, llama.cpp)
									</Label>
									<Textarea
										className="min-h-20"
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
										variant="code-caption"
									/>
									<p className="text-muted-foreground text-xs">
										Constrains decoding to a GBNF grammar. llama.cpp only.
									</p>
								</div>
							) : null}
						</FieldGroup>

						{shows("extra") ? (
							<FieldGroup
								description="Raw JSON merged verbatim into the request body, overriding the fields above. Use for engine knobs not listed here."
								title="Raw passthrough"
							>
								<div className="flex flex-col gap-1.5">
									<Label htmlFor="sampling-extra">
										Extra body fields (JSON)
									</Label>
									<Textarea
										className="min-h-24"
										disabled={disabled}
										id="sampling-extra"
										onChange={(e) => onExtraChange(e.target.value)}
										placeholder={'{\n  "min_keep": 1\n}'}
										value={extraText}
										variant="code-caption"
									/>
									{extraError ? (
										<p className="text-status-destructive text-xs" role="alert">
											{extraError}
										</p>
									) : null}
								</div>
							</FieldGroup>
						) : null}
						{onSave ? (
							<div className="flex items-center gap-2">
								<Button
									disabled={disabled || saving || Boolean(extraError)}
									loading={saving}
									onClick={onSave}
								>
									{scope === "model"
										? "Save model parameters"
										: "Save sampling defaults"}
								</Button>
								{saved ? (
									<span className="text-muted-foreground text-xs">
										{scope === "model"
											? "Saved for this model"
											: "Saved for this engine"}
									</span>
								) : null}
								{saveError ? (
									<p className="text-status-destructive text-xs" role="alert">
										{saveError}
									</p>
								) : null}
							</div>
						) : null}
					</SettingsCard>
				</SettingsSection>
			) : null}
		</section>
	);
}
