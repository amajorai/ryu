// packages/marketplace/src/catalog/listing-stat-labels.ts
//
// Translated copy for the listing stat strip (apps-catalog-section-detail-aside).
// The strip is built as plain data outside React, so these helpers use the
// runtime `translate` rather than the hook. They exist because the old cells
// spliced "{n} Ratings" and an English ", " join of surface names together,
// which no catalog entry could translate.

import { formatList, translate as tl } from "@ryu/i18n/lite";
import { formatCount } from "./detail/detail-format.ts";
import { surfaceLabel } from "./surface-labels.ts";

/** "1 rating" / "1,234 ratings" in the reader's language. The count keeps the
 *  store's compact count policy ("1.2m"), and the plural follows the raw number. */
export function ratingCountLabel(count: number): string {
	return tl(
		"{count, plural, one {{formatted} rating} other {{formatted} ratings}}",
		{ count, formatted: formatCount(count) }
	);
}

/** The "Runs on" cell: each surface's translated name, joined as a list in the
 *  reader's language ("Desktop and Web", "デスクトップ、ウェブ"). An unknown
 *  surface keeps its raw token, as `surfaceLabel` does. */
export function surfaceListLabel(surfaces: readonly string[]): string {
	return formatList(surfaces.map((surface) => translateLabel(surface)));
}

function translateLabel(surface: string): string {
	const label = surfaceLabel(surface);
	// A raw manifest token is not catalog copy; never send it through ICU parsing.
	return /[{}]/.test(label) ? label : tl(label);
}
