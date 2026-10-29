import { z } from "zod";
import {
	artifactObservationFromInput,
	type NativeArtifactObservation,
} from "../native-artifact-observation.ts";
import { turnEndValueSchema } from "../turn-end-wire.ts";
import { nativeSdkSchemaAdmits } from "../utils/native-sdk-admission.ts";

const nativeTextSchema = z.string();

import {
	type NativeSdkValue,
	nativeSdkObjectSchema,
	nativeSdkReceiverSchema,
} from "../utils/native-sdk-observation.ts";

interface NativeArtifactFields {
	artifact?: NativeSdkValue;
	available?: NativeSdkValue;
	content?: NativeSdkValue;
	id?: NativeSdkValue;
	kind?: NativeSdkValue;
	mime?: NativeSdkValue;
	ok?: NativeSdkValue;
	space_id?: NativeSdkValue;
	title?: NativeSdkValue;
	url?: NativeSdkValue;
}
const artifactCarrierSchema = z.custom<NativeArtifactFields>((value) =>
	nativeSdkSchemaAdmits(nativeSdkObjectSchema, value)
);
const artifactInputSchema = z.custom<NativeArtifactFields>((value) =>
	nativeSdkSchemaAdmits(nativeSdkReceiverSchema, value)
);
function isTurnEndText(value: NativeSdkValue): value is string {
	return nativeSdkSchemaAdmits(nativeTextSchema, value);
}

const hostArtifactFieldsSchema = z.object({
	actions: z
		.array(
			z.object({
				id: z.string(),
				label: z.string(),
				tone: z.enum(["primary", "secondary", "ghost"]).optional(),
			})
		)
		.optional(),
	content: z.string().optional(),
	docId: z.string().optional(),
	filePath: z.string().optional(),
	kind: z.string().optional(),
	language: z.string().optional(),
	mime: z.string().optional(),
	spaceId: z.string().optional(),
	title: z.string().optional(),
	url: z.string().optional(),
});
export const hostArtifactTransportSchema = z.custom<HostArtifact>(
	(value) =>
		turnEndValueSchema.safeParse(value).success &&
		hostArtifactFieldsSchema.safeParse(value).success
);

import type { HostArtifact } from "../artifact-host-context.tsx";

/**
 * Pure helpers for the built-in artifact tool surface (`artifact.render` /
 * `artifact.create`). Kept free of the React component graph so the behavior is
 * unit-testable without dragging in the whole tool row renderer.
 */

/** Extract the `artifact` object out of a part's input — either a bare
 *  `artifact` key or the payload itself. Defensive against missing/loose shapes. */
/** Live SDK selection is a lazy consumed observation; the complete HostArtifact
 * codec above is reserved for real transport, not transcript object admission. */
export function artifactFromInput(
	input: NativeSdkValue
): NativeArtifactObservation | null {
	return artifactObservationFromInput(input);
}

/** The `artifact.create` tool writes a file into a Space; its RESULT carries the
 *  doc identity + blob URL but not the title (that lived in the input). Rebuild a
 *  display payload from the two, so the card keeps the file name. */
export function artifactFromCreateResult(
	rawInput: NativeSdkValue,
	rawOutput: NativeSdkValue
): HostArtifact | null {
	const outputResult = artifactCarrierSchema.safeParse(rawOutput);
	if (!outputResult.success) {
		return null;
	}
	const output = outputResult.data;
	const inputResult = artifactInputSchema.safeParse(rawInput);
	const input = inputResult.success ? inputResult.data : undefined;
	if (output.ok === false || output.available === false) {
		return null;
	}
	const mime = isTurnEndText(output.mime) ? output.mime : undefined;
	const url = isTurnEndText(output.url) ? output.url : undefined;
	if (!url) {
		return null;
	}
	return {
		title:
			isTurnEndText(input?.title) && input.title.trim()
				? input.title
				: undefined,
		mime,
		url,
		spaceId: isTurnEndText(output.space_id) ? output.space_id : undefined,
		docId: isTurnEndText(output.id) ? output.id : undefined,
	};
}

/** A stable artifact id from a tool call id (never `Math.random`), so the same
 *  call always mints the same artifact across re-renders. */
export function artifactIdForPart(toolCallId: string | undefined): string {
	const base = toolCallId?.trim() ? toolCallId : "tool";
	return `artifact-${base}`;
}

/** True when a part is the built-in artifact surface (render or created file). */
export function isArtifactPart(
	partType: string,
	toolName: string | undefined
): boolean {
	return (
		partType === "tool-artifact.render" ||
		partType === "tool-artifact.create" ||
		(partType === "dynamic-tool" &&
			(toolName === "artifact.render" || toolName === "artifact.create"))
	);
}
