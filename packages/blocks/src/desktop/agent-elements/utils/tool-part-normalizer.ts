import type { UIMessage } from "ai";
import { turnEndValueSchema } from "../turn-end-wire.ts";
import { nativeSdkSchemaAdmits } from "./native-sdk-admission.ts";
import {
	type NativeSdkMessageFields,
	type NativeSdkValue,
	nativeSdkObjectSchema,
	nativeSdkTaggedPartSchema,
	type RenderedSdkPart,
} from "./native-sdk-observation.ts";

function parseStructuredJson(value: NativeSdkValue): NativeSdkValue {
	if (!nativeSdkSchemaAdmits(nativeTextSchema, value)) {
		return value;
	}
	const trimmed = value.trim();
	if (!trimmed) {
		return value;
	}
	try {
		const parsed = turnEndValueSchema.parse(JSON.parse(trimmed));
		return nativeSdkSchemaAdmits(nativeSdkObjectSchema, parsed) ||
			Array.isArray(parsed)
			? parsed
			: value;
	} catch {
		return value;
	}
}

import { z } from "zod";

const nativeTextSchema = z.string();

function isNativeTaggedPart(
	part: NativeSdkValue
): part is NativeSdkMessageFields & { type: string } {
	return nativeSdkSchemaAdmits(nativeSdkTaggedPartSchema, part);
}
export function normalizeToolPart(part: NativeSdkValue): NativeSdkValue {
	if (!(isNativeTaggedPart(part) && part.type.startsWith("tool-"))) {
		return part;
	}
	const normalizedInput = parseStructuredJson(part.input);
	const normalizedOutput = parseStructuredJson(part.output);
	const normalizedResult = parseStructuredJson(part.result);
	const inputChanged = normalizedInput !== part.input;
	const outputChanged = normalizedOutput !== part.output;
	const resultChanged = normalizedResult !== part.result;
	if (!(inputChanged || outputChanged || resultChanged)) {
		return part;
	}
	const normalizedPart = { ...part };
	if (inputChanged) {
		normalizedPart.input = normalizedInput;
	}
	if (outputChanged) {
		normalizedPart.output = normalizedOutput;
	}
	if (resultChanged) {
		normalizedPart.result = normalizedResult;
	}
	return normalizedPart;
}
export function normalizeAssistantToolParts(
	parts: NativeSdkValue[]
): NativeSdkValue[] {
	let changed = false;
	const normalizedParts = parts.map((part) => {
		const normalizedPart = normalizeToolPart(part);
		if (normalizedPart !== part) {
			changed = true;
		}
		return normalizedPart;
	});
	return changed ? normalizedParts : parts;
}

/** This path starts with actual SDK parts and the owned Core error part. The
 * static-tool prefix narrows the existing SDK variant; Core errors remain on
 * their original branch. Legacy result is only an opaque optional slot. */
type SdkPart = UIMessage["parts"][number];
type SdkStaticToolPart = Extract<SdkPart, { type: `tool-${string}` }>;
function isSdkStaticToolPart(
	part: RenderedSdkPart
): part is SdkStaticToolPart & NativeSdkMessageFields {
	return isNativeTaggedPart(part) && part.type.startsWith("tool-");
}
export function normalizeUiMessageToolPart(part: SdkPart): SdkPart;
export function normalizeUiMessageToolPart(
	part: RenderedSdkPart
): RenderedSdkPart;
export function normalizeUiMessageToolPart(
	part: RenderedSdkPart
): RenderedSdkPart {
	if (!isSdkStaticToolPart(part)) {
		return part;
	}
	const normalizedInput = parseStructuredJson(part.input);
	const normalizedOutput = parseStructuredJson(part.output);
	const normalizedResult = parseStructuredJson(part.result);
	const inputChanged = normalizedInput !== part.input;
	const outputChanged = normalizedOutput !== part.output;
	const resultChanged = normalizedResult !== part.result;
	if (!(inputChanged || outputChanged || resultChanged)) {
		return part;
	}
	const normalizedPart = { ...part };
	// Public SDK tool slots are opaque. An absent state-specific slot remains
	// undefined and therefore cannot enter the changed-field assignment branch.
	if (inputChanged) {
		normalizedPart.input = normalizedInput;
	}
	if (outputChanged) {
		normalizedPart.output = normalizedOutput;
	}
	if (resultChanged) {
		normalizedPart.result = normalizedResult;
	}
	return normalizedPart;
}
export function normalizeUiMessageToolParts(
	parts: UIMessage["parts"]
): UIMessage["parts"];
export function normalizeUiMessageToolParts(
	parts: RenderedSdkPart[]
): RenderedSdkPart[];
export function normalizeUiMessageToolParts(
	parts: RenderedSdkPart[]
): RenderedSdkPart[] {
	let changed = false;
	const normalizedParts = parts.map((part) => {
		const normalizedPart = normalizeUiMessageToolPart(part);
		if (normalizedPart !== part) {
			changed = true;
		}
		return normalizedPart;
	});
	return changed ? normalizedParts : parts;
}
