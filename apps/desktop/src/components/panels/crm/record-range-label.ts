import type { LiteralMessage } from "@ryu/i18n/react";
import { formatNumber } from "@ryu/ui/lib/number-format.ts";

/**
 * The record table's page range ("1–50 of 120") as one catalogued sentence, so
 * the localizer sees a whole text node instead of the split "of" fragment.
 */
export function recordRangeLabel(
	offset: number,
	count: number,
	total: number,
	tl: LiteralMessage
): string {
	return tl("{start}–{end} of {total}", {
		end: formatNumber(offset + count),
		start: formatNumber(offset + 1),
		total: formatNumber(total),
	});
}
