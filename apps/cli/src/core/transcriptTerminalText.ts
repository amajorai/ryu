// Terminal-safe text: strip control sequences and bound external text before it
// reaches an OpenTUI node, with a visible (localized) truncation marker.

import { tf, tr } from "../i18n/translate.ts";

const TERMINAL_ESCAPE = String.fromCharCode(0x1b);
const TERMINAL_BELL = String.fromCharCode(0x07);

function stripAnsiSequences(value: string): string {
	let start = 0;
	let cursor = value.indexOf(TERMINAL_ESCAPE);
	const parts: string[] = [];
	while (cursor !== -1) {
		let end = -1;
		if (value[cursor + 1] === "]") {
			const bell = value.indexOf(TERMINAL_BELL, cursor + 2);
			if (bell === -1) {
				const closingEscape = value.lastIndexOf(`${TERMINAL_ESCAPE}\\`);
				if (closingEscape >= cursor + 2) {
					end = closingEscape + 2;
				}
			} else {
				end = bell + 1;
			}
		} else if (value[cursor + 1] === "[") {
			let final = cursor + 2;
			while (
				value.charCodeAt(final) >= 0x30 &&
				value.charCodeAt(final) <= 0x3f
			) {
				final++;
			}
			while (
				value.charCodeAt(final) >= 0x20 &&
				value.charCodeAt(final) <= 0x2f
			) {
				final++;
			}
			if (value.charCodeAt(final) >= 0x40 && value.charCodeAt(final) <= 0x7e) {
				end = final + 1;
			}
		}
		if (end === -1) {
			cursor++;
		} else {
			parts.push(value.slice(start, cursor));
			start = end;
			cursor = end;
		}
		cursor = value.indexOf(TERMINAL_ESCAPE, cursor);
	}
	parts.push(value.slice(start));
	return parts.join("");
}

function stripUnsafeTerminalCharacters(value: string): string {
	let output = "";
	for (const character of value) {
		const code = character.charCodeAt(0);
		if (
			code <= 0x08 ||
			code === 0x0b ||
			code === 0x0c ||
			(code >= 0x0e && code <= 0x1f) ||
			(code >= 0x7f && code <= 0x9f)
		) {
			continue;
		}
		output += character;
	}
	return output;
}

export interface BoundedTerminalText {
	omittedChars: number;
	omittedLines: number;
	text: string;
	truncated: boolean;
}

export interface BoundTerminalTextOptions {
	label?: string;
	maxChars: number;
	maxLines?: number;
}

/** Remove terminal control sequences before external text reaches an OpenTUI node. */
export const sanitizeTerminalText = (value: string): string =>
	stripUnsafeTerminalCharacters(
		stripAnsiSequences(value.replace(/\r\n?/g, "\n"))
	).replace(/\t/g, "  ");

const normalizedLimit = (value: number): number =>
	Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;

const truncationMarker = (
	label: string,
	omittedChars: number,
	omittedLines: number
): string => {
	if (omittedLines > 0) {
		return tf(
			"[{label} truncated: {count, plural, one {# more line} other {# more lines}}]",
			{ count: omittedLines, label: tr(label) }
		);
	}
	return tf(
		"[{label} truncated: {count, plural, one {# more character} other {# more characters}}]",
		{ count: omittedChars, label: tr(label) }
	);
};

/** Bound both row count and character count while keeping a visible marker. */
export const boundTerminalText = (
	value: string,
	options: BoundTerminalTextOptions
): BoundedTerminalText => {
	const sanitized = sanitizeTerminalText(value);
	const maxChars = normalizedLimit(options.maxChars);
	const maxLines =
		options.maxLines === undefined
			? undefined
			: normalizedLimit(options.maxLines);
	const sourceLines = sanitized.split("\n");
	const lineLimited = maxLines !== undefined && sourceLines.length > maxLines;
	const initialLines = lineLimited
		? sourceLines.slice(0, maxLines)
		: sourceLines;
	const initialText = initialLines.join("\n");
	const charLimited = initialText.length > maxChars;

	if (!(lineLimited || charLimited)) {
		return {
			text: initialText,
			truncated: false,
			omittedChars: 0,
			omittedLines: 0,
		};
	}

	const omittedLines = lineLimited
		? sourceLines.length - initialLines.length
		: 0;
	const omittedChars = Math.max(0, sanitized.length - initialText.length);
	const label = sanitizeTerminalText(options.label ?? "text") || "text";
	const marker = truncationMarker(label, omittedChars, omittedLines);

	// Reserve the final line for the marker so maxLines remains a real terminal
	// bound rather than an approximate payload-only limit.
	const contentLines =
		maxLines === undefined
			? initialLines
			: initialLines.slice(0, Math.max(0, maxLines - 1));
	let content = contentLines.join("\n");
	const separatorLength = content.length > 0 ? 1 : 0;
	const markerText = marker.slice(0, maxChars);
	const contentBudget = Math.max(
		0,
		maxChars - separatorLength - markerText.length
	);
	content = content.slice(0, contentBudget);

	return {
		text: `${content}${content.length > 0 ? "\n" : ""}${markerText}`,
		truncated: true,
		omittedChars: Math.max(0, sanitized.length - content.length),
		omittedLines,
	};
};

/**
 * Collapse whitespace to one row and clamp it to `maxChars` with an ellipsis.
 * `keep: "end"` drops the start instead, so a long path keeps its file name.
 */
export const clampTerminalLine = (
	value: string,
	maxChars: number,
	keep: "start" | "end" = "start"
): string => {
	const line = value.replace(/\s+/g, " ").trim();
	const limit = normalizedLimit(maxChars);
	const chars = [...line];
	if (chars.length <= limit) {
		return line;
	}
	const budget = Math.max(1, limit - 1);
	return keep === "end"
		? `…${chars.slice(-budget).join("").trimStart()}`
		: `${chars.slice(0, budget).join("").trimEnd()}…`;
};
