import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
/* @jsxImportSource @opentui/react */

import { useKeyboard } from "@opentui/react";
import { request } from "@ryuhq/core-client/client";
import { type Engine, fetchEngines } from "@ryuhq/core-client/engines";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { Card } from "@/components/ui/card.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useCore } from "../../core/CoreContext.tsx";

const inferenceJsonSchema = z.json();
type InferenceValue = z.infer<typeof inferenceJsonSchema> | undefined;
export const inferenceConfigurationSchema = z.record(
	z.string(),
	inferenceJsonSchema
);
export type JsonObject = z.infer<typeof inferenceConfigurationSchema>;
const inferenceScalarSchema = z.union([
	z.string(),
	z.number(),
	z.boolean(),
	z.null(),
]);
const inferenceStringSchema = z.string();
const inferenceStringArraySchema = z.array(inferenceStringSchema);
const inferenceLogitBiasSchema = z.number().min(-100).max(100);
const inferenceErrorSchema = z.instanceof(Error);
const inferencePreferenceSchema = z.object({
	value: z.string().nullable().optional(),
});
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

function launchFieldsForEngine(engineName: string): readonly SamplingField[] {
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

function isRecord(value: InferenceValue): value is JsonObject {
	return (
		value !== undefined &&
		!Array.isArray(value) &&
		!inferenceScalarSchema.safeParse(value).success
	);
}

function parsePreference(raw: string | null | undefined): JsonObject {
	if (!raw) {
		return {};
	}
	const parsed = inferenceJsonSchema.parse(JSON.parse(raw));
	return isRecord(parsed) ? parsed : {};
}

function preferenceKey(engineName: string): string {
	return `inference.engine.${engineName}`;
}

function launchPreferenceKey(engineName: string): string {
	return `model.launch.engine.${engineName}`;
}

async function readSamplingPreference(
	target: ReturnType<typeof useCore>["target"],
	engineName: string
): Promise<JsonObject> {
	const key = preferenceKey(engineName);
	const result = inferencePreferenceSchema.parse(
		await request(
			target,
			`/api/preferences/${encodeURIComponent(key)}`,
			{},
			appResponseValueSchema
		)
	);
	return parsePreference(result.value);
}

async function readLaunchPreference(
	target: ReturnType<typeof useCore>["target"],
	engineName: string
): Promise<JsonObject> {
	const key = launchPreferenceKey(engineName);
	const result = inferencePreferenceSchema.parse(
		await request(
			target,
			`/api/preferences/${encodeURIComponent(key)}`,
			{},
			appResponseValueSchema
		)
	);
	return parsePreference(result.value);
}

export function editorText(
	fieldDefinition: SamplingField,
	value: InferenceValue
): string {
	if (value === undefined || value === null) {
		return "";
	}
	if (
		fieldDefinition.kind === "object" ||
		fieldDefinition.kind === "logit-bias" ||
		fieldDefinition.kind === "string-array"
	) {
		return JSON.stringify(value);
	}
	return String(value);
}

export type ParsedEdit =
	| { error: null; value: InferenceValue }
	| { error: string; value?: never };

export function parseEdit(
	fieldDefinition: SamplingField,
	raw: string
): ParsedEdit {
	if (!raw.trim()) {
		return { error: null, value: undefined };
	}
	if (fieldDefinition.kind === "number") {
		const value = Number(raw);
		if (!Number.isFinite(value)) {
			return { error: `${fieldDefinition.label} must be a finite number.` };
		}
		if (fieldDefinition.integer && !Number.isSafeInteger(value)) {
			return { error: `${fieldDefinition.label} must be a whole number.` };
		}
		if (fieldDefinition.min !== undefined && value < fieldDefinition.min) {
			return {
				error: `${fieldDefinition.label} must be at least ${fieldDefinition.min}.`,
			};
		}
		if (fieldDefinition.max !== undefined && value > fieldDefinition.max) {
			return {
				error: `${fieldDefinition.label} must be no greater than ${fieldDefinition.max}.`,
			};
		}
		return { error: null, value };
	}
	if (fieldDefinition.kind === "text") {
		return { error: null, value: raw };
	}
	let parsed: InferenceValue;
	try {
		parsed = inferenceJsonSchema.parse(JSON.parse(raw));
	} catch {
		return { error: "Invalid JSON." };
	}
	if (fieldDefinition.kind === "string-array") {
		return inferenceStringArraySchema.safeParse(parsed).success
			? { error: null, value: parsed }
			: { error: `${fieldDefinition.label} must be a JSON array of strings.` };
	}
	if (!isRecord(parsed)) {
		return { error: "Must be a JSON object." };
	}
	if (fieldDefinition.kind === "logit-bias") {
		for (const [tokenId, bias] of Object.entries(parsed)) {
			if (!/^\d+$/.test(tokenId)) {
				return { error: "Token IDs must be non-negative integers." };
			}
			if (!inferenceLogitBiasSchema.safeParse(bias).success) {
				return { error: "Bias values must be numbers from -100 to 100." };
			}
		}
	}
	return { error: null, value: parsed };
}

export function withFieldValue(
	config: JsonObject,
	fieldKey: string,
	value: InferenceValue
): JsonObject {
	const next = { ...config };
	if (value === undefined) {
		delete next[fieldKey];
	} else {
		next[fieldKey] = value;
	}
	return next;
}

export function valueLabel(value: InferenceValue): string {
	if (value === undefined || value === null || value === "") {
		return "engine default";
	}
	const parsedString = inferenceStringSchema.safeParse(value);
	if (parsedString.success) {
		return parsedString.data;
	}
	const rendered = JSON.stringify(value);
	return rendered ?? String(value);
}

function errorText(
	error: Parameters<typeof inferenceErrorSchema.safeParse>[0]
): string {
	const parsed = inferenceErrorSchema.safeParse(error);
	return parsed.success ? parsed.data.message : String(error);
}

/** Core-backed engine-wide inference defaults matching Desktop's editor. */
export function InferenceSettingsPanel({
	active,
	onNavigationOwnershipChange,
}: {
	active: boolean;
	onNavigationOwnershipChange: (owned: boolean) => void;
}) {
	const { target } = useCore();
	const theme = useTheme();
	const [engines, setEngines] = useState<Engine[]>([]);
	const [engineIndex, setEngineIndex] = useState(0);
	const [engineLoading, setEngineLoading] = useState(false);
	const [engineError, setEngineError] = useState<string | null>(null);
	const [section, setSection] = useState<"sampling" | "launch">("sampling");
	const [configLoading, setConfigLoading] = useState(false);
	const [configError, setConfigError] = useState<string | null>(null);
	const [draft, setDraft] = useState<JsonObject>({});
	const [launchConfigLoading, setLaunchConfigLoading] = useState(false);
	const [launchConfigError, setLaunchConfigError] = useState<string | null>(
		null
	);
	const [launchDraft, setLaunchDraft] = useState<JsonObject>({});
	const [selectedFieldIndex, setSelectedFieldIndex] = useState(0);
	const [editing, setEditing] = useState(false);
	const [editText, setEditText] = useState("");
	const [editError, setEditError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [launchSaving, setLaunchSaving] = useState(false);
	const [launchSaveError, setLaunchSaveError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const engineRequestRef = useRef(0);
	const configRequestRef = useRef(0);
	const launchConfigRequestRef = useRef(0);
	const editOriginalRef = useRef<{ key: string; value: InferenceValue } | null>(
		null
	);

	const selectedEngine = engines[engineIndex] ?? null;
	const samplingFields = useMemo(
		() => fieldsForEngine(selectedEngine?.name ?? ""),
		[selectedEngine?.name]
	);
	const launchFields = useMemo(
		() => launchFieldsForEngine(selectedEngine?.name ?? ""),
		[selectedEngine?.name]
	);
	const fields = section === "launch" ? launchFields : samplingFields;
	const currentDraft = section === "launch" ? launchDraft : draft;
	const currentLoading =
		section === "launch" ? launchConfigLoading : configLoading;
	const currentError = section === "launch" ? launchConfigError : configError;
	const currentSaving = section === "launch" ? launchSaving : saving;
	const currentSaveError = section === "launch" ? launchSaveError : saveError;
	const setCurrentDraft = section === "launch" ? setLaunchDraft : setDraft;
	const setCurrentSaveError =
		section === "launch" ? setLaunchSaveError : setSaveError;
	const setCurrentSaving = section === "launch" ? setLaunchSaving : setSaving;
	const selectedField = fields[Math.min(selectedFieldIndex, fields.length - 1)];

	const loadEngines = useCallback(async () => {
		const requestId = ++engineRequestRef.current;
		setEngineLoading(true);
		setEngineError(null);
		try {
			const nextEngines = await fetchEngines(target);
			if (engineRequestRef.current !== requestId) {
				return;
			}
			setEngines(nextEngines);
			setEngineIndex((current) =>
				Math.min(current, Math.max(0, nextEngines.length - 1))
			);
		} catch (error) {
			if (engineRequestRef.current === requestId) {
				setEngineError(errorText(error));
			}
		} finally {
			if (engineRequestRef.current === requestId) {
				setEngineLoading(false);
			}
		}
	}, [target]);

	const loadConfig = useCallback(
		async (engineName: string) => {
			const requestId = ++configRequestRef.current;
			setConfigLoading(true);
			setConfigError(null);
			setSaveError(null);
			setNotice(null);
			try {
				const config = await readSamplingPreference(target, engineName);
				if (configRequestRef.current === requestId) {
					setDraft(config);
					setSelectedFieldIndex(0);
				}
			} catch (error) {
				if (configRequestRef.current === requestId) {
					setConfigError(errorText(error));
				}
			} finally {
				if (configRequestRef.current === requestId) {
					setConfigLoading(false);
				}
			}
		},
		[target]
	);

	const loadLaunchConfig = useCallback(
		async (engineName: string) => {
			const requestId = ++launchConfigRequestRef.current;
			setLaunchConfigLoading(true);
			setLaunchConfigError(null);
			setLaunchSaveError(null);
			setNotice(null);
			try {
				const config = await readLaunchPreference(target, engineName);
				if (launchConfigRequestRef.current === requestId) {
					setLaunchDraft(config);
					setSelectedFieldIndex(0);
				}
			} catch (error) {
				if (launchConfigRequestRef.current === requestId) {
					setLaunchConfigError(errorText(error));
				}
			} finally {
				if (launchConfigRequestRef.current === requestId) {
					setLaunchConfigLoading(false);
				}
			}
		},
		[target]
	);

	useEffect(() => {
		if (!active) {
			return;
		}
		onNavigationOwnershipChange(true);
		void loadEngines();
		return () => {
			engineRequestRef.current++;
			configRequestRef.current++;
			launchConfigRequestRef.current++;
			onNavigationOwnershipChange(false);
		};
	}, [active, loadEngines, onNavigationOwnershipChange]);

	useEffect(() => {
		if (!(active && selectedEngine)) {
			return;
		}
		if (section === "sampling") {
			void loadConfig(selectedEngine.name);
			return;
		}
		if (launchFieldsForEngine(selectedEngine.name).length > 0) {
			void loadLaunchConfig(selectedEngine.name);
		} else {
			launchConfigRequestRef.current++;
			setLaunchConfigLoading(false);
			setLaunchConfigError(null);
			setLaunchSaveError(null);
			setLaunchDraft({});
		}
	}, [active, loadConfig, loadLaunchConfig, section, selectedEngine?.name]);

	const beginEdit = useCallback(() => {
		if (
			!(selectedField && selectedEngine) ||
			currentLoading ||
			currentError ||
			currentSaving
		) {
			return;
		}
		editOriginalRef.current = {
			key: selectedField.key,
			value: currentDraft[selectedField.key],
		};
		setEditText(editorText(selectedField, currentDraft[selectedField.key]));
		setEditError(null);
		setCurrentSaveError(null);
		setNotice(null);
		setEditing(true);
	}, [
		currentDraft,
		currentError,
		currentLoading,
		currentSaving,
		selectedEngine,
		selectedField,
		setCurrentSaveError,
	]);

	const applyEditorText = useCallback(
		(value: string) => {
			setEditText(value);
			if (!selectedField) {
				return;
			}
			const parsed = parseEdit(selectedField, value);
			setEditError(parsed.error);
			if (!parsed.error) {
				setCurrentDraft((current) =>
					withFieldValue(current, selectedField.key, parsed.value)
				);
			}
		},
		[section, selectedField, setCurrentDraft]
	);

	const finishEdit = useCallback(() => {
		if (!selectedField) {
			return;
		}
		const parsed = parseEdit(selectedField, editText);
		if (parsed.error) {
			setEditError(parsed.error);
			return;
		}
		setCurrentDraft((current) =>
			withFieldValue(current, selectedField.key, parsed.value)
		);
		setEditing(false);
		setEditError(null);
		setNotice(`${selectedField.label} updated in draft.`);
	}, [editText, selectedField, setCurrentDraft]);

	const cancelEdit = useCallback(() => {
		const original = editOriginalRef.current;
		if (original) {
			setCurrentDraft((current) =>
				withFieldValue(current, original.key, original.value)
			);
		}
		setEditing(false);
		setEditError(null);
		setNotice("Edit cancelled.");
	}, [setCurrentDraft]);

	const save = useCallback(async () => {
		if (
			!selectedEngine ||
			currentSaving ||
			currentLoading ||
			currentError ||
			editing ||
			editError ||
			fields.length === 0
		) {
			return;
		}
		setCurrentSaving(true);
		setCurrentSaveError(null);
		setNotice(null);
		try {
			const key =
				section === "launch"
					? launchPreferenceKey(selectedEngine.name)
					: preferenceKey(selectedEngine.name);
			await request(
				target,
				`/api/preferences/${encodeURIComponent(key)}`,
				{
					method: "PUT",
					body: { value: JSON.stringify(currentDraft) },
				},
				appResponseValueSchema
			);
			try {
				const readback =
					section === "launch"
						? await readLaunchPreference(target, selectedEngine.name)
						: await readSamplingPreference(target, selectedEngine.name);
				setCurrentDraft(readback);
				setNotice("Saved and confirmed from Core.");
			} catch (readbackError) {
				setNotice(`Saved; Core readback failed: ${errorText(readbackError)}`);
			}
		} catch (error) {
			setCurrentSaveError(errorText(error));
		} finally {
			setCurrentSaving(false);
		}
	}, [
		currentDraft,
		currentError,
		currentLoading,
		currentSaving,
		editError,
		editing,
		fields.length,
		section,
		selectedEngine,
		setCurrentDraft,
		setCurrentSaveError,
		setCurrentSaving,
		target,
	]);

	const clearSelected = useCallback(() => {
		if (
			!selectedField ||
			editing ||
			currentSaving ||
			currentLoading ||
			currentError
		) {
			return;
		}
		setCurrentDraft((current) =>
			withFieldValue(current, selectedField.key, undefined)
		);
		setCurrentSaveError(null);
		setNotice(`${selectedField.label} cleared in draft.`);
	}, [
		currentLoading,
		currentError,
		currentSaving,
		editing,
		selectedField,
		setCurrentDraft,
		setCurrentSaveError,
	]);

	useKeyboard((key) => {
		if (!active) {
			return;
		}
		if (editing) {
			if (key.name === "return") {
				finishEdit();
			} else if (key.name === "tab") {
				cancelEdit();
			}
			return;
		}
		if (key.name === "tab") {
			setSection((current) => (current === "sampling" ? "launch" : "sampling"));
			setSelectedFieldIndex(0);
			setNotice(null);
			return;
		}
		if (engineLoading || currentLoading || currentSaving) {
			return;
		}
		if (engineError || !selectedEngine) {
			if (key.name === "r") {
				void loadEngines();
			}
			return;
		}
		if (key.name === "left" || key.name === "h") {
			setEngineIndex((index) => (index - 1 + engines.length) % engines.length);
			setSelectedFieldIndex(0);
			setNotice(null);
		} else if (key.name === "right" || key.name === "l") {
			setEngineIndex((index) => (index + 1) % engines.length);
			setSelectedFieldIndex(0);
			setNotice(null);
		} else if (key.name === "up" || key.name === "k") {
			setSelectedFieldIndex((index) => Math.max(0, index - 1));
		} else if (key.name === "down" || key.name === "j") {
			setSelectedFieldIndex((index) => Math.min(fields.length - 1, index + 1));
		} else if (key.name === "e" || key.name === "return") {
			beginEdit();
		} else if (key.name === "x" || key.name === "delete") {
			clearSelected();
		} else if (key.name === "s") {
			void save();
		} else if (key.name === "r") {
			if (section === "launch") {
				void loadLaunchConfig(selectedEngine.name);
			} else {
				void loadConfig(selectedEngine.name);
			}
		}
	});

	return (
		<Card
			subtitle={
				section === "launch"
					? "Engine-wide launch defaults from Core"
					: "Engine-wide chat sampling defaults from Core"
			}
			title="Advanced inference"
		>
			{engineLoading ? (
				<text fg={theme.colors.mutedForeground}>Loading Core engines…</text>
			) : null}
			{engineError ? (
				<text fg={theme.colors.error}>
					Could not load engines: {engineError} · press r to retry
				</text>
			) : null}
			{!(engineLoading || engineError) && engines.length === 0 ? (
				<text fg={theme.colors.mutedForeground}>Core returned no engines.</text>
			) : null}
			{selectedEngine ? (
				<box flexDirection="column" gap={1}>
					<box flexDirection="row" gap={1}>
						<text fg={theme.colors.mutedForeground}>Engine</text>
						<text fg={theme.colors.primary}>
							<b>{selectedEngine.name}</b>
						</text>
						<text fg={theme.colors.mutedForeground}>
							({engineIndex + 1}/{engines.length}) · ←/→ change
						</text>
						<text fg={theme.colors.mutedForeground}>
							· Tab: {section === "sampling" ? "launch" : "sampling"}
						</text>
					</box>
					{section === "launch" && launchFields.length === 0 ? (
						<box flexDirection="column" gap={1}>
							<text fg={theme.colors.mutedForeground}>
								Ryu does not own this engine's model-launch process. Configure
								model loading and hardware in its runtime; this panel will not
								read or write launch preferences for {selectedEngine.name}.
							</text>
							<text fg={theme.colors.mutedForeground}>
								Per-model launch overrides have no editor in the CLI or Desktop
								yet.
							</text>
						</box>
					) : null}
					{currentLoading ? (
						<text fg={theme.colors.mutedForeground}>
							Loading {section === "launch" ? "launch" : "sampling"} defaults…
						</text>
					) : null}
					{currentError ? (
						<text fg={theme.colors.error}>
							Could not load {section === "launch" ? "launch" : "sampling"}{" "}
							defaults: {currentError} · press r to retry
						</text>
					) : null}
					{section === "launch" && launchFields.length > 0 ? (
						<text fg={theme.colors.mutedForeground}>
							Engine-wide values apply on the next engine start. Per-model
							values override matching defaults; extra arguments append
							engine-first.
						</text>
					) : null}
					{!(currentLoading || currentError) && selectedField ? (
						<box flexDirection="column" gap={1}>
							<text fg={theme.colors.mutedForeground}>
								{selectedField.group} · {selectedField.label} (
								{Math.min(selectedFieldIndex, fields.length - 1) + 1}/
								{fields.length})
							</text>
							{editing ? (
								<box flexDirection="column" gap={1}>
									<input
										focused
										onInput={applyEditorText}
										placeholder={
											selectedField.kind === "number"
												? "number; blank uses engine default"
												: "value; blank clears"
										}
										value={editText}
									/>
									<text fg={theme.colors.mutedForeground}>
										Enter applies this field · Tab cancels
									</text>
								</box>
							) : (
								<text fg={theme.colors.foreground}>
									{valueLabel(currentDraft[selectedField.key])}
								</text>
							)}
							{selectedField.hint ? (
								<text fg={theme.colors.mutedForeground}>
									{selectedField.hint}
								</text>
							) : null}
							{editError ? (
								<text fg={theme.colors.error}>{editError}</text>
							) : null}
						</box>
					) : null}
					{currentSaveError ? (
						<text fg={theme.colors.error}>
							Could not save {section === "launch" ? "launch" : "sampling"}{" "}
							defaults: {currentSaveError} · press s to retry
						</text>
					) : null}
					{notice ? <text fg={theme.colors.success}>{notice}</text> : null}
					{currentSaving ? (
						<text fg={theme.colors.mutedForeground}>
							Saving {section === "launch" ? "launch" : "sampling"} defaults…
						</text>
					) : null}
				</box>
			) : null}
		</Card>
	);
}
