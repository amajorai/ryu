import type { UIMessage } from "ai";
import { z } from "zod";
import { nativeSdkSchemaAdmits } from "./native-sdk-admission.ts";

const nativeTextSchema = z.string();
const nativeCallableSchema = z.function();

import type {
	NativeSdkValue,
	RenderedMessage,
} from "./native-sdk-observation.ts";

interface NativeMessageFields {
	_interrupted?: NativeSdkValue;
	content?: NativeSdkValue;
	metadata?: NativeSdkValue;
	persisted?: NativeSdkValue;
	text?: NativeSdkValue;
}
interface PersistedMetadataFields {
	ryuEphemeral?: NativeSdkValue;
	ryuPersisted?: NativeSdkValue;
}
const nativeMessageSchema = z.custom<RenderedMessage & NativeMessageFields>(
	(value) => {
		const receiver = new Object(value);
		return receiver === value;
	}
);
const nativeMetadataKindSchema = z.custom<PersistedMetadataFields | null>(
	(value) => {
		if (value === null) {
			return true;
		}
		const receiver = new Object(value);
		return (
			receiver === value && !nativeSdkSchemaAdmits(nativeCallableSchema, value)
		);
	}
);
function hasObjectMetadata(
	candidate: NativeMessageFields
): candidate is NativeMessageFields & { metadata: PersistedMetadataFields } {
	return (
		nativeMetadataKindSchema.safeParse(candidate.metadata).success &&
		candidate.metadata !== null
	);
}
export function messageIsPersisted(message: RenderedMessage): boolean {
	const candidate = nativeMessageSchema.parse(message);
	if (candidate.persisted === true) {
		return true;
	}
	if (!hasObjectMetadata(candidate)) {
		return false;
	}
	return candidate.metadata.ryuPersisted === true;
}
/**
 * A client-only transcript row (for example a live voice-call turn) whose id is
 * never persisted. Hosts mark it with `metadata.ryuEphemeral: true`, and the
 * transcript must not offer persisted-message actions (edit, branch,
 * regenerate, reactions, contributed actions) on it.
 */
export function messageIsEphemeral(message: RenderedMessage): boolean {
	const candidate = nativeMessageSchema.parse(message);
	return (
		hasObjectMetadata(candidate) && candidate.metadata.ryuEphemeral === true
	);
}
function isNativeText(value: NativeSdkValue): value is string {
	return nativeSdkSchemaAdmits(nativeTextSchema, value);
}
export function normalizeMessages(messages: UIMessage[]): UIMessage[];
export function normalizeMessages(
	messages: RenderedMessage[]
): RenderedMessage[];
export function normalizeMessages(
	messages: RenderedMessage[]
): RenderedMessage[] {
	let changed = false;
	const normalized = messages.map((message) => {
		if (Array.isArray(message.parts) && message.parts.length > 0) {
			return message;
		}
		const raw = nativeMessageSchema.parse(message);
		const content = raw.content ?? raw.text;
		if (!(isNativeText(content) && content)) {
			return message;
		}
		changed = true;
		return {
			...message,
			parts: [{ type: "text", text: content }],
		} satisfies RenderedMessage;
	});
	return changed ? normalized : messages;
}

export function isInterruptedMessage(message: RenderedMessage): boolean {
	return nativeMessageSchema.parse(message)._interrupted === true;
}
