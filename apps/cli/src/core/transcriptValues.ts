// Chat JSON values as the transcript presentation reads them: typed field
// access, the shared size limits and unified-diff detection.

import { z } from "zod";
import type { ChatToolArguments, ChatToolResult } from "./chatTranscript.ts";

export type TranscriptJsonValue = Exclude<ChatToolResult, undefined>;
export const transcriptTextSchema = z.string();
export const transcriptScalarSchema = z.union([
	z.null(),
	z.boolean(),
	z.number(),
]);
// Values already passed the chat JSON boundary. These native adapters inspect only
// immediate entries/fields, leaving the presentation depth and entry limits in control.
export function transcriptEntries(
	value: ChatToolResult
): [string, ChatToolResult][] {
	return Object.entries(value ?? {});
}
export function isTranscriptRecord(
	value: ChatToolResult
): value is ChatToolArguments {
	return (
		value !== undefined &&
		!Array.isArray(value) &&
		!z.union([z.string(), z.null(), z.boolean(), z.number()]).safeParse(value)
			.success
	);
}
export function transcriptField(
	value: ChatToolResult,
	key: string
): ChatToolResult {
	return isTranscriptRecord(value) ? value[key] : undefined;
}

export const TRANSCRIPT_LIMITS = {
	markdownChars: 12_000,
	markdownLines: 240,
	thinkingChars: 8000,
	thinkingLines: 120,
	toolArgumentChars: 4000,
	toolArgumentLines: 80,
	toolOutputChars: 6000,
	toolOutputLines: 80,
	todoChars: 240,
	todoLines: 4,
	errorChars: 600,
	errorLines: 6,
	toolSummaryChars: 80,
} as const;

const DIFF_TOOL_NAMES = new Set(["Edit", "ApplyPatch", "edit", "apply_patch"]);

export const isDiffTool = (name: string): boolean => DIFF_TOOL_NAMES.has(name);

const looksLikeDiff = (value: string): boolean => {
	const lines = value.split("\n");
	const hasHeader = lines.some(
		(line) =>
			line.startsWith("diff ") ||
			line.startsWith("--- ") ||
			line.startsWith("+++ ") ||
			line.startsWith("@@ ")
	);
	const hasChangePair =
		lines.some((line) => line.startsWith("+")) &&
		lines.some((line) => line.startsWith("-"));
	return hasHeader || hasChangePair;
};

export const findDiffText = (
	value: ChatToolResult,
	depth = 0
): string | undefined => {
	if (depth > 3) {
		return undefined;
	}
	const text = transcriptTextSchema.safeParse(value);
	if (text.success) {
		return looksLikeDiff(text.data) ? text.data : undefined;
	}
	if (
		value === undefined ||
		transcriptScalarSchema.safeParse(value).success ||
		Array.isArray(value)
	) {
		return undefined;
	}
	for (const key of ["patch", "diff", "unified_diff", "unifiedDiff"]) {
		const candidate = transcriptTextSchema.safeParse(
			transcriptField(value, key)
		);
		if (candidate.success && looksLikeDiff(candidate.data)) {
			return candidate.data;
		}
	}
	for (const key of ["output", "result", "content", "text"]) {
		const nested = findDiffText(transcriptField(value, key), depth + 1);
		if (nested) {
			return nested;
		}
	}
	return undefined;
};
