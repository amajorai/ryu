// apps/desktop/src/hooks/useMcpCatalog.ts
//
// Backs the MCP Catalog Store section. Same TanStack Query shape as the model
// catalog: the list paginates server-side via the source's `next_cursor`
// (useInfiniteQuery), the detail is cached per server id, and install runs as a
// mutation. Every data decision lives in Core EXCEPT installed-state, which the
// catalog payload can't carry (the registry has no per-user view, so Core
// hardcodes `installed: false`). The hook derives it client-side by
// cross-referencing the registered set from `fetchMcpServers`: a card is
// installed iff its id is among the registered MCP server names (the install
// writes the entry under the trimmed catalog id, slashes preserved).

import {
	keepPreviousData,
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	fetchMcpCatalogDetail,
	fetchMcpServers,
	fetchMcpSources,
	installMcpServer,
	type McpCatalogCard,
	type McpCatalogDetail,
	type McpCatalogSource,
	searchMcpCatalog,
	selectMcpSource,
} from "@/src/lib/api/mcp.ts";
import { useDebouncedValue } from "./use-debounced-value.ts";
import { useActiveNode } from "./useActiveNode.ts";

export interface UseMcpCatalogResult {
	/** Id of the active catalog source (the official MCP registry by default). */
	activeSource: string;
	detail: McpCatalogDetail | null;
	detailError: string | null;
	detailLoading: boolean;
	error: string | null;
	/** Load the next page of results (infinite scroll). */
	fetchNextPage: () => void;
	/** Whether more pages are available from the source. */
	hasNextPage: boolean;
	install: () => Promise<void>;
	/** Id of the server currently installing, or null. */
	installing: string | null;
	loading: boolean;
	/** Whether the next page is currently loading. */
	loadingMore: boolean;
	query: string;
	select: (id: string) => void;
	selectedId: string | null;
	/** Whether a source switch is in flight. */
	selectingSource: boolean;
	/** Switch the active catalog source, then refetch the server list. */
	selectSource: (id: string) => void;
	servers: McpCatalogCard[];
	setQuery: (q: string) => void;
	/** Every source available for the MCP kind. */
	sources: McpCatalogSource[];
}

const SEARCH_DEBOUNCE_MS = 300;
const PAGE_LIMIT = 40;

export function useMcpCatalog(initialQuery = ""): UseMcpCatalogResult {
	const activeNode = useActiveNode();
	const target: ApiTarget = {
		url: activeNode.url,
		token: activeNode.token ?? null,
	};
	const { url, token } = target;
	const qc = useQueryClient();

	const [query, setQuery] = useState(initialQuery);
	const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
	const [selectedId, setSelectedId] = useState<string | null>(null);

	// Catalog sources: list + active selection live in Core. Selecting a source
	// switches Core's active endpoint, so every list/detail must refetch.
	const sourcesQuery = useQuery({
		queryKey: ["mcp", "sources", url],
		queryFn: () => fetchMcpSources({ url, token }),
	});
	const activeSource = sourcesQuery.data?.active ?? "";

	const selectSourceMutation = useMutation({
		mutationFn: (id: string) => selectMcpSource({ url, token }, id),
		onSuccess: () => {
			Promise.resolve(
				qc.invalidateQueries({ queryKey: ["mcp", "sources", url] })
			).catch(() => undefined);
			Promise.resolve(
				qc.invalidateQueries({ queryKey: ["mcp", "list", url] })
			).catch(() => undefined);
			Promise.resolve(
				qc.invalidateQueries({ queryKey: ["mcp", "detail", url] })
			).catch(() => undefined);
		},
	});
	const selectSource = useCallback(
		(id: string) => selectSourceMutation.mutate(id),
		[selectSourceMutation]
	);

	// Registered MCP servers — the authoritative installed-state signal. A card
	// is installed iff its id is among these names. Re-fetched after install.
	const serversQuery = useQuery({
		queryKey: ["mcp", "servers", url],
		queryFn: () => fetchMcpServers({ url, token }),
	});
	const installedNames = useMemo(
		() => new Set((serversQuery.data ?? []).map((s) => s.name)),
		[serversQuery.data]
	);

	const listQuery = useInfiniteQuery({
		queryKey: ["mcp", "list", url, { q: debouncedQuery, source: activeSource }],
		queryFn: ({ pageParam }) =>
			searchMcpCatalog(
				{ url, token },
				{ query: debouncedQuery, limit: PAGE_LIMIT, cursor: pageParam }
			),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (last) => last.nextCursor ?? undefined,
		placeholderData: keepPreviousData,
	});

	// Flatten every loaded page, then fold in derived installed-state.
	const servers = useMemo(() => {
		const flat = listQuery.data?.pages.flatMap((p) => p.servers) ?? [];
		return flat.map((s) => ({ ...s, installed: installedNames.has(s.id) }));
	}, [listQuery.data, installedNames]);

	const detailQuery = useQuery({
		queryKey: ["mcp", "detail", url, selectedId],
		queryFn: () => fetchMcpCatalogDetail({ url, token }, selectedId as string),
		enabled: selectedId !== null,
	});

	// Fold derived installed-state into the detail card too (Core sends false).
	const detail = useMemo((): McpCatalogDetail | null => {
		const d = detailQuery.data;
		if (!d) {
			return null;
		}
		return {
			...d,
			card: { ...d.card, installed: installedNames.has(d.card.id) },
		};
	}, [detailQuery.data, installedNames]);

	const installMutation = useMutation({
		mutationFn: () => installMcpServer({ url, token }, selectedId as string),
		onSettled: () => {
			// Installed-state is derived from the registered servers list, so the
			// authoritative refresh is re-fetching that — the list/detail then
			// re-fold the new installed set on next render.
			Promise.resolve(
				qc.invalidateQueries({ queryKey: ["mcp", "servers", url] })
			).catch(() => undefined);
		},
	});

	const select = useCallback((id: string) => setSelectedId(id), []);

	const install = useCallback(async () => {
		if (!selectedId) {
			return;
		}
		await installMutation.mutateAsync();
	}, [selectedId, installMutation]);

	return {
		servers,
		loading: listQuery.isLoading,
		error: listQuery.error instanceof Error ? listQuery.error.message : null,
		fetchNextPage: listQuery.fetchNextPage,
		hasNextPage: listQuery.hasNextPage,
		loadingMore: listQuery.isFetchingNextPage,
		query,
		setQuery,
		selectedId,
		select,
		detail,
		detailLoading: detailQuery.isLoading && selectedId !== null,
		detailError:
			detailQuery.error instanceof Error ? detailQuery.error.message : null,
		installing: installMutation.isPending ? selectedId : null,
		install,
		sources: sourcesQuery.data?.sources ?? [],
		activeSource,
		selectSource,
		selectingSource: selectSourceMutation.isPending,
	};
}
