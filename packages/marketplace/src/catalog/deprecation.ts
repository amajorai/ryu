// packages/marketplace/src/catalog/deprecation.ts
//
// Whether a listing is deprecated, as the store renders it. Shared because the
// card badge, the hero chip and the detail notice must agree: a listing that is
// "Deprecated" on its card and silent on its detail page looks like a bug.

import type { CatalogDeprecation } from "./types.ts";

/** Display label for the deprecated badge and hero chip. */
export const DEPRECATED_LABEL = "Deprecated";

/** True when the producer marked the listing deprecated. Presence is the signal:
 *  `{}` is a deprecation without a message, and absent/null means current. */
export function isDeprecated(
	deprecated: CatalogDeprecation | null | undefined
): deprecated is CatalogDeprecation {
	return typeof deprecated === "object" && deprecated !== null;
}

/** The notice to render, preferring the detail payload (fresher, read from the
 *  selected build) over the card it was opened from. `null` = current. */
export function resolveDeprecation(
	detail: CatalogDeprecation | null | undefined,
	card: CatalogDeprecation | null | undefined
): { message: string | null; replacement: string | null } | null {
	const source = isDeprecated(detail) ? detail : card;
	if (!isDeprecated(source)) {
		return null;
	}
	return {
		message: source.message?.trim() || null,
		replacement: source.replacement?.trim() || null,
	};
}
