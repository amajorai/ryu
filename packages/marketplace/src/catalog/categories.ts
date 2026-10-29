// packages/marketplace/src/catalog/categories.ts
//
// The Store's category vocabulary — the shelves the Apps and Plugins tabs group
// their cards into, and the order those shelves appear in.
//
// Order is EDITORIAL, not alphabetical. A store front page is a ranking: the
// shelves people came for go first, the plumbing goes last. Alphabetising it would
// open every visit with "Automation" and bury "Search" in the middle.
//
// The vocabulary is deliberately SHARED with the manifests: a manifest's free-text
// `category` is matched against this list (case- and separator-insensitively), so
// "Developer Tools", "developer-tools" and "developer tools" all land on the same
// shelf. That tolerance is the point — the value crosses a JSON boundary written by
// hand, and a shelf that silently splits in two because someone typed a hyphen is a
// worse failure than a slightly fuzzy match.
//
// An UNKNOWN category is not an error and is never dropped: it renders as its own
// shelf, sorted after every known one. So a satellite app can introduce a category
// the shipped client has never heard of and it still lists correctly — the same
// degrade-don't-break rule `stability` and `surfaces` already follow.

/** The canonical shelves, in the order the Store renders them. */
export const STORE_CATEGORY_ORDER: readonly string[] = [
	"Browsers",
	"Search",
	"Automation",
	"Documents",
	"Knowledge & Memory",
	"Communication",
	"Productivity",
	"Creative",
	// Themes ride in on ordinary plugins (`contributes.themes`) rather than a
	// CatalogKind of their own, so this shelf is how one is findable in the
	// Plugins tab. The web store's Themes TAB filters on this same value.
	"Themes",
	// Interfaces ride in the same way (`contributes.interfaces`): a data-only
	// pick of a host-owned renderer plus bounded params, never its own
	// CatalogKind. This shelf is how one is findable in the Plugins tab.
	"Interfaces",
	"Media & Voice",
	"Research",
	"Developer Tools",
	"Sandbox",
	"Security",
	"Core",
] as const;

/** The shelf a listing with no `category` falls into. Last among known shelves —
 *  uncategorised is not a feature, and putting it first would make the store's
 *  first impression a pile of miscellany. */
export const UNCATEGORIZED_LABEL = "Everything else";

/** Fold a category string to its comparison key: lowercase, and every run of
 *  non-alphanumerics collapsed to a single space. So "Developer Tools",
 *  "developer-tools" and "Developer  Tools" all key to `developer tools`. */
function categoryKey(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

/** Canonical key → canonical label, built once from {@link STORE_CATEGORY_ORDER}. */
const CANONICAL_BY_KEY = new Map(
	STORE_CATEGORY_ORDER.map((label) => [categoryKey(label), label])
);

/** Canonical key → its index in {@link STORE_CATEGORY_ORDER}. */
const RANK_BY_KEY = new Map(
	STORE_CATEGORY_ORDER.map((label, index) => [categoryKey(label), index])
);

/**
 * Normalize a listing's raw `category` to the label its shelf is titled with.
 *
 * A blank/absent value becomes {@link UNCATEGORIZED_LABEL}. A value that matches a
 * canonical shelf (ignoring case and separators) becomes that shelf's exact label,
 * so the heading reads consistently no matter how the manifest spelled it. Anything
 * else is trimmed and returned verbatim — an unknown category gets its own shelf
 * rather than being folded into "Everything else", because silently merging it
 * would hide the fact that a manifest is using a vocabulary nobody else does.
 */
export function normalizeCategory(raw?: string | null): string {
	const trimmed = raw?.trim();
	if (!trimmed) {
		return UNCATEGORIZED_LABEL;
	}
	return CANONICAL_BY_KEY.get(categoryKey(trimmed)) ?? trimmed;
}

/** Sort rank for a normalized shelf label: known shelves in editorial order, then
 *  unknown ones, then "Everything else" dead last. */
function categoryRank(label: string): number {
	if (label === UNCATEGORIZED_LABEL) {
		return Number.MAX_SAFE_INTEGER;
	}
	return RANK_BY_KEY.get(categoryKey(label)) ?? STORE_CATEGORY_ORDER.length;
}

/** One shelf: its heading and the items filed under it, input order preserved. */
export interface CategorySection<T> {
	items: T[];
	label: string;
}

/**
 * Group `items` into shelves by category, ordered per {@link STORE_CATEGORY_ORDER}.
 *
 * Within a shelf, items keep the order they arrived in — the caller has already
 * sorted/paginated them and regrouping must not reshuffle that. Unknown shelves are
 * sorted alphabetically among themselves so their order is at least stable across
 * fetches rather than dependent on which item happened to load first.
 *
 * `categoryOf` returns the RAW manifest value; normalization happens here so every
 * caller gets the same folding rules.
 */
export function groupByCategory<T>(
	items: readonly T[],
	categoryOf: (item: T) => string | null | undefined
): CategorySection<T>[] {
	const sections = new Map<string, T[]>();
	for (const item of items) {
		const label = normalizeCategory(categoryOf(item));
		const bucket = sections.get(label);
		if (bucket) {
			bucket.push(item);
		} else {
			sections.set(label, [item]);
		}
	}
	return [...sections.entries()]
		.map(([label, sectionItems]) => ({ label, items: sectionItems }))
		.sort((a, b) => {
			const rank = categoryRank(a.label) - categoryRank(b.label);
			return rank === 0 ? a.label.localeCompare(b.label) : rank;
		});
}
