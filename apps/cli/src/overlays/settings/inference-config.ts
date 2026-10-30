import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { request } from "@ryuhq/core-client/client";
import { z } from "zod";
import type { useCore } from "../../core/CoreContext.tsx";
import { tf } from "../../i18n/translate.ts";
import type { SamplingField } from "./inference-fields.ts";

const inferenceJsonSchema = z.json();
export type InferenceValue = z.infer<typeof inferenceJsonSchema> | undefined;
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

export function preferenceKey(engineName: string): string {
	return `inference.engine.${engineName}`;
}

export function launchPreferenceKey(engineName: string): string {
	return `model.launch.engine.${engineName}`;
}

export async function readSamplingPreference(
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

export async function readLaunchPreference(
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
			return {
				error: tf("{label} must be a finite number.", {
					label: fieldDefinition.label,
				}),
			};
		}
		if (fieldDefinition.integer && !Number.isSafeInteger(value)) {
			return {
				error: tf("{label} must be a whole number.", {
					label: fieldDefinition.label,
				}),
			};
		}
		if (fieldDefinition.min !== undefined && value < fieldDefinition.min) {
			return {
				error: tf("{label} must be at least {min}.", {
					label: fieldDefinition.label,
					min: String(fieldDefinition.min),
				}),
			};
		}
		if (fieldDefinition.max !== undefined && value > fieldDefinition.max) {
			return {
				error: tf("{label} must be no greater than {max}.", {
					label: fieldDefinition.label,
					max: String(fieldDefinition.max),
				}),
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
			: {
					error: tf("{label} must be a JSON array of strings.", {
						label: fieldDefinition.label,
					}),
				};
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

export function errorText(
	error: Parameters<typeof inferenceErrorSchema.safeParse>[0]
): string {
	const parsed = inferenceErrorSchema.safeParse(error);
	return parsed.success ? parsed.data.message : String(error);
}
