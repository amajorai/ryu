import { activeLocale, numberFormatter } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import type { FileLineRange } from "@/src/lib/file-annotations.ts";

// The file annotation viewer's line labels, as whole translated sentences.
// `formatLineLabel` in file-annotations.ts stays English: it builds the
// markdown quote the model reads, never what the user sees.

const LINE_NUMBER = { useGrouping: false } as const;

/** A line number in the UI locale's digits, ungrouped like the gutter. */
function lineNumber(value: number): string {
	return numberFormatter(activeLocale(), LINE_NUMBER).format(value);
}

function isSingleLine(range: FileLineRange): boolean {
	return range.startLine === range.endLine;
}

/** The draft card header and its textarea's accessible name. */
export function fileAnnotationNoteTitle(
	tl: LiteralMessage,
	range: FileLineRange
): string {
	return isSingleLine(range)
		? tl("Note on line {line}", { line: lineNumber(range.startLine) })
		: tl("Note on lines {start}–{end}", {
				end: lineNumber(range.endLine),
				start: lineNumber(range.startLine),
			});
}

/** The saved note chip that sits beside "Note". */
export function fileAnnotationLineLabel(
	tl: LiteralMessage,
	range: FileLineRange
): string {
	return isSingleLine(range)
		? tl("Line {line}", { line: lineNumber(range.startLine) })
		: tl("Lines {start}–{end}", {
				end: lineNumber(range.endLine),
				start: lineNumber(range.startLine),
			});
}

/** The saved note's remove button accessible name. */
export function fileAnnotationRemoveLabel(
	tl: LiteralMessage,
	range: FileLineRange
): string {
	return isSingleLine(range)
		? tl("Remove note on line {line}", { line: lineNumber(range.startLine) })
		: tl("Remove note on lines {start}–{end}", {
				end: lineNumber(range.endLine),
				start: lineNumber(range.startLine),
			});
}
