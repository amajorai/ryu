// Locale-aware readouts for the transcript chrome: durations ("1m 23s"),
// decimals ("12.5 tok/s"), percentages and byte sizes. English output stays
// byte-identical to the hand-built strings these replace, so existing layouts
// and tests keep their shape; every other locale gets its own digits, decimal
// separator and unit abbreviations ("1分 23秒", "12,5", "1,5 Mo").
//
// Each helper takes an optional `locale` and defaults to the language the UI
// is showing (`activeLocale()`), so model files without `useI18n()` format in
// the active language too.

import { activeLocale, isEnglishLocale, numberFormatter } from "@ryu/i18n/core";

// The duration helpers live in `@ryu/i18n/format-intl`; this path stays
// stable for the transcript chrome that imports them from here.
export {
	type DurationUnit,
	formatDurationParts,
	formatDurationUnit,
} from "@ryu/i18n/format-intl";

/** Byte units a file size reads in. */
type ByteUnit = "byte" | "kilobyte" | "megabyte";

const ENGLISH_BYTE_SUFFIX: Record<ByteUnit, string> = {
	byte: " B",
	kilobyte: " KB",
	megabyte: " MB",
};

const KIBIBYTE = 1024;

/** A space between a number and a unit written in a script without spaces. */
const CJK_UNIT_GAP = /(\d)[\s  ]+(?=[぀-ヿ㐀-鿿가-힯])/gu;

function fixedDigits(fractionDigits: number): Intl.NumberFormatOptions {
	return {
		maximumFractionDigits: fractionDigits,
		minimumFractionDigits: fractionDigits,
	};
}

function formatUnit(
	locale: string,
	value: number,
	unit: string,
	fractionDigits: number
): string {
	return numberFormatter(locale, {
		style: "unit",
		unit,
		// Short, not narrow: narrow forms collide in some locales (`5m` reads
		// as both minutes and months in Japanese).
		unitDisplay: "short",
		...fixedDigits(fractionDigits),
	})
		.format(value)
		.replace(CJK_UNIT_GAP, "$1");
}

/** `value` with exactly `fractionDigits` decimals: "12.50" in en, "12,50" in de. */
export function formatDecimal(
	value: number,
	fractionDigits: number,
	locale: string = activeLocale()
): string {
	if (isEnglishLocale(locale)) {
		return value.toFixed(fractionDigits);
	}
	return numberFormatter(locale, fixedDigits(fractionDigits)).format(value);
}

/**
 * A percentage given on the 0-100 scale: "42%" or "0.5%" in en, "42 %" in
 * fr, "٪42" in ar.
 */
export function formatPercentValue(
	value: number,
	fractionDigits = 0,
	locale: string = activeLocale()
): string {
	if (isEnglishLocale(locale)) {
		return `${value.toFixed(fractionDigits)}%`;
	}
	return numberFormatter(locale, {
		style: "percent",
		...fixedDigits(fractionDigits),
	}).format(value / 100);
}

/** "512 B", "1.5 KB", "2.0 MB" in en (1024-based); the locale's byte units elsewhere. */
export function formatByteSize(
	bytes: number,
	locale: string = activeLocale()
): string {
	let unit: ByteUnit = "megabyte";
	let value = bytes / (KIBIBYTE * KIBIBYTE);
	if (bytes < KIBIBYTE) {
		unit = "byte";
		value = bytes;
	} else if (bytes < KIBIBYTE * KIBIBYTE) {
		unit = "kilobyte";
		value = bytes / KIBIBYTE;
	}
	const fractionDigits = unit === "byte" ? 0 : 1;
	if (isEnglishLocale(locale)) {
		return `${value.toFixed(fractionDigits)}${ENGLISH_BYTE_SUFFIX[unit]}`;
	}
	return formatUnit(locale, value, unit, fractionDigits);
}

/** A count in compact notation with at most one decimal: "1.2K" in en, "1.2万" in ja, "1,2 Mio." in de. */
export function formatCompactNumber(
	value: number,
	locale: string = activeLocale()
): string {
	return numberFormatter(isEnglishLocale(locale) ? "en-US" : locale, {
		maximumFractionDigits: 1,
		notation: "compact",
	}).format(value);
}

/**
 * Items joined the locale's way. `"unit"` only separates ("a, b" in en,
 * "a、b" in ja); `"conjunction"` adds the final "and" ("a, b, and c").
 */
export function formatList(
	items: readonly string[],
	type: "conjunction" | "unit" = "unit",
	locale: string = activeLocale()
): string {
	try {
		return new Intl.ListFormat(locale, {
			style: type === "unit" ? "short" : "long",
			type,
		}).format(items);
	} catch {
		return items.join(", ");
	}
}
