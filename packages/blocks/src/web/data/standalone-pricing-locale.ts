// The published pricing figures, formatted for the reader's locale at display.
//
// `PRICING_COPY` and the English rows keep the exact English strings the docs
// drift tests compare ("$0.025", "10,000", "26.5%"). A page shown in another
// language formats the same USD figures with that locale's digits, separators
// and currency placement ("0,025 $", "10.000", "26,5 %"). English, and a
// missing locale, always take the English formatters so the published copy
// never changes with the English variant (`en-GB` does not print `US$`).

import { formatNumberValue } from "@ryu/i18n/format-intl";
import {
	formatBps,
	formatCount,
	formatUsd,
	formatUsdRate,
} from "./standalone-pricing-figures.ts";

const BPS_PER_UNIT = 10_000;
const ENGLISH_TAG = /^en(?:-|$)/iu;

/** The number formatters one pricing render uses. */
export interface PricingFormat {
	/** Basis points as a percentage: "26.5%". */
	bps(bps: number): string;
	/** A whole count: "10,000". */
	count(value: number): string;
	/** A plan price, grouped and without trailing zeros: "$1,200". */
	price(amount: number): string;
	/** A USD amount with fixed decimals: "$0.0655". */
	usd(amount: number, fractionDigits?: number): string;
	/** A per-hour rate with as few decimals as it needs, at least two. */
	usdRate(amount: number): string;
}

/** The published English formatters. */
export const ENGLISH_PRICING_FORMAT: PricingFormat = {
	bps: formatBps,
	count: formatCount,
	price: (amount) => `$${formatCount(amount)}`,
	usd: formatUsd,
	usdRate: formatUsdRate,
};

/** Decimals `formatUsdRate` prints for `amount` (two, or up to four). */
function rateDigits(amount: number): number {
	const exact = amount.toFixed(4).replace(/0+$/u, "");
	return Math.max(2, exact.split(".")[1]?.length ?? 0);
}

/** Formatters for `locale`; English (or no locale) gets the published copy. */
export function pricingFormat(locale?: string | null): PricingFormat {
	if (!locale || ENGLISH_TAG.test(locale)) {
		return ENGLISH_PRICING_FORMAT;
	}
	const usd = (amount: number, fractionDigits = 0): string =>
		formatNumberValue(locale, amount, {
			currency: "USD",
			maximumFractionDigits: fractionDigits,
			minimumFractionDigits: fractionDigits,
			style: "currency",
		});
	return {
		bps: (bps) =>
			formatNumberValue(locale, bps / BPS_PER_UNIT, {
				maximumFractionDigits: 2,
				style: "percent",
			}),
		count: (value) => formatNumberValue(locale, value),
		price: (amount) =>
			formatNumberValue(locale, amount, {
				currency: "USD",
				maximumFractionDigits: 2,
				minimumFractionDigits: 0,
				style: "currency",
			}),
		usd,
		usdRate: (amount) => usd(amount, rateDigits(amount)),
	};
}
