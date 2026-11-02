/**
 * The language a card's painted labels come out in.
 *
 * Canvas text is beyond the DOM localizer's reach, so every label a painter
 * draws goes through one of these. Builders take a `PassTranslate` and default
 * to `activePassTranslate`: the language the UI is showing in the app, and
 * English on the server, where cached OG and share images are rendered. A
 * caller that already holds `useLiteralMessages()` can pass it instead.
 */

import {
	activeLocale,
	formatMessage,
	type MessageValuesInput,
	numberFormatter,
	translate,
} from "@ryu/i18n/lite";

/** Resolves an English source message to the card's language. */
export type PassTranslate = (
	source: string,
	values?: MessageValuesInput
) => string;

/** The UI's language (the mounted provider's), English before one mounts. */
export const activePassTranslate: PassTranslate = (source, values) =>
	translate(source, values);

/** Always English: for faces that stay English wherever they are rendered. */
export const englishPassTranslate: PassTranslate = (source, values = {}) =>
	formatMessage(source, values, "en");

/** The locale numbers on a card format in: the UI's, English on the server. */
export function passLocale(): string {
	return activeLocale();
}

/** "2.5h": hours with one decimal, in the locale's narrow unit. */
export function formatPassDecimalHours(
	hours: number,
	locale: string = passLocale()
): string {
	return numberFormatter(locale, {
		maximumFractionDigits: 1,
		minimumFractionDigits: 1,
		style: "unit",
		unit: "hour",
		unitDisplay: "narrow",
		useGrouping: false,
	}).format(hours);
}

/** "12d": whole days in the locale's narrow unit. */
export function formatPassDays(
	days: number,
	locale: string = passLocale()
): string {
	return numberFormatter(locale, {
		style: "unit",
		unit: "day",
		unitDisplay: "narrow",
		useGrouping: false,
	}).format(days);
}
