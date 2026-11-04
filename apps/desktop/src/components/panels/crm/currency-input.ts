import {
	activeLocale,
	formatLocaleNumberInput,
	parseLocaleNumber,
} from "@ryu/i18n";

/**
 * Integer cents for a CRM currency field typed in the user's locale
 * ("42,50" in German is 4250), or null when the text is not an amount.
 * Rounding happens once, here, so 42.005 cannot drift in as a float.
 */
export function parseCurrencyCents(
	text: string,
	locale?: string
): number | null {
	const amount = parseLocaleNumber(text, locale);
	if (!Number.isFinite(amount)) {
		return null;
	}
	const cents = Math.round(amount * 100);
	return Number.isSafeInteger(cents) ? cents : null;
}

/** Stored cents as the editable amount, in the locale's own decimal form. */
export function currencyInputValue(
	cents: number,
	locale = activeLocale()
): string {
	return formatLocaleNumberInput(cents / 100, locale, 2);
}
