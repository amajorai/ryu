// apps/desktop/src/lib/live-artifact-extractor.ts
//
// The cowork panel's rendered-artifact scan over live message parts. Parts are
// admitted through the native SDK observation schemas; fenced-block detection,
// titles, and the artifact-tool test are shared with `artifacts.ts`.

import type { NativeArtifactObservation } from "@ryu/blocks/desktop/agent-elements/native-artifact-observation.ts";
import { nativeArtifactLookup } from "@ryu/blocks/desktop/agent-elements/utils/native-artifact-lookup-abi.ts";
import { nativeSdkSchemaAdmits } from "@ryu/blocks/desktop/agent-elements/utils/native-sdk-admission.ts";
import { nativeSdkObjectSchema } from "@ryu/blocks/desktop/agent-elements/utils/native-sdk-observation.ts";
import type { DynamicToolUIPart } from "ai";
import { z } from "zod";
import {
	artifactIdFromToolCall,
	artifactsFromText,
	isArtifactToolPart,
} from "./artifacts.ts";
import {
	type ArtifactView,
	artifactFromSdkObservation,
} from "./live-artifacts.ts";

const nativeTextSchema = z.string();

interface ArtifactSourceMessage {
	id?: string;
	parts?: Array<object | null | undefined>;
	role?: string;
}
interface NativeArtifactPartObservation {
	input?: DynamicToolUIPart["input"];
	output?: DynamicToolUIPart["output"];
	text?: DynamicToolUIPart["input"];
	toolCallId?: DynamicToolUIPart["input"];
	toolName?: DynamicToolUIPart["input"];
	type?: DynamicToolUIPart["input"];
}
const nativePartReceiver = z.custom<NativeArtifactPartObservation>((value) =>
	nativeSdkSchemaAdmits(nativeSdkObjectSchema, value)
);
const nativeArtifactReceiver = z.custom<NativeArtifactObservation>((value) =>
	nativeSdkSchemaAdmits(nativeSdkObjectSchema, value)
);
function nativeText(value: DynamicToolUIPart["input"]): value is string {
	return nativeSdkSchemaAdmits(nativeTextSchema, value);
}

/** A part read as a loose record, or null when it isn't an object. */
function partRecord(
	part: DynamicToolUIPart["input"]
): NativeArtifactPartObservation | null {
	if (!part) {
		return null;
	}
	const observation = nativePartReceiver.safeParse(part);
	return observation.success ? observation.data : null;
}

/** Concatenate a message's text parts into one scannable string. */
function messageText(message: ArtifactSourceMessage): string {
	const parts = message.parts;
	if (!Array.isArray(parts)) {
		return "";
	}
	const chunks: string[] = [];
	for (const part of parts) {
		const record = partRecord(part);
		if (record && record.type === "text" && nativeText(record.text)) {
			chunks.push(record.text);
		}
	}
	return chunks.join("\n\n");
}

/**
 * Scan the whole conversation for rendered/canvas artifacts. Only assistant (or
 * unlabelled) messages are considered — a user pasting HTML is input, not an
 * artifact to render. Returns them in stream order; ids are stable per message.
 *
 * Two sources feed it: fenced blocks in the message text (html/svg/mermaid/code)
 * and the agent's own artifact TOOL parts (`artifact.render` input /
 * `artifact.create` result), so a file/page/space/database the agent minted
 * shows up in the cowork panel's Rendered artifacts list too.
 */
export function extractArtifacts(
	messages: readonly ArtifactSourceMessage[]
): ArtifactView[] {
	const all: ArtifactView[] = [];
	for (const [i, message] of messages.entries()) {
		if (!message || message.role === "user") {
			continue;
		}
		const messageId =
			nativeText(message.id) && message.id ? message.id : `msg-${i}`;
		const fromMessage = artifactsFromText(messageText(message), messageId);
		for (const artifact of fromMessage) {
			all.push(artifact);
		}
		if (Array.isArray(message.parts)) {
			for (const part of message.parts) {
				const record = partRecord(part);
				if (!(record && isArtifactToolPart(record))) {
					continue;
				}
				const toolName = nativeText(record.toolName)
					? record.toolName
					: nativeText(record.type)
						? record.type.slice("tool-".length)
						: "";
				const id = artifactIdFromToolCall(
					nativeText(record.toolCallId) ? record.toolCallId : undefined
				);
				const input = nativeArtifactLookup(record.input);
				const output = nativeArtifactLookup(record.output);
				if (toolName === "artifact.create") {
					// The create RESULT carries url/mime/ids (title lived in the input).
					const mime = nativeText(output?.mime) ? output.mime : undefined;
					const url = nativeText(output?.url) ? output.url : undefined;
					if (!url) {
						continue;
					}
					all.push(
						artifactFromSdkObservation(
							{
								title: nativeText(input?.title) ? input.title : undefined,
								mime,
								url,
								spaceId: nativeText(output?.space_id)
									? output.space_id
									: undefined,
								docId: nativeText(output?.id) ? output.id : undefined,
							},
							id,
							messageId
						)
					);
					continue;
				}
				const nested = input?.artifact ?? input;
				if (nested) {
					const observation = nativeArtifactReceiver.safeParse(nested);
					if (observation.success) {
						all.push(
							artifactFromSdkObservation(observation.data, id, messageId)
						);
					}
				}
			}
		}
	}
	return all;
}
