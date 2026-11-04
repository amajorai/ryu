// Locale-aware draft text for the fallback-rule threshold inputs (USD amounts
// with inputMode="decimal", percents with inputMode="numeric"). `Number("0,50")`
// is NaN, so a comma-decimal user could not save a "below $0,50" condition.

import {
	activeLocale,
	formatLocaleNumberInput,
	parseLocaleNumber,
} from "@ryu/i18n";

/** Enough digits to round-trip sub-cent USD thresholds. */
const DRAFT_FRACTION_DIGITS = 6;

/** A committed threshold as the user would type it in `locale`. */
export function formatThresholdDraft(
	value: number,
	locale: string | null | undefined = activeLocale()
): string {
	return Number.isFinite(value)
		? formatLocaleNumberInput(value, locale, DRAFT_FRACTION_DIGITS)
		: "";
}

/** Parse draft text written in `locale`; NaN when blank or malformed. */
export function parseThresholdDraft(
	text: string,
	locale: string | null | undefined = activeLocale()
): number {
	return parseLocaleNumber(text, locale);
}
