import type { UIMessage } from "ai";
import { z } from "zod";

const nativeTextSchema = z.string();

import { nativeSdkSchemaAdmits } from "./native-sdk-admission.ts";
import type { RenderedSdkPart } from "./native-sdk-observation.ts";

export type { RenderedSdkPart } from "./native-sdk-observation.ts";

import { nativeSdkObjectSchema } from "./native-sdk-observation.ts";
export type SdkPart = UIMessage["parts"][number];

export type SdkToolPart = Extract<
	SdkPart,
	{ type: `tool-${string}` | "dynamic-tool" }
>;
export type SdkDataPart = Extract<SdkPart, { type: `data-${string}` }>;
/** The input already has the full public SDK part union. This observes only
 * its existing discriminant; opaque tool payloads remain entirely untouched. */
export function isV5SdkToolPart(
	part: RenderedSdkPart | undefined
): part is SdkToolPart {
	if (
		part === undefined ||
		!nativeSdkSchemaAdmits(nativeSdkObjectSchema, part)
	) {
		return false;
	}
	const partType = part.type;
	return (
		partType === "dynamic-tool" ||
		(nativeSdkSchemaAdmits(nativeTextSchema, partType) &&
			partType.startsWith("tool-"))
	);
}
/** The actual SDK DataUIPart owns data as opaque JavaScript. A widget tag does
 * not establish any toolCallId field or manufacture a widget payload DTO. */
export function isSdkWidgetAvailablePart(
	part: RenderedSdkPart | undefined
): part is SdkDataPart & { type: "data-tool-widget-available" } {
	return (
		part !== undefined &&
		nativeSdkSchemaAdmits(nativeSdkObjectSchema, part) &&
		part.type === "data-tool-widget-available"
	);
}

import {
	type NativeSdkValue,
	nativeSdkReceiverSchema,
} from "./native-sdk-observation.ts";

interface NativeWidgetKeyObservation {
	toolCallId?: NativeSdkValue;
}
const widgetKeyObservation = z.custom<NativeWidgetKeyObservation>((value) =>
	nativeSdkSchemaAdmits(nativeSdkReceiverSchema, value)
);
/** Core's ToolWidgetEvent publishes this field as a string. Read just that
 * field at the existing row-key consumer; all widget output/state remain raw. */
export function nativeWidgetToolCallId(
	data: NativeSdkValue
): string | undefined {
	if (data === null || data === undefined) {
		return undefined;
	}
	const receiver = widgetKeyObservation.safeParse(data);
	if (!receiver.success) {
		return undefined;
	}
	const value = receiver.data.toolCallId;
	return nativeSdkSchemaAdmits(nativeTextSchema, value) ? value : undefined;
}
