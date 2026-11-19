/**
 * Large bracketed pastes collapse into a short placeholder token in the chat
 * composer so a pasted log or file does not swamp the input box. The real text
 * is kept beside the composer and swapped back in when the prompt is sent.
 * The token reads in the CLI locale; expansion is keyed on the generated token
 * itself, so a translated token expands the same way.
 */

import { CLI_TRANSLATOR, type CliTranslator } from "../i18n/translate.ts";

/** A paste with at least this many lines collapses into a placeholder. */
export const PASTE_PLACEHOLDER_MIN_LINES = 3;
/** A paste longer than this many characters collapses into a placeholder. */
export const PASTE_PLACEHOLDER_MAX_CHARS = 150;

/** Terminals deliver CRLF or bare CR line breaks; the composer stores LF only. */
export function normalizePastedText(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

export function shouldCollapsePaste(text: string): boolean {
	return (
		text.split("\n").length >= PASTE_PLACEHOLDER_MIN_LINES ||
		text.length > PASTE_PLACEHOLDER_MAX_CHARS
	);
}

/** The placeholder shown in the composer for the `sequence`-th paste. */
export function pastePlaceholderToken(
	text: string,
	sequence: number,
	translator: Pick<CliTranslator, "tf"> = CLI_TRANSLATOR
): string {
	const { tf } = translator;
	const lines = text.split("\n").length;
	return lines >= PASTE_PLACEHOLDER_MIN_LINES
		? tf("[Pasted {count, plural, one {# line} other {# lines}} #{sequence}]", {
				count: lines,
				sequence,
			})
		: tf("[Pasted {count, plural, one {# char} other {# chars}} #{sequence}]", {
				count: text.length,
				sequence,
			});
}

/**
 * Replace every placeholder still present in `text` with its pasted content.
 * A placeholder the user edited no longer matches and stays literal text.
 */
export function expandPastePlaceholders(
	text: string,
	pastes: ReadonlyMap<string, string>
): string {
	let expanded = text;
	for (const [token, content] of pastes) {
		expanded = expanded.split(token).join(content);
	}
	return expanded;
}
