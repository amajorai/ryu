import {
	isNativeObject,
	isNativeObjectLike,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import type { DynamicToolUIPart, UIMessage } from "ai";
import { z } from "zod";
import { nativeSdkSchemaAdmits } from "./native-sdk-admission.ts";

const nativeTextSchema = z.string();

/** Actual AI SDK metadata/input/output domain is opaque JavaScript, not JSON.
 * This named SDK alias includes callbacks, symbols, bigint, Date/Map, arrays,
 * null/undefined and future application objects without inspecting metadata. */
export type NativeSdkValue =
	| UIMessage["metadata"]
	| DynamicToolUIPart["input"]
	| DynamicToolUIPart["output"];
/** Consumed field projection, not a whole part/metadata DTO. Unrelated fields
 * remain on the original object and getters run only at their native read sites. */
export interface NativeSdkMessageFields {
	content?: NativeSdkValue;
	input?: NativeSdkValue;
	output?: NativeSdkValue;
	result?: NativeSdkValue;
	text?: NativeSdkValue;
	type?: NativeSdkValue;
}
export const nativeSdkReceiverSchema =
	z.custom<NativeSdkMessageFields>(isNativeObject);
export const nativeSdkObjectSchema =
	z.custom<NativeSdkMessageFields>(isNativeObjectLike);
function isNativeObjectFields(
	value: NativeSdkValue
): value is NativeSdkMessageFields {
	return nativeSdkSchemaAdmits(nativeSdkObjectSchema, value);
}
function isNativeReceiverFields(
	value: NativeSdkValue
): value is NativeSdkMessageFields {
	return nativeSdkSchemaAdmits(nativeSdkReceiverSchema, value);
}
export const nativeSdkTaggedPartSchema = z.custom<
	NativeSdkMessageFields & { type: string }
>((value) => {
	const receiver = value;
	return (
		isNativeObjectFields(receiver) &&
		nativeSdkSchemaAdmits(nativeTextSchema, receiver.type)
	);
});

/** A decoded text projection for read-back, leaving every other SDK part and
 * opaque metadata field untouched. The returned receiver is the original part. */
export const nativeReadbackTextSchema = z.custom<
	NativeSdkMessageFields & { type: "text"; text: string }
>((value) => {
	const receiver = value;
	return (
		isNativeObjectFields(receiver) &&
		receiver.type === "text" &&
		nativeSdkSchemaAdmits(nativeTextSchema, receiver.text)
	);
});
export const nativeReadbackContentSchema = z.custom<
	NativeSdkMessageFields & { content: string }
>((value) => {
	const receiver = value;
	return (
		isNativeReceiverFields(receiver) &&
		nativeSdkSchemaAdmits(nativeTextSchema, receiver.content)
	);
});

/** Actual Core PartsAccumulator::error stores type/code/title/message alongside
 * SDK parts. This is the consumed live view, not its full serialized DTO:
 * title/code remain opaque until the renderer actually reads them. */
export interface NativeCoreErrorObservation {
	code?: NativeSdkValue;
	message: string;
	title?: NativeSdkValue;
	type: "error";
}

/** Transcript parts retain the installed SDK union and the actual Core error part. */
export type RenderedSdkPart =
	| UIMessage["parts"][number]
	| NativeCoreErrorObservation;
/** Only assistant transcript messages carry Core error parts. User/system messages
 * retain their full SDK contract, including the native user-message slot ABI. */
export type RenderedMessage =
	| UIMessage
	| (Omit<UIMessage, "role" | "parts"> & {
			role: "assistant";
			parts: RenderedSdkPart[];
	  });
