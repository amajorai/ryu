import type { NativeCountConversion } from "@ryu/ui/lib/number-format.ts";
import { z } from "zod";
import {
	type NativeTokenOperand,
	readGenerationSpeed,
} from "./native-token-count.mjs";
import type { RenderedMessage } from "./utils/native-sdk-observation.ts";

/** The actual consumed slots; unrelated provider metadata stays on its original carrier. */
export interface NativeInferenceFields {
	cachedReadTokens?: NativeTokenOperand;
	cachedTokens?: NativeTokenOperand;
	cachedWriteTokens?: NativeTokenOperand;
	cacheMissTokens?: NativeTokenOperand;
	cacheReadTokens?: NativeTokenOperand;
	cacheWriteTokens?: NativeTokenOperand;
	completionTokens?: NativeTokenOperand;
	context_window?: NativeTokenOperand;
	contextWindow?: NativeTokenOperand;
	current_usage?: NativeTokenOperand;
	currentUsage?: NativeTokenOperand;
	done?: NativeTokenOperand;
	durationMs?: NativeTokenOperand;
	id?: NativeTokenOperand;
	promptPerSecond?: NativeTokenOperand;
	promptTokens?: NativeTokenOperand;
	reasoningTokens?: NativeTokenOperand;
	sessionCostAmount?: NativeTokenOperand;
	sessionCostCurrency?: NativeTokenOperand;
	sessionTotalTokens?: NativeTokenOperand;
	thoughtTokens?: NativeTokenOperand;
	tokensPerSecond?: NativeTokenOperand;
	total?: NativeTokenOperand;
	totalTokens?: NativeTokenOperand;
	ttftMs?: NativeTokenOperand;
	used?: NativeTokenOperand;
}

// Native numeric guards retain NaN and Infinity: the existing presentation owns
// their fallbacks, and they must not suppress independent valid usage fields.
const nativeNumberSchema = z.union([
	z.number(),
	z.nan(),
	z.literal(Number.POSITIVE_INFINITY),
	z.literal(Number.NEGATIVE_INFINITY),
]);
// A raw JS property carrier includes non-null primitive operands: native field
// getters must receive their original primitive receiver, rather than a boxed
// replacement. Every projected field is optional and carries the entire native
// operand domain; this makes no claim that malformed metadata is a Core DTO.
// Capture the intrinsic before consuming any caller metadata. Identity admission
// never inspects object/callable properties or invokes native/user coercion.
const NativeObject = Object;
const nativeObjectOperandSchema = z.custom<NativeCountConversion>(
	(value) => NativeObject(value) === value
);
const nativePropertyCarrierAdmission = z.union([
	nativeNumberSchema,
	z.string(),
	z.boolean(),
	z.bigint(),
	z.symbol(),
	nativeObjectOperandSchema,
]);
// This is the complete native property-operation operand domain, not JSON.
// Null/undefined remain admitted here so the native field read retains its
// original throws if a second part.data getter changes after its truthy guard.
const nativeTokenOperandSchema = nativePropertyCarrierAdmission
	.nullable()
	.optional();
const nativeCarrierSchema = z.custom<NativeInferenceFields>(
	(value) => nativePropertyCarrierAdmission.safeParse(value).success
);
interface GenerationInferenceFields extends NativeInferenceFields {
	tokensPerSecond: number;
}
const generationNativeFieldsSchema = z.custom<GenerationInferenceFields>(
	(value) => {
		const operand = nativeTokenOperandSchema.parse(value);
		return nativeNumberSchema.safeParse(readGenerationSpeed(operand)).success;
	}
);
interface NativeStatsPart {
	data?: NativeTokenOperand;
	type?: NativeTokenOperand;
}
const statsPartSchema = z.custom<NativeStatsPart>(
	(value) => nativePropertyCarrierAdmission.safeParse(value).success
);

export function isInferenceNumber(
	value: Parameters<typeof nativeNumberSchema.safeParse>[0]
): value is number {
	return nativeNumberSchema.safeParse(value).success;
}

export function inferenceNumber(
	value: Parameters<typeof nativeNumberSchema.safeParse>[0]
): number | undefined {
	const parsed = nativeNumberSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

export function extractGenerationStats(
	msg: Pick<RenderedMessage, "parts">
): GenerationInferenceFields | null {
	for (const part of msg.parts ?? []) {
		if (part == null) {
			continue;
		}
		const carrier = statsPartSchema.parse(part);
		if (carrier.type === "data-ryu-stats" && carrier.data) {
			const data = generationNativeFieldsSchema.safeParse(carrier.data);
			if (data.success) {
				return data.data;
			}
		}
	}
	return null;
}

export function extractNativeAcpUsage(
	msg: Pick<RenderedMessage, "parts">
): NativeInferenceFields | null {
	let matched: NativeStatsPart | undefined;
	(msg.parts ?? []).find((part) => {
		if (part == null) {
			return false;
		}
		const carrier = statsPartSchema.parse(part);
		if (carrier.type !== "data-acp-usage") {
			return false;
		}
		matched = carrier;
		return true;
	});
	const raw = matched?.data;
	return raw ? nativeCarrierSchema.parse(raw) : null;
}
