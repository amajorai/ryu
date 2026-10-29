import type { FileCellData } from "@ryu/ui/types/data-grid.ts";
import { z } from "zod";
import { getIsFileCellData } from "./data-grid.ts";

const clipboardFileSchema = z.custom<FileCellData>(getIsFileCellData);
const clipboardFileListSchema = z.array(clipboardFileSchema);
const clipboardTextListSchema = z.array(z.string());

/** The existing multi-select paste policy retains string members of JSON arrays. */
export const clipboardStringListSchema = z
	.array(z.string().optional().catch(undefined))
	.transform((values) =>
		values.filter((value): value is string => value !== undefined)
	);

/** Keep entry positions so a nonempty array with no valid files remains a skipped paste. */
export const clipboardFileEntriesSchema = z.array(
	clipboardFileSchema.optional().catch(undefined)
);

/** Structured clipboard values with an explicit textual representation. Other JSON stays literal text. */
export const clipboardTextValueSchema = z.union([
	clipboardFileListSchema,
	clipboardTextListSchema,
	z.boolean(),
]);

export function describeClipboardTextValue(
	value: z.infer<typeof clipboardTextValueSchema>
): string {
	if (!Array.isArray(value)) {
		return value ? "Checked" : "Unchecked";
	}
	const files = clipboardFileListSchema.safeParse(value);
	if (files.success) {
		return files.data.map((file) => file.name).join(", ");
	}
	return clipboardTextListSchema.parse(value).join(", ");
}

const CRLF_PATTERN = /\r\n/g;

/** Clipboard text compared across write/read, which may rewrite line endings. */
export function normalizeClipboardText(text: string): string {
	return text.replace(CRLF_PATTERN, "\n");
}

/**
 * Whether the clipboard still holds the TSV a cut wrote, so a paste moves the
 * cut cells instead of copying a superseded clipboard. Compare the raw text the
 * paste read from the clipboard, never a transformed form of it (e.g. the
 * transposed TSV "Paste transposed" hands to the paste routine).
 */
export function isCutOnClipboard(
	cutText: string | null,
	sourceClipboardText: string
): boolean {
	return (
		cutText !== null &&
		normalizeClipboardText(cutText) ===
			normalizeClipboardText(sourceClipboardText)
	);
}
