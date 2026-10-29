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
	skipToken,
	type UseQueryOptions,
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
	retryList: () => Promise<void>;
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

// Query descriptors shared with the Store's warm-up path (`useStorePrefetch`), so
// a prefetch always lands under the key this hook reads. See the same block in
// `useSkillsCatalog.ts`.

export function mcpSourcesQuery(target: ApiTarget) {
	return {
		queryKey: ["mcp", "sources", target.url],
		queryFn: () => fetchMcpSources(target),
	};
}

export function mcpServersQuery(target: ApiTarget) {
	return {
		queryKey: ["mcp", "servers", target.url],
		queryFn: () => fetchMcpServers(target),
	};
}

export function mcpListQuery(
	target: ApiTarget,
	params: { query: string; source: string }
) {
	return {
		queryKey: [
			"mcp",
			"list",
			target.url,
			{ q: params.query, source: params.source },
		],
		queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
			searchMcpCatalog(target, {
				query: params.query,
				limit: PAGE_LIMIT,
				cursor: pageParam,
			}),
		// SAFETY: The initial cursor is the authored undefined literal, already a member of this query's string | undefined pageParam port. This widening seeds the same complete cursor type used by queryFn/getNextPageParam; it makes no claim about decoded HTTP data.
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (last: { nextCursor?: string | null }) =>
			last.nextCursor ?? undefined,
	};
}

export function useMcpCatalog(initialQuery = ""): UseMcpCatalogResult {
	const activeNode = useActiveNode();
	const target = useMemo<ApiTarget>(
		() => ({
			url: activeNode.url,
			token: activeNode.token ?? null,
			userJwt: activeNode.userJwt ?? null,
		}),
		[activeNode.url, activeNode.token, activeNode.userJwt]
	);
	const { url, token, userJwt } = target;
	const qc = useQueryClient();

	const [query, setQuery] = useState(initialQuery);
	const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
	const [selectedId, setSelectedId] = useState<string | null>(null);

	// Catalog sources: list + active selection live in Core. Selecting a source
	// switches Core's active endpoint, so every list/detail must refetch.
	const sourcesQuery = useQuery(
		useMemo(() => mcpSourcesQuery(target), [target])
	);
	const activeSource = sourcesQuery.data?.active ?? "";

	const selectSourceMutation = useMutation({
		mutationFn: (id: string) => selectMcpSource({ url, token, userJwt }, id),
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
	const serversQuery = useQuery(
		useMemo(() => mcpServersQuery(target), [target])
	);
	const installedNames = useMemo(
		() => new Set((serversQuery.data ?? []).map((s) => s.name)),
		[serversQuery.data]
	);

	const listQuery = useInfiniteQuery(
		useMemo(
			() => ({
				...mcpListQuery(target, {
					query: debouncedQuery,
					source: activeSource,
				}),
				placeholderData: keepPreviousData,
			}),
			[target, debouncedQuery, activeSource]
		)
	);

	// Flatten every loaded page, then fold in derived installed-state.
	const servers = useMemo(() => {
		const flat = listQuery.data?.pages.flatMap((p) => p.servers) ?? [];
		return flat.map((s) => ({ ...s, installed: installedNames.has(s.id) }));
	}, [listQuery.data, installedNames]);

	const detailQuery = useQuery(
		useMemo(
			() =>
				({
					queryKey: ["mcp", "detail", url, selectedId],
					queryFn:
						selectedId === null || selectedId === undefined
							? skipToken
							: () => fetchMcpCatalogDetail(target, selectedId),
					enabled: selectedId !== null,
				}) satisfies UseQueryOptions<
					Awaited<ReturnType<typeof fetchMcpCatalogDetail>>
				>,
			[target, url, selectedId]
		)
	);

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
		mutationFn: () => {
			if (selectedId === null || selectedId === undefined) {
				throw new Error("Select an MCP server before installing it.");
			}
			return installMcpServer({ url, token, userJwt }, selectedId);
		},
		onSettled: () => {
			// Installed-state is derived from the registered servers list, so the
			// authoritative refresh is re-fetching that — the list/detail then
			// re-fold the new installed set on next render.
			Promise.resolve(
				qc.invalidateQueries({ queryKey: ["mcp", "servers", url] })
			).catch(() => undefined);
		},
	});

	// `select("")` is how the layout closes the preview — normalise it to null so
	// the detail query stays disabled instead of fetching an empty id.
	const select = useCallback((id: string) => setSelectedId(id || null), []);
	const retryList = useCallback(async () => {
		await listQuery.refetch();
	}, [listQuery.refetch]);

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
		retryList,
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
