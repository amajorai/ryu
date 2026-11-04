// The Guardrails spend-cap field reads and shows dollars in the UI locale: a
// German admin types "100,50" and sees a saved cap as "100,5". Kept apart from
// policy-model.ts so the model stays a plain, locale-free policy shape.

import {
	formatLocaleNumberInput,
	parseLocaleNumber,
} from "@ryu/i18n/parse-number";

const MICRO_PER_USD = 1_000_000;
/** Microdollars carry six fractional digits of a dollar. */
const USD_FRACTION_DIGITS = 6;

/**
 * Dollars typed in `locale` (the active UI locale by default) to whole
 * microdollars, or `null` for empty, unreadable or negative input.
 */
export function parseUsdMicroInput(
	text: string,
	locale?: string | null
): number | null {
	if (text.trim() === "") {
		return null;
	}
	const value = parseLocaleNumber(text, locale);
	if (!Number.isFinite(value) || value < 0) {
		return null;
	}
	return Math.round(value * MICRO_PER_USD);
}

/** Microdollars as an ungrouped dollar amount for an input, in `locale`. */
export function formatUsdMicroInput(
	usdMicro: number,
	locale?: string | null
): string {
	return formatLocaleNumberInput(
		usdMicro / MICRO_PER_USD,
		locale,
		USD_FRACTION_DIGITS
	);
}
