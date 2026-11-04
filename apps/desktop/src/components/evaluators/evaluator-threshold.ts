// Locale-aware parsing for the evaluator pass threshold field. The field is a
// type="text" input with inputMode="decimal", so a German author types "0,7";
// `Number.parseFloat` would read that as 0 and silently save a threshold that
// every run passes.

import {
	activeLocale,
	formatLocaleNumberInput,
	parseLocaleNumber,
} from "@ryu/i18n";

/** The pass threshold a new judge evaluator starts with. */
export const DEFAULT_PASS_THRESHOLD = 0.7;

/** The default threshold as the user would type it in `locale` ("0,7" in de). */
export function defaultThresholdInput(
	locale: string | null | undefined = activeLocale()
): string {
	return formatLocaleNumberInput(DEFAULT_PASS_THRESHOLD, locale, 2);
}

/**
 * Parse the threshold text written in `locale`. Returns NaN for empty or
 * malformed input; the caller keeps its own 0–1 range check.
 */
export function parseThresholdInput(
	text: string,
	locale: string | null | undefined = activeLocale()
): number {
	return parseLocaleNumber(text, locale);
}
