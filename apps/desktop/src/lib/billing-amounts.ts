import { translate } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import { formatCurrency } from "@ryu/ui/lib/number-format.ts";

/** Whole-dollar amounts keep "$50" in English and add cents only when present. */
const WHOLE_USD: Intl.NumberFormatOptions = {
	maximumFractionDigits: 2,
	minimumFractionDigits: 2,
	trailingZeroDisplay: "stripIfInteger",
};

/**
 * Format a USD amount held in dollars in the UI language: "$1,000" in
 * English, "1.000 $" in German. Use it for every price passed into a sentence
 * instead of a hand-built `$${amount}`.
 */
export function formatWholeUsd(dollars: number): string {
	return formatCurrency(dollars, "USD", WHOLE_USD);
}

/** "1 member seat" / "12 member seats", plural and digits in the UI language. */
export function memberSeatCountLabel(
	count: number,
	tl: LiteralMessage = translate
): string {
	return tl("{count, plural, one {# member seat} other {# member seats}}", {
		count,
	});
}
