import { activeLocale, numberFormatter } from "@ryu/i18n/lite";

const ONE_DECIMAL: Intl.NumberFormatOptions = {
	maximumFractionDigits: 1,
	minimumFractionDigits: 1,
};

/** A review average with one decimal in the UI language ("4.5", "4,5"). */
export function formatRatingAverage(
	average: number | null | undefined,
	locale: string = activeLocale()
): string {
	const value = Number.isFinite(average) ? (average as number) : 0;
	return numberFormatter(locale, ONE_DECIMAL).format(
		Math.round(value * 10) / 10
	);
}
