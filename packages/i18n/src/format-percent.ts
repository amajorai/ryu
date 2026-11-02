// Percentages in the reader's number format: "42%" in English, "42 %" in
// German and French, "٪٤٢" in Arabic. Hand-built `${n}%` templates always use
// an ASCII "." and put the sign after the number, which is wrong for most
// locales; charts, tables and summaries call this instead.

import { activeLocale } from "./active-locale.ts";
import { numberFormatter } from "./format-intl.ts";

/**
 * Format a ratio (`0.42` is 42%) as a percentage with exactly
 * `fractionDigits` decimals, in `locale` (the active UI language by default).
 * Callers holding a 0-100 value divide it by 100 first.
 */
export function formatPercent(
	ratio: number,
	fractionDigits = 0,
	locale: string | null | undefined = activeLocale()
): string {
	return numberFormatter(locale, {
		maximumFractionDigits: fractionDigits,
		minimumFractionDigits: fractionDigits,
		style: "percent",
	}).format(ratio);
}
