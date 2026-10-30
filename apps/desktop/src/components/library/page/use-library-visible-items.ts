import { useMemo } from "react";
import type { LibraryItemType } from "@/src/lib/library.ts";
import {
	CUSTOM_SURFACE_SECTIONS,
	isItemType,
	type LibraryItem,
	type LibrarySection,
} from "./library-sections.ts";

/** The active tab's visible rows: its collection (or every collection while a
 *  search is running), narrowed by the type filter and query, then sorted. */
export function useLibraryVisibleItems({
	anySourceLoading,
	favoriteItems,
	itemsByType,
	loadingByType,
	query,
	recentItems,
	section,
	sort,
	typeFilter,
}: {
	anySourceLoading: boolean;
	favoriteItems: LibraryItem[];
	itemsByType: Record<LibraryItemType, LibraryItem[]>;
	loadingByType: Record<LibraryItemType, boolean>;
	query: string;
	recentItems: LibraryItem[];
	section: LibrarySection;
	sort: string;
	typeFilter: LibraryItemType | null;
}) {
	const isMixed = section === "recents" || section === "favorites";
	// Everything in the library, flattened — the corpus the global search runs
	// over. Built from the same per-type lists the tabs render, so a search result
	// and the row you would have found by hand are the same object.
	const allItems = useMemo(
		() => Object.values(itemsByType).flat(),
		[itemsByType]
	);
	let baseItems: LibraryItem[];
	if (section === "recents") {
		baseItems = recentItems;
	} else if (section === "favorites") {
		baseItems = favoriteItems;
	} else if (isItemType(section)) {
		baseItems = itemsByType[section];
	} else {
		// A custom-surface section (Tools) has no LibraryItem representation — it
		// renders its own surface and never reaches the card grid, so the collection
		// pipeline below runs over an empty list rather than being skipped (keeping
		// every hook below unconditional).
		baseItems = [];
	}

	const loading = isMixed
		? anySourceLoading && baseItems.length === 0
		: // A custom-surface section owns its own loading state.
			isItemType(section) && loadingByType[section];

	// A query in the shell's field takes over the page: it searches every
	// collection, so the result list is mixed no matter which tab is open (and the
	// type chips become the way to narrow it back down). A custom surface (Tools)
	// owns its own search and is left alone.
	const searchingAll =
		query.trim().length > 0 && !CUSTOM_SURFACE_SECTIONS.has(section);
	const mixedView = isMixed || searchingAll;

	const visibleItems = useMemo(() => {
		// A non-empty query searches the WHOLE library, not the open collection.
		// The field lives above the tab strip now, and a search box that sits above
		// the thing that scopes it has to mean "everything" — scoping it to the tab
		// underneath is the one reading the position rules out. It is also the
		// answer to the actual question: you look for a thing in the library, not
		// for a thing in the tab you happen to be standing on.
		let list = searchingAll ? allItems : baseItems;
		if (mixedView && typeFilter) {
			list = list.filter((i) => i.type === typeFilter);
		}
		const q = query.trim().toLowerCase();
		if (q) {
			list = list.filter(
				(i) =>
					i.name.toLowerCase().includes(q) ||
					(i.subtitle?.toLowerCase().includes(q) ?? false)
			);
		}
		// Recents keep their intrinsic (most-recent-first) order; the typed and
		// favorites tabs honour the sort control.
		if (section === "recents") {
			return list;
		}
		const sorted = [...list];
		if (sort === "name-asc") {
			sorted.sort((a, b) => a.name.localeCompare(b.name));
		} else if (sort === "name-desc") {
			sorted.sort((a, b) => b.name.localeCompare(a.name));
		} else {
			sorted.sort((a, b) => b.updatedAt - a.updatedAt);
		}
		return sorted;
	}, [
		allItems,
		baseItems,
		mixedView,
		searchingAll,
		typeFilter,
		query,
		sort,
		section,
	]);

	// Which types actually appear in a mixed tab, so we only offer real chips.
	const presentTypes = useMemo(() => {
		const set = new Set<LibraryItemType>();
		for (const i of searchingAll ? allItems : baseItems) {
			set.add(i.type);
		}
		return set;
	}, [allItems, baseItems, searchingAll]);

	return { loading, mixedView, presentTypes, visibleItems };
}
