// apps/desktop/src/hooks/useAppsCatalog.ts
//
// Backs the Store "Apps" section. Unlike the model/skill catalogs, an app row
// has three lifecycle states (install / enable / disable), and the registry
// catalog carries only discovery metadata — no installed/enabled flags. So this
// hook fetches BOTH the catalog and the live app records (`/api/apps`, `AppInfo[]`)
// and joins them by `id`: the matched AppInfo is the source of truth for installed/enabled
// state and the grants to confirm at enable time. Mutations (install / enable / disable /
// install-from-URL) revalidate both queries so the buttons update in place.
//
// Catalog browsing is source-aware: Ryu Marketplace (default) shows the merged
// built-in + marketplace + legacy list; federated sources (integrations.sh) use
// server-side search + pagination via `/api/plugins/catalog/browse`.

import {
	keepPreviousData,
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { TOKEN_KEY } from "@/lib/auth-client.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type AddMarketplaceParams,
	addMarketplaceSource,
	type AppInfo,
	type CatalogEntry,
	disableApp,
	enableApp,
	fetchApps,
	fetchPluginCatalogDetail,
	fetchPluginSources,
	installApp,
	installAppFromUrl,
	installPluginFromCatalog,
	PLUGIN_MARKETPLACE_SOURCE_ID,
	type PluginCatalogDetail,
	type PluginCatalogSource,
	searchPluginCatalog,
	selectPluginSource,
} from "@/src/lib/api/plugins.ts";
import { useDebouncedValue } from "./use-debounced-value.ts";
import { useActiveNode } from "./useActiveNode.ts";

/** Read the control-plane session bearer (for paid-plugin entitlement checks).
 *  Absent for anonymous/free installs, which is fine — the server only needs it
 *  for a paid item's license lookup. */
function readBuyerToken(): string | null {
	try {
		return localStorage.getItem(TOKEN_KEY);
	} catch {
		return null;
	}
}

/** A catalog entry joined with its live lifecycle record (if any). */
export interface AppCatalogItem {
	enabled: boolean;
	entry: CatalogEntry;
	/** Grants to confirm at enable time — authoritative from AppInfo, else the
	 *  catalog entry's declared grants for a not-yet-installed app. */
	grants: string[];
	/** Live record from `/api/apps`; null when the app isn't installed. */
	info: AppInfo | null;
	installed: boolean;
}

export interface UseAppsCatalogResult {
	activeSource: string;
	/** Whether a marketplace add is in flight. */
	addingMarketplace: boolean;
	/** Add a custom Claude plugin marketplace as a plugin source. */
	addMarketplace: (params: AddMarketplaceParams) => Promise<void>;
	detail: PluginCatalogDetail | null;
	detailError: string | null;
	detailLoading: boolean;
	error: string | null;
	fetchNextPage: () => void;
	hasNextPage: boolean;
	install: () => Promise<void>;
	installFromUrl: (url: string) => Promise<void>;
	installing: boolean;
	items: AppCatalogItem[];
	/** Enable/disable currently running for the selected app. */
	lifecyclePending: boolean;
	loading: boolean;
	loadingMore: boolean;
	query: string;
	select: (id: string) => void;
	selectedId: string | null;
	selectedItem: AppCatalogItem | null;
	selectingSource: boolean;
	selectSource: (id: string) => void;
	setEnabled: (enabled: boolean) => Promise<void>;
	setQuery: (q: string) => void;
	sources: PluginCatalogSource[];
}

const SEARCH_DEBOUNCE_MS = 300;
const PAGE_LIMIT = 40;

/** Stub catalog source — no real feed behind it yet. */
const HIDDEN_PLUGIN_SOURCES = new Set(["ryu-apps"]);

export function useAppsCatalog(initialQuery = ""): UseAppsCatalogResult {
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

	const sourcesQuery = useQuery({
		queryKey: ["plugins", "sources", url],
		queryFn: () => fetchPluginSources({ url, token }),
	});
	const activeSource = sourcesQuery.data?.active ?? "";
	const sources = useMemo(
		() =>
			(sourcesQuery.data?.sources ?? []).filter(
				(s) => !HIDDEN_PLUGIN_SOURCES.has(s.id)
			),
		[sourcesQuery.data?.sources]
	);

	const selectSourceMutation = useMutation({
		mutationFn: (id: string) => selectPluginSource({ url, token }, id),
		onSuccess: () => {
			Promise.resolve(
				qc.invalidateQueries({ queryKey: ["plugins", "sources", url] })
			).catch(() => undefined);
			Promise.resolve(
				qc.invalidateQueries({ queryKey: ["plugins", "catalog", url] })
			).catch(() => undefined);
			Promise.resolve(
				qc.invalidateQueries({ queryKey: ["plugins", "detail", url] })
			).catch(() => undefined);
		},
	});
	const selectSource = useCallback(
		(id: string) => selectSourceMutation.mutate(id),
		[selectSourceMutation]
	);

	const addMarketplaceMutation = useMutation({
		mutationFn: (params: AddMarketplaceParams) =>
			addMarketplaceSource({ url, token }, params),
		onSuccess: () => {
			Promise.resolve(
				qc.invalidateQueries({ queryKey: ["plugins", "sources", url] })
			).catch(() => undefined);
		},
	});
	const addMarketplace = useCallback(
		(params: AddMarketplaceParams) =>
			addMarketplaceMutation.mutateAsync(params),
		[addMarketplaceMutation]
	);

	const appsQuery = useQuery({
		queryKey: ["apps", "list", url],
		queryFn: () => fetchApps({ url, token }),
	});

	const listQuery = useInfiniteQuery({
		queryKey: [
			"plugins",
			"catalog",
			url,
			{ q: debouncedQuery, source: activeSource },
		],
		queryFn: ({ pageParam }) =>
			searchPluginCatalog(
				{ url, token },
				{ query: debouncedQuery, limit: PAGE_LIMIT, cursor: pageParam }
			),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (last) => last.nextCursor ?? undefined,
		placeholderData: keepPreviousData,
		enabled: activeSource.length > 0,
	});

	const catalogEntries = useMemo(
		() => listQuery.data?.pages.flatMap((p) => p.entries) ?? [],
		[listQuery.data]
	);

	const items = useMemo<AppCatalogItem[]>(() => {
		const infos = appsQuery.data ?? [];
		const byId = new Map(infos.map((a) => [a.id, a]));
		return catalogEntries.map((entry) => {
			const info = byId.get(entry.id) ?? null;
			return {
				entry,
				info,
				installed: info?.installed ?? false,
				enabled: info?.enabled ?? false,
				grants: info?.permissionGrants ?? entry.permission_grants ?? [],
			};
		});
	}, [catalogEntries, appsQuery.data]);

	const selectedItem = useMemo(
		() => items.find((it) => it.entry.id === selectedId) ?? null,
		[items, selectedId]
	);

	const isDescriptorSource =
		activeSource !== "" && activeSource !== PLUGIN_MARKETPLACE_SOURCE_ID;

	const detailQuery = useQuery({
		queryKey: ["plugins", "detail", url, selectedId, activeSource],
		queryFn: () =>
			fetchPluginCatalogDetail({ url, token }, selectedId as string),
		enabled: selectedId !== null && isDescriptorSource,
	});

	const revalidate = useCallback(
		() =>
			Promise.all([
				qc.invalidateQueries({ queryKey: ["apps", "list", url] }),
				qc.invalidateQueries({ queryKey: ["plugins", "catalog", url] }),
				// A plugin's enabled state drives its declarative contributions
				// (companion routes + slash commands). Invalidate so enabling/disabling
				// from the Store adds/removes its /plugin/<id> route + palette command
				// WITHOUT a reload — the composer/palette query key is prefix-matched.
				qc.invalidateQueries({ queryKey: ["plugin-contributions"] }),
			]),
		[qc, url]
	);

	const installMutation = useMutation({
		mutationFn: async (item: AppCatalogItem): Promise<void> => {
			if (item.entry.descriptor_only) {
				throw new Error(
					"Integration descriptors are browse-only — open the link to configure."
				);
			}
			if (!item.installed && item.entry.source !== "built-in") {
				await installPluginFromCatalog(
					{ url, token },
					item.entry.id,
					readBuyerToken()
				);
				return;
			}
			await installApp({ url, token }, item.entry.id);
		},
		onSettled: revalidate,
	});

	const installUrlMutation = useMutation({
		mutationFn: (appUrl: string) => installAppFromUrl({ url, token }, appUrl),
		onSettled: revalidate,
	});

	const lifecycleMutation = useMutation({
		mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
			enabled ? enableApp({ url, token }, id) : disableApp({ url, token }, id),
		onSettled: revalidate,
	});

	const select = useCallback((id: string) => setSelectedId(id), []);

	const install = useCallback(async () => {
		const item = items.find((it) => it.entry.id === selectedId);
		if (!item) {
			return;
		}
		await installMutation.mutateAsync(item);
	}, [items, selectedId, installMutation]);

	const setEnabled = useCallback(
		async (enabled: boolean) => {
			if (!selectedId) {
				return;
			}
			await lifecycleMutation.mutateAsync({ id: selectedId, enabled });
		},
		[selectedId, lifecycleMutation]
	);

	const installFromUrl = useCallback(
		async (appUrl: string) => {
			await installUrlMutation.mutateAsync(appUrl);
		},
		[installUrlMutation]
	);

	const errorOf = (e: unknown): string | null =>
		e instanceof Error ? e.message : null;
	const loadError = errorOf(listQuery.error) ?? errorOf(appsQuery.error);
	const browseNote = listQuery.data?.pages.find((p) => p.note)?.note ?? null;
	const actionError =
		errorOf(lifecycleMutation.error) ??
		errorOf(installUrlMutation.error) ??
		errorOf(installMutation.error);

	return {
		items,
		loading: listQuery.isLoading || appsQuery.isLoading,
		error: actionError ?? browseNote ?? loadError,
		fetchNextPage: listQuery.fetchNextPage,
		hasNextPage: listQuery.hasNextPage,
		loadingMore: listQuery.isFetchingNextPage,
		query,
		setQuery,
		selectedId,
		select,
		selectedItem,
		detail: detailQuery.data ?? null,
		detailLoading: detailQuery.isLoading && selectedId !== null,
		detailError:
			detailQuery.error instanceof Error ? detailQuery.error.message : null,
		install,
		installing: installMutation.isPending,
		setEnabled,
		lifecyclePending: lifecycleMutation.isPending,
		installFromUrl,
		sources,
		activeSource,
		selectSource,
		selectingSource: selectSourceMutation.isPending,
		addMarketplace,
		addingMarketplace: addMarketplaceMutation.isPending,
	};
}
