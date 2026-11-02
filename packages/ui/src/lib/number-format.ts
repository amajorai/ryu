import { activeLocale, numberFormatter } from "@ryu/i18n/lite";

/** Native numeric formatting rejects non-numbers without coercing them. The ticker
 * owns String presentation for those operands, including legacy stored counts. */
/** Native conversion reads these method slots lazily, and permits malformed slots
 * to produce their original errors. Function, Date, proxy and null-prototype
 * operands retain their native identities and additional fields. */
export interface NativeCountConversion {
	toString?: unknown;
	valueOf?: unknown;
	[Symbol.toPrimitive]?: unknown;
}
export type CountFormattingInput =
	| number
	| string
	| boolean
	| bigint
	| symbol
	| null
	| undefined
	| NativeCountConversion;

const MILLION = 1_000_000;

/**
 * The tag every English locale formats with. English output is the product's
 * display policy (`1,234`, `1.2m`, `$1.2m`) and stays byte-identical whatever
 * the English variant, so `en-GB` does not start printing `US$`.
 */
const ENGLISH_FORMAT_LOCALE = "en-US";

const INTEGER_OPTIONS: Intl.NumberFormatOptions = { maximumFractionDigits: 0 };
const NUMBER_OPTIONS: Intl.NumberFormatOptions = { maximumFractionDigits: 3 };
const MILLION_OPTIONS: Intl.NumberFormatOptions = { maximumFractionDigits: 1 };
const COMPACT_OPTIONS: Intl.NumberFormatOptions = {
	compactDisplay: "short",
	maximumFractionDigits: 1,
	minimumFractionDigits: 0,
	notation: "compact",
};

function isFiniteNumber(value: CountFormattingInput): value is number {
	return value !== null && value !== undefined && Number.isFinite(value);
}

/** English (or no usable tag) formats with the fixed English policy. */
function isEnglish(locale: string | null | undefined): boolean {
	return !locale || /^en(?:-|$)/iu.test(locale);
}

function formatLocale(locale: string | null | undefined): string {
	return isEnglish(locale) ? ENGLISH_FORMAT_LOCALE : (locale as string);
}

/**
 * Format a count without hiding the thousands digit-by-digit.
 *
 * Counts below one million use the locale's grouping (`1,234`, `1.234`);
 * million-scale counts are compact. English keeps its lowercase suffix
 * (`1.2m`), the display policy shared by the website and desktop app; other
 * locales use their own compact form (`1,2 Mio.`, `123万`). `locale` defaults
 * to the language the UI is showing.
 */
export function formatCount(
	value: CountFormattingInput,
	locale: string = activeLocale()
): string | null {
	if (!isFiniteNumber(value)) {
		return null;
	}
	const english = isEnglish(locale);
	const tag = formatLocale(locale);

	if (Math.abs(value) >= MILLION) {
		return english
			? `${numberFormatter(tag, MILLION_OPTIONS).format(value / MILLION)}m`
			: numberFormatter(tag, COMPACT_OPTIONS).format(value);
	}

	return numberFormatter(
		tag,
		Number.isInteger(value) ? INTEGER_OPTIONS : NUMBER_OPTIONS
	).format(value);
}

/** Format a required numeric readout, returning an em dash for bad input. */
export function formatNumber(
	value: number | null | undefined,
	locale: string = activeLocale()
): string {
	return formatCount(value, locale) ?? "—";
}

/**
 * Format a currency amount in its display unit.
 *
 * Normal amounts keep currency decimals and the locale's separators. Values at
 * or above one million are compact so a large balance does not overwhelm a card
 * or table row: English keeps its lowercase suffix (`$1.2m`), other locales use
 * their own compact currency form. `locale` defaults to the UI's language.
 */
export function formatCurrency(
	value: number | null | undefined,
	currency = "USD",
	options: Intl.NumberFormatOptions = {},
	locale: string = activeLocale()
): string {
	if (!isFiniteNumber(value)) {
		return "—";
	}
	const tag = formatLocale(locale);
	const code = currency.toUpperCase();

	if (Math.abs(value) >= MILLION) {
		const formatter = numberFormatter(tag, {
			...COMPACT_OPTIONS,
			currency: code,
			style: "currency",
		});
		if (!isEnglish(locale)) {
			return formatter.format(value);
		}
		return formatter
			.formatToParts(value)
			.map((part) =>
				part.type === "compact" ? part.value.toLowerCase() : part.value
			)
			.join("");
	}

	return numberFormatter(tag, {
		currency: code,
		style: "currency",
		...options,
	}).format(value);
}

/** Format integer minor currency units such as cents. */
export function formatMinorCurrency(
	minor: number | null | undefined,
	currency = "USD",
	options: Intl.NumberFormatOptions = {
		maximumFractionDigits: 2,
		minimumFractionDigits: 2,
	},
	locale: string = activeLocale()
): string {
	return formatCurrency(
		isFiniteNumber(minor) ? minor / 100 : null,
		currency,
		options,
		locale
	);
}

/** Format integer micro-USD units while retaining sub-cent usage precision. */
export function formatMicroUsd(
	microUsd: number | null | undefined,
	currency = "USD",
	maximumFractionDigits = 4,
	locale: string = activeLocale()
): string {
	return formatCurrency(
		isFiniteNumber(microUsd) ? microUsd / MILLION : null,
		currency,
		{
			maximumFractionDigits,
			minimumFractionDigits: 2,
		},
		locale
	);
}
