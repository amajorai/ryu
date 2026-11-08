import type { LiteralMessage } from "@ryu/i18n/react";

/**
 * The CRM import button: "Import 1 row" / "Import 3 rows". An ICU plural, so
 * each locale picks its own noun form (Arabic has six), with the count passed
 * as a number for the plural rules.
 */
export function importRowsLabel(tl: LiteralMessage, rowCount: number): string {
	return tl("{rowCount, plural, one {Import # row} other {Import # rows}}", {
		rowCount,
	});
}
