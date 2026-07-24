// apps/desktop/src/hooks/useIntegrationsCatalog.ts
//
// Backs the Integrations Store tab. Same TanStack Query shape as the other
// catalogs: the brand list paginates server-side via Core's offset `next_cursor`
// (useInfiniteQuery), the search box is debounced, and Core owns every filter
// decision. There is no install/enable here — a brand is a front door, not an
// installable unit; lifecycle lives in the related Skills/MCP/Plugins a brand
// points at.

import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type IntegrationBrand,
	searchIntegrations,
} from "@/src/lib/api/integrations.ts";
import { useDebouncedValue } from "./use-debounced-value.ts";
import { useActiveNode } from "./useActiveNode.ts";

export interface UseIntegrationsCatalogResult {
	error: string | null;
	fetchNextPage: () => void;
	hasNextPage: boolean;
	integrations: IntegrationBrand[];
	loading: boolean;
	loadingMore: boolean;
	query: string;
	setQuery: (q: string) => void;
	/** Total matches across all pages (from Core), for a result count. */
	total: number;
}

const SEARCH_DEBOUNCE_MS = 300;
const PAGE_LIMIT = 60;

export function useIntegrationsCatalog(
	initialQuery = ""
): UseIntegrationsCatalogResult {
	const activeNode = useActiveNode();
	const target: ApiTarget = {
		url: activeNode.url,
		token: activeNode.token ?? null,
	};
	const { url, token } = target;

	const [query, setQuery] = useState(initialQuery);
	const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);

	const listQuery = useInfiniteQuery({
		queryKey: ["integrations", "list", url, { q: debouncedQuery }],
		queryFn: ({ pageParam }) =>
			searchIntegrations(
				{ url, token },
				{ query: debouncedQuery, limit: PAGE_LIMIT, cursor: pageParam }
			),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (last) => last.nextCursor ?? undefined,
		placeholderData: keepPreviousData,
	});

	const integrations = useMemo(
		() => listQuery.data?.pages.flatMap((p) => p.integrations) ?? [],
		[listQuery.data]
	);
	const total = listQuery.data?.pages.at(-1)?.total ?? integrations.length;

	return {
		integrations,
		loading: listQuery.isLoading,
		error: listQuery.error instanceof Error ? listQuery.error.message : null,
		fetchNextPage: listQuery.fetchNextPage,
		hasNextPage: listQuery.hasNextPage,
		loadingMore: listQuery.isFetchingNextPage,
		query,
		setQuery,
		total,
	};
}
