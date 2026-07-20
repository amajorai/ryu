// apps/desktop/src/hooks/useMarketplaceCatalog.ts
//
// Browses the Ryu Marketplace catalog WITH pricing from the control-plane server
// (lib/api/marketplace.ts -> :3000). This is the only desktop surface that sees
// per-item pricing — the Core catalog adapter strips it — so the Buy / price
// affordances key off this list. Plain state + debounced query, mirroring the
// other :3000-targeted hooks (outside the node-scoped TanStack cache).

import { useCallback, useEffect, useState } from "react";
import {
	fetchCatalog,
	type MarketplaceCard,
	type MarketplaceError,
	type MarketplaceKind,
} from "@/src/lib/api/marketplace.ts";

const DEBOUNCE_MS = 300;

interface UseMarketplaceCatalog {
	error: MarketplaceError | null;
	items: MarketplaceCard[];
	kind: MarketplaceKind;
	loading: boolean;
	query: string;
	refresh: () => Promise<void>;
	setKind: (kind: MarketplaceKind) => void;
	setQuery: (query: string) => void;
}

export function useMarketplaceCatalog(
	initialKind: MarketplaceKind = "skill"
): UseMarketplaceCatalog {
	const [kind, setKind] = useState<MarketplaceKind>(initialKind);
	const [query, setQuery] = useState("");
	const [debouncedQuery, setDebouncedQuery] = useState("");
	const [items, setItems] = useState<MarketplaceCard[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<MarketplaceError | null>(null);

	useEffect(() => {
		const id = setTimeout(() => setDebouncedQuery(query), DEBOUNCE_MS);
		return () => clearTimeout(id);
	}, [query]);

	const load = useCallback(async () => {
		setLoading(true);
		try {
			const data = await fetchCatalog(kind, debouncedQuery);
			setItems(data);
			setError(null);
		} catch (e) {
			setItems([]);
			setError(e as MarketplaceError);
		} finally {
			setLoading(false);
		}
	}, [kind, debouncedQuery]);

	useEffect(() => {
		load().catch(() => undefined);
	}, [load]);

	return {
		kind,
		setKind,
		query,
		setQuery,
		items,
		loading,
		error,
		refresh: load,
	};
}
