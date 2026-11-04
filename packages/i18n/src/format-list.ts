// Lists in the reader's language: "a, b and c" in English, "a、b、c" in
// Japanese, "a، b و c" in Arabic. A hand-built `items.join(", ")` inside a
// translated sentence keeps the English comma and has no final "and"; model
// files and components call this instead.

import { activeLocale } from "./active-locale.ts";
import { hasIntl, joinListFallback } from "./intl-guards.ts";

/** How the list reads: `"conjunction"` ("a, b and c"), `"disjunction"` ("a, b or c") or `"unit"` ("a, b, c"). */
export type ListFormatType = "conjunction" | "disjunction" | "unit";

/**
 * Join `items` the way `locale` (the active UI language by default) writes a
 * list. An unusable tag falls back to English rather than throwing, and an
 * engine without `Intl.ListFormat` (Hermes) gets a plain comma join.
 */
export function formatList(
	items: readonly string[],
	type: ListFormatType = "conjunction",
	locale: string | null | undefined = activeLocale()
): string {
	if (!hasIntl("ListFormat")) {
		return joinListFallback(items, locale, type);
	}
	try {
		return new Intl.ListFormat(locale ?? undefined, { type }).format(items);
	} catch {
		return new Intl.ListFormat("en", { type }).format(items);
	}
}
