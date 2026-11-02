/**
 * Guards that keep the DOM localizer off text that is already localized.
 *
 * `tl()`/`t()` output reaches the DOM as plain strings, so the localizer
 * cannot see that a sentence such as `Release notes を開く` (the Japanese of
 * `Open {name}` around a user's thread title) was already translated. The
 * runtime records each translated output here and the localizer leaves a
 * value it finds in the record alone. Text with no Latin letter at all is
 * never English source; template captures that mix scripts are refused in
 * `literal-template-parse.ts`.
 */

/** Most translated outputs remembered; the oldest are dropped first. */
export const LOCALIZED_OUTPUT_LIMIT = 2000;

const outputs = new Set<string>();
let outputsLocale: string | null = null;

function normalize(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

/**
 * Record `output`, a message the runtime translated for `locale`. Outputs of
 * an earlier locale are forgotten when the locale changes.
 */
export function rememberLocalizedOutput(locale: string, output: string): void {
	if (outputsLocale !== locale) {
		outputs.clear();
		outputsLocale = locale;
	}
	const key = normalize(output);
	if (!key) {
		return;
	}
	// Re-inserting moves the entry to the end, so Set order is an LRU.
	outputs.delete(key);
	outputs.add(key);
	if (outputs.size > LOCALIZED_OUTPUT_LIMIT) {
		const oldest = outputs.values().next().value;
		if (oldest !== undefined) {
			outputs.delete(oldest);
		}
	}
}

/** Whether `value` is a message the runtime translated recently. */
export function isLocalizedOutput(value: string): boolean {
	return outputs.size > 0 && outputs.has(normalize(value));
}

/** Test seam: forget every recorded output. */
export function clearLocalizedOutputs(): void {
	outputs.clear();
	outputsLocale = null;
}

/** A letter of any script other than Latin (CJK, Hangul, Arabic, Cyrillic…). */
const NON_LATIN_LETTER = /(?!\p{Script=Latin})\p{L}/u;
const LATIN_LETTER = /\p{Script=Latin}/u;

/** Whether `value` holds letters of a non-Latin script. */
export function hasNonLatinLetters(value: string): boolean {
	return NON_LATIN_LETTER.test(value);
}

/**
 * Whether `value` has letters of a non-Latin script and no Latin letter.
 * Catalog sources are English, so such text is already translated or user
 * data and cannot match a literal or a template. Mixed text (`Deleted 田中`)
 * still reaches the templates, whose captures may not mix scripts.
 */
export function isWhollyNonLatin(value: string): boolean {
	return NON_LATIN_LETTER.test(value) && !LATIN_LETTER.test(value);
}
