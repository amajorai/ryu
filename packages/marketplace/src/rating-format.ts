// packages/marketplace/src/rating-format.ts
//
// The one place a review average becomes visible text. A hand-written
// `toFixed(1)` printed "4.5" for every reader, so German, French and Russian
// listings showed an English decimal point next to otherwise translated copy.

import { activeLocale, numberFormatter } from "@ryu/i18n/lite";

const ONE_DECIMAL: Intl.NumberFormatOptions = {
	maximumFractionDigits: 1,
	minimumFractionDigits: 1,
};

/** A review average with exactly one decimal in the UI language ("4.5", "4,5").
 *  A missing or non-finite average reads as zero, the same as the star row. */
export function formatRatingAverage(
	average: number | null | undefined,
	locale: string = activeLocale()
): string {
	const value =
		typeof average === "number" && Number.isFinite(average) ? average : 0;
	return numberFormatter(locale, ONE_DECIMAL).format(
		Math.round(value * 10) / 10
	);
}
