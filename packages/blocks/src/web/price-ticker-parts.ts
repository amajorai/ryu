// The currency symbol around an animated price ticker, placed for the locale.
//
// `NumberTicker` animates the digits and prints a fixed prefix and suffix
// around them. A hard-coded `prefix="$"` reads "$2.400" in German, where the
// rest of the pricing copy (`pricingFormat`) reads "2.400 $". These affixes
// come from the same `Intl` currency parts, so the ticker and the text agree.
// English, and a missing locale, keep the published "$" prefix (`en-GB` would
// otherwise print "US$"), matching `pricingFormat`.

import { useOptionalI18n } from "@ryu/i18n/react";

const ENGLISH_TAG = /^en(?:-|$)/iu;
const NUMBER_PARTS = new Set(["integer", "group", "decimal", "fraction"]);

/** What a price ticker prints before and after its digits. */
export interface CurrencyAffixes {
	prefix: string;
	suffix: string;
}

const ENGLISH_USD: CurrencyAffixes = { prefix: "$", suffix: "" };

/** The text before and after the number in `locale`'s currency form. */
export function currencyAffixes(
	locale?: string | null,
	currency = "USD"
): CurrencyAffixes {
	if (!locale || (ENGLISH_TAG.test(locale) && currency === "USD")) {
		return { ...ENGLISH_USD };
	}
	let parts: Intl.NumberFormatPart[];
	try {
		parts = new Intl.NumberFormat(locale, {
			currency,
			maximumFractionDigits: 0,
			style: "currency",
		}).formatToParts(1);
	} catch {
		return { ...ENGLISH_USD };
	}
	const first = parts.findIndex((part) => NUMBER_PARTS.has(part.type));
	if (first < 0) {
		return { ...ENGLISH_USD };
	}
	let last = first;
	for (const [index, part] of parts.entries()) {
		if (NUMBER_PARTS.has(part.type)) {
			last = index;
		}
	}
	const join = (slice: Intl.NumberFormatPart[]) =>
		slice.map((part) => part.value).join("");
	return {
		prefix: join(parts.slice(0, first)),
		suffix: join(parts.slice(last + 1)),
	};
}

/** The price-ticker affixes for the current UI language. */
export function usePriceTickerAffixes(currency = "USD"): CurrencyAffixes {
	return currencyAffixes(useOptionalI18n()?.locale, currency);
}
