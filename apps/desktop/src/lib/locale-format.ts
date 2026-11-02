// Dates and numbers in the language the UI shows.
//
// `toLocaleString()` and `Intl.*Format(undefined)` follow the OS/webview
// locale, not the Ryu language the user picked, so a Japanese UI on an English
// OS printed "Oct 30, 2026, 3:04 PM". These wrappers read `activeLocale()` and
// reuse cached formatters, so model files and components share one spelling.

import { activeLocale, dateFormatter, numberFormatter } from "@ryu/i18n/core";

type DateValue = Date | number | string;

const DATE_TIME: Intl.DateTimeFormatOptions = {
	dateStyle: "medium",
	timeStyle: "short",
};
const TIME: Intl.DateTimeFormatOptions = { timeStyle: "medium" };

/** "Oct 30, 2026, 3:04 PM" / "2026/10/30 15:04"; `toLocaleString()` for dates. */
export function formatLocalDateTime(
	value: DateValue,
	options: Intl.DateTimeFormatOptions = DATE_TIME,
	locale: string = activeLocale()
): string {
	return dateFormatter(locale, options).format(new Date(value));
}

/** "3:04:05 PM" / "15:04:05"; `toLocaleTimeString()` in the UI language. */
export function formatLocalTime(
	value: DateValue,
	locale: string = activeLocale()
): string {
	return dateFormatter(locale, TIME).format(new Date(value));
}

/** "1,234" / "1.234"; `toLocaleString()` for numbers in the UI language. */
export function formatLocalNumber(
	value: number,
	options?: Intl.NumberFormatOptions,
	locale: string = activeLocale()
): string {
	return numberFormatter(locale, options).format(value);
}

/** "a, b and c" / "a、b、c" in the UI language. */
export function formatLocalList(
	items: readonly string[],
	type: Intl.ListFormatType = "conjunction",
	locale: string = activeLocale()
): string {
	try {
		return new Intl.ListFormat(locale, { type }).format(items);
	} catch {
		return new Intl.ListFormat("en", { type }).format(items);
	}
}

/** "$0.0123" under a dollar, "$1.23" from a dollar up, in the UI's digits. */
export function formatUsd(
	usd: number,
	locale: string = activeLocale()
): string {
	const digits = usd >= 1 ? 2 : 4;
	return formatLocalNumber(
		usd,
		{
			currency: "USD",
			maximumFractionDigits: digits,
			minimumFractionDigits: digits,
			style: "currency",
		},
		locale
	);
}
