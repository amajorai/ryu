// Locale-aware text for the price monitor threshold field (type="text",
// inputMode="decimal"). `Number("12,50")` is NaN, which serializes to null and
// silently drops the threshold a German user typed.

import {
	activeLocale,
	formatLocaleNumberInput,
	parseLocaleNumber,
} from "@ryu/i18n";

/** Enough digits to round-trip any threshold a user would type. */
const THRESHOLD_FRACTION_DIGITS = 6;

/** A stored threshold as the user would type it in `locale` ("12,5" in de). */
export function formatThresholdInput(
	value: number | null | undefined,
	locale: string | null | undefined = activeLocale()
): string {
	if (value == null || !Number.isFinite(value)) {
		return "";
	}
	return formatLocaleNumberInput(value, locale, THRESHOLD_FRACTION_DIGITS);
}

/**
 * Parse the threshold text written in `locale`. Blank text means "no
 * threshold" (null); text that does not read as a number is also null, as the
 * NaN it replaced was serialized.
 */
export function parseThresholdInput(
	text: string,
	locale: string | null | undefined = activeLocale()
): number | null {
	if (!text.trim()) {
		return null;
	}
	const value = parseLocaleNumber(text, locale);
	return Number.isFinite(value) ? value : null;
}
