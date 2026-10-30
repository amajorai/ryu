// Number and cost formatters shared by the Stats settings tab and its parts.

import {
	formatCurrency,
	formatNumber as formatSharedNumber,
} from "@ryu/ui/lib/number-format.ts";

export const formatNumber = (value: number): string =>
	formatSharedNumber(value);
export const formatCost = (microUsd: number): string => {
	const dollars = microUsd / 1_000_000;
	if (dollars > 0 && dollars < 0.01) {
		return "<$0.01";
	}
	return formatCurrency(dollars, "USD", {
		maximumFractionDigits: dollars >= 10 ? 0 : 2,
	});
};
