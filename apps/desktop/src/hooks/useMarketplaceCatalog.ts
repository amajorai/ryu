// apps/desktop/src/hooks/useMarketplaceCatalog.ts
//
// Browses the Ryu Marketplace catalog WITH pricing from the control-plane server
// (lib/api/marketplace.ts -> :3000). This is the only desktop surface that sees
// per-item pricing — the Core catalog adapter strips it — so the Buy / price
// affordances key off this list. Plain state + debounced query, mirroring the
// other :3000-targeted hooks (outside the node-scoped TanStack cache).
//
// The catalog is cursor-paginated: the first page loads with the query, and
// `loadMore` appends the next page while `hasMore` is true. A new kind or query
// starts over at page one and abandons any in-flight page.

import { useCallback, useEffect, useRef, useState } from "react";
import {
	fetchCatalogPage,
	type MarketplaceCard,
	MarketplaceError,
	type MarketplaceKind,
} from "@/src/lib/api/marketplace.ts";

const DEBOUNCE_MS = 300;

interface UseMarketplaceCatalog {
	error: MarketplaceError | null;
	/** True while another page can be loaded with {@link loadMore}. */
	hasMore: boolean;
	items: MarketplaceCard[];
	kind: MarketplaceKind;
	loading: boolean;
	loadingMore: boolean;
	/** Append the next page; a no-op while loading or on the last page. */
	loadMore: () => Promise<void>;
	query: string;
	refresh: () => Promise<void>;
	setKind: (kind: MarketplaceKind) => void;
	setQuery: (query: string) => void;
}

/** Append a page, keeping the first occurrence of each item. */
function appendUnique(
	current: MarketplaceCard[],
	next: MarketplaceCard[]
): MarketplaceCard[] {
	const seen = new Set(current.map((card) => `${card.kind}:${card.id}`));
	const merged = [...current];
	for (const card of next) {
		const key = `${card.kind}:${card.id}`;
		if (!seen.has(key)) {
			seen.add(key);
			merged.push(card);
		}
	}
	return merged;
}

export function useMarketplaceCatalog(
	initialKind: MarketplaceKind = "skill",
	initialQuery = ""
): UseMarketplaceCatalog {
	const [kind, setKind] = useState<MarketplaceKind>(initialKind);
	const [query, setQuery] = useState(initialQuery);
	const [debouncedQuery, setDebouncedQuery] = useState(initialQuery);
	const [items, setItems] = useState<MarketplaceCard[]>([]);
	const [nextCursor, setNextCursor] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [loadingMore, setLoadingMore] = useState(false);
	const [error, setError] = useState<MarketplaceError | null>(null);
	const activeRequestRef = useRef<AbortController | null>(null);

	useEffect(() => {
		const id = setTimeout(() => setDebouncedQuery(query), DEBOUNCE_MS);
		return () => clearTimeout(id);
	}, [query]);

	const load = useCallback(async () => {
		activeRequestRef.current?.abort();
		const controller = new AbortController();
		activeRequestRef.current = controller;
		setLoading(true);
		setLoadingMore(false);
		try {
			const page = await fetchCatalogPage(kind, debouncedQuery, {
				signal: controller.signal,
			});
			if (controller.signal.aborted) {
				return;
			}
			setItems(page.items);
			setNextCursor(page.nextCursor);
			setError(null);
		} catch (e) {
			if (controller.signal.aborted) {
				return;
			}
			setItems([]);
			setNextCursor(null);
			setError(
				e instanceof MarketplaceError
					? e
					: new MarketplaceError(
							"unknown",
							e instanceof Error
								? e.message
								: "Could not load the marketplace catalog."
						)
			);
		} finally {
			if (activeRequestRef.current === controller) {
				activeRequestRef.current = null;
				setLoading(false);
			}
		}
	}, [kind, debouncedQuery]);

	const loadMore = useCallback(async () => {
		if (!nextCursor || activeRequestRef.current) {
			return;
		}
		const controller = new AbortController();
		activeRequestRef.current = controller;
		setLoadingMore(true);
		try {
			const page = await fetchCatalogPage(kind, debouncedQuery, {
				cursor: nextCursor,
				signal: controller.signal,
			});
			if (controller.signal.aborted) {
				return;
			}
			setItems((current) => appendUnique(current, page.items));
			setNextCursor(page.nextCursor);
		} catch {
			// A failed next page keeps what is already shown; the control stays
			// available so the user can retry.
		} finally {
			if (activeRequestRef.current === controller) {
				activeRequestRef.current = null;
				setLoadingMore(false);
			}
		}
	}, [kind, debouncedQuery, nextCursor]);

	useEffect(() => {
		load().catch(() => undefined);
		return () => {
			activeRequestRef.current?.abort();
			activeRequestRef.current = null;
		};
	}, [load]);

	const refresh = useCallback(() => load(), [load]);

	return {
		kind,
		setKind,
		query,
		setQuery,
		items,
		hasMore: nextCursor !== null,
		loadMore,
		loading,
		loadingMore,
		error,
		refresh,
	};
}
