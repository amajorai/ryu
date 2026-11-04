import type { LiteralMessage } from "@ryu/i18n/react";
import type { SpaceImportRecord } from "@/src/lib/api/space-imports.ts";
import { formatLocalNumber } from "@/src/lib/locale-format.ts";

/**
 * Turns a stored Space import `message` into translated lines.
 *
 * Core stores the failure (or the "Skipped …" note on a partial import) as one
 * English string: each source's error is prefixed with `{file}: ` and the
 * sources are joined with `; ` (`apps/core/src/server/space_imports.rs`
 * `import_many`). Document-parser failures add the parse code
 * (`ParseFailureReason::code()`, `"<code>: <detail>"`). The pieces are matched
 * here against the sentences Core writes and rendered through the catalog, so
 * every stored row, old or new, reads in the user's language. Provider or
 * library detail (a Docling error, a ZIP reader error) stays as an untranslated
 * detail line, and a piece nothing matches is shown as it was stored.
 */

export interface ImportMessageLine {
	/** Provider or library detail that is not catalogued; shown as written. */
	detail: string | null;
	/** The source name Core prefixed the error with, when there was one. */
	file: string | null;
	/** The translated sentence, or the stored text when nothing matched. */
	sentence: string;
	/** False when the stored text matched no known sentence and is shown as is. */
	translated: boolean;
}

export interface ImportMessageCopy {
	lines: ImportMessageLine[];
	/** The "Skipped …" heading of a partially completed import, translated. */
	skippedHeading: string | null;
}

interface Described {
	detail: string | null;
	sentence: string;
}

type Matcher = (
	text: string,
	tl: LiteralMessage
) => Described | null | undefined;

const SKIPPED_PREFIX = "Skipped ";
const SEGMENT_SEPARATOR = "; ";
const FILE_SEPARATOR = ": ";
const PARSE_FAILURE =
	/^(unsupported_format|no_provider|provider_timeout|provider_error|too_large|python_missing|blob_unavailable|not_text): ?([\s\S]*)$/;

function plain(sentence: string, detail: string | null = null): Described {
	return { detail: detail?.trim() ? detail.trim() : null, sentence };
}

/** The fixed sentences Core writes, keyed by the exact stored text. */
function fixedSentence(text: string, tl: LiteralMessage): string | null {
	switch (text) {
		case "the spreadsheet parser returned no tables":
			return tl("The spreadsheet parser found no tables.");
		case "nested ZIP archives are not supported":
			return tl("Nested ZIP archives are not supported.");
		case "unsupported import format":
			return tl("This file format cannot be imported.");
		case "document conversion timed out":
			return tl("Document conversion timed out. Try again.");
		case "the action returned no list of records for a database import":
			return tl("The action returned no list of records for a database.");
		case "ZIP contains no supported import files":
			return tl("The ZIP archive has no files that can be imported.");
		case "delimited file exceeds the upload size limit":
			return tl("The file is over the upload size limit.");
		case "delimited imports must use UTF-8 text":
			return tl("CSV, TSV and DSV files must use UTF-8 text.");
		case "delimited file has an unclosed quoted field":
			return tl("The file has a quoted field that is never closed.");
		case "delimited file is empty":
			return tl("The file is empty.");
		case "table has no header row":
			return tl("The table has no header row.");
		case "table has no columns":
			return tl("The table has no columns.");
		case "records have no fields":
			return tl("The records have no fields.");
		case "the connector returned nothing to import":
			return tl("The connector returned nothing to import.");
		default:
			return null;
	}
}

function parseFailure(text: string, tl: LiteralMessage): Described | null {
	const match = PARSE_FAILURE.exec(text);
	if (!match) {
		return null;
	}
	const detail = match[2] ?? "";
	switch (match[1]) {
		case "unsupported_format":
			return plain(
				tl("No document parser on this node reads this format."),
				detail
			);
		case "no_provider":
			return plain(
				tl(
					"No document parser is available. Enable a compatible parser in Tools & Connections, then import again."
				)
			);
		case "provider_timeout":
			return plain(
				tl("The document parser ran out of time on this file. Try again."),
				detail
			);
		case "too_large":
			return plain(tl("The file is too large to convert."), detail);
		case "python_missing":
			return plain(
				tl(
					"Python was not found on this node. Install Python 3, then import again."
				)
			);
		case "blob_unavailable":
			return plain(
				tl(
					"The uploaded file was no longer available for conversion. Import it again."
				)
			);
		case "not_text":
			return plain(
				tl("The document parser returned no text for this file."),
				detail
			);
		default:
			return plain(tl("The document parser failed on this file."), detail);
	}
}

const PATTERNS: [
	RegExp,
	(match: RegExpExecArray, tl: LiteralMessage) => Described,
][] = [
	[
		/^invalid ZIP archive: ([\s\S]*)$/,
		(match, tl) => plain(tl("This ZIP archive cannot be opened."), match[1]),
	],
	[
		/^ZIP contains more than (\d+) entries$/,
		(match, tl) =>
			plain(
				tl("The ZIP archive has more than {limit} entries.", {
					limit: formatLocalNumber(Number(match[1])),
				})
			),
	],
	[
		/^ZIP entry ([\s\S]+) has an unsafe path$/,
		(match, tl) =>
			plain(
				tl("The ZIP entry {name} has an unsafe path.", { name: match[1] ?? "" })
			),
	],
	[
		/^nested ZIP archive ([\s\S]+) is not supported$/,
		(match, tl) =>
			plain(
				tl("The nested ZIP archive {name} is not supported.", {
					name: match[1] ?? "",
				})
			),
	],
	[
		/^delimited ZIP member ([\s\S]+) exceeds the upload size limit$/,
		(match, tl) =>
			plain(
				tl("{name} in the ZIP archive is over the upload size limit.", {
					name: match[1] ?? "",
				})
			),
	],
	[
		/^expanded ZIP content is over the (\d+) MB limit$/,
		(match, tl) =>
			plain(
				tl("The expanded ZIP content is over the {limit} MB limit.", {
					limit: formatLocalNumber(Number(match[1])),
				})
			),
	],
	[
		/^blob staging task failed: ([\s\S]*)$/,
		(match, tl) =>
			plain(tl("The file could not be prepared for conversion."), match[1]),
	],
];

const MATCHERS: Matcher[] = [
	(text, tl) => {
		const sentence = fixedSentence(text, tl);
		return sentence === null ? null : plain(sentence);
	},
	parseFailure,
	(text, tl) => {
		for (const [pattern, describe] of PATTERNS) {
			const match = pattern.exec(text);
			if (match) {
				return describe(match, tl);
			}
		}
		return null;
	},
];

function describeText(text: string, tl: LiteralMessage): Described | null {
	for (const matcher of MATCHERS) {
		const described = matcher(text, tl);
		if (described) {
			return described;
		}
	}
	return null;
}

/** One `; `-separated piece: a whole sentence, or `{file}: {sentence}`. */
function describeSegment(
	segment: string,
	tl: LiteralMessage
): ImportMessageLine {
	const whole = describeText(segment, tl);
	if (whole) {
		return { file: null, translated: true, ...whole };
	}
	// A file name may itself contain ": ", so try each split until the rest is
	// a sentence Core writes.
	let index = segment.indexOf(FILE_SEPARATOR);
	while (index > 0) {
		const rest = segment.slice(index + FILE_SEPARATOR.length);
		const described = describeText(rest, tl);
		if (described) {
			return { file: segment.slice(0, index), translated: true, ...described };
		}
		index = segment.indexOf(FILE_SEPARATOR, index + FILE_SEPARATOR.length);
	}
	return { detail: null, file: null, sentence: segment, translated: false };
}

/**
 * Describes a stored import message; `null` when the row has none. Only a
 * completed (partial) import carries the "Skipped …" note, so a failed row
 * whose first file is itself named "Skipped …" keeps that name.
 */
export function describeImportMessage(
	message: string | null | undefined,
	tl: LiteralMessage,
	{ failed = false }: { failed?: boolean } = {}
): ImportMessageCopy | null {
	const trimmed = message?.trim();
	if (!trimmed) {
		return null;
	}
	const skipped = !failed && trimmed.startsWith(SKIPPED_PREFIX);
	const body = skipped ? trimmed.slice(SKIPPED_PREFIX.length) : trimmed;
	const lines = body
		.split(SEGMENT_SEPARATOR)
		.map((segment) => segment.trim())
		.filter(Boolean)
		.map((segment) => describeSegment(segment, tl));
	return {
		lines,
		skippedHeading: skipped
			? tl(
					"{count, plural, one {Skipped # source:} other {Skipped # sources:}}",
					{ count: lines.length }
				)
			: null,
	};
}

/** The badge label for an import's wire status. */
export function importStatusLabel(
	status: SpaceImportRecord["status"],
	tl: LiteralMessage
): string {
	switch (status) {
		case "pending":
			return tl("Pending");
		case "running":
			return tl("Running");
		case "completed":
			return tl("Completed");
		case "failed":
			return tl("Failed");
		default:
			return status;
	}
}
