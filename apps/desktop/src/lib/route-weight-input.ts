// Smart-routing weights are typed in the UI locale: a German user enters a
// relative weight of "0,5", not "0.5". Shared by the Gateway smart-routing
// card and the per-agent override so both read a weight the same way.

import {
	formatLocaleNumberInput,
	parseLocaleNumber,
} from "@ryu/i18n/parse-number";

/** Enough fraction digits that a saved weight round-trips unchanged. */
const WEIGHT_FRACTION_DIGITS = 6;

/**
 * A route weight typed in `locale` (the active UI locale by default). An empty
 * field reads as `empty`; unreadable text reads as NaN so callers refuse it.
 */
export function parseRouteWeight(
	text: string,
	empty: number,
	locale?: string | null
): number {
	return text.trim() === "" ? empty : parseLocaleNumber(text, locale);
}

/** Whether a typed weight should be flagged: not empty and not a number ≥ 0. */
export function routeWeightInvalid(text: string, locale?: string | null) {
	const weight = parseRouteWeight(text, 0, locale);
	return !(Number.isFinite(weight) && weight >= 0);
}

/**
 * A saved weight as editable text in `locale`, so it reads back unchanged: a
 * German 1.125 prefills as "1,125", never "1.125" (which German reads as 1125).
 */
export function routeWeightText(
	weight: number | null | undefined,
	locale?: string | null
): string {
	return formatLocaleNumberInput(weight ?? 1, locale, WEIGHT_FRACTION_DIGITS);
}
