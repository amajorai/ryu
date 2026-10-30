import { useConfirmDialog } from "@ryu/ui/hooks/use-confirm-dialog.tsx";
// apps/desktop/src/components/store/ContributedStoreSection.tsx
//
// The generic renderer for an app-registered Store section
// (`contributes.store_tabs[]`). One component draws every contributed tab from its
// declarative spec — a `source` for the catalog rows, a `groupBy`/`groups` split
// into labelled card rows, a per-tab search, and an `install` action — so shipping a
// marketplace tab is a manifest edit in the owning app, not an edit to this closed
// desktop source. It is the Store-shaped sibling of the sidebar's
// `SidebarSectionSpec` renderer and reuses the same primitives from
// `@ryu/app-host/views`.
//
// Two states this renderer has that no other catalog section has, both consequences
// of store tabs being served for apps that are NOT installed or NOT enabled (see
// `PluginStoreTab`):
//
//   1. The app is absent/off → the catalog behind it is gated by the app's own route
//      gate, so fetching would 403. We render an enable prompt instead, and the
//      button installs + enables the owning app in one go.
//   2. The app was just enabled → the tab re-fetches, no reload.
//
// Chrome is the shared App-Store layout (StoreCatalogLayout + StoreCardGrid +
// StoreCatalogCard), so a contributed tab is visually indistinguishable from Apps,
// Plugins, Models or Skills.

import {
	groupStoreItems,
	renderContributionActionHttp,
	renderTemplate,
	type StoreCatalogItem,
	storeItemHaystack,
	type ViewAction,
} from "@ryu/app-host/views";
import { useLiteralMessages } from "@ryu/i18n/react";
import StoreCatalogLayout from "@ryu/marketplace/catalog/chrome/store-catalog-layout";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { useDebouncedValue } from "@/src/hooks/use-debounced-value.ts";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useContributedStoreCatalog } from "@/src/hooks/useContributedStoreCatalog.ts";
import { apiUrl, requestHeaders, toTarget } from "@/src/lib/api/client.ts";
import { pluginStoreSpec } from "@/src/lib/api/plugin-contribution-specs.ts";
import type { PluginStoreTab } from "@/src/lib/api/plugins.ts";
import { AppOffState } from "./ContributedStoreSection-app-off-state.tsx";
import { CatalogList } from "./ContributedStoreSection-catalog-list.tsx";
import { DetailPanel } from "./ContributedStoreSection-detail-panel.tsx";
import { resultValues } from "./ContributedStoreSection-result-values.ts";
import { TabIcon } from "./ContributedStoreSection-tab-icon.tsx";

const SEARCH_DEBOUNCE_MS = 200;

export default function ContributedStoreSection({
	tab,
	initialQuery = "",
}: {
	initialQuery?: string;
	tab: PluginStoreTab;
}) {
	const tl = useLiteralMessages();
	const { confirm, confirmationDialog } = useConfirmDialog();

	const [query, setQuery] = useState(initialQuery);
	const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [pendingId, setPendingId] = useState<string | null>(null);
	const [errorId, setErrorId] = useState<string | null>(null);
	const [installError, setInstallError] = useState<string | null>(null);
	// Installs performed in this session. A contributed catalog need not report
	// installed-state back (the workflow catalog does not), so this is the floor;
	// `spec.map.installed` layers server truth on top when the app provides it.
	const [installedIds, setInstalledIds] = useState<Set<string>>(new Set());

	const node = useActiveNode();
	const queryClient = useQueryClient();
	const openTab = useTabSelector((state) => state.openTab);
	const spec = useMemo(() => pluginStoreSpec(tab), [tab]);
	const catalog = useContributedStoreCatalog(tab, tab.app_enabled);

	const groups = useMemo(() => {
		if (!spec) {
			return [];
		}
		const q = debouncedQuery.trim().toLowerCase();
		const rows = (catalog.data?.items ?? []).filter(
			(item) => !q || storeItemHaystack(spec, item).includes(q)
		);
		return groupStoreItems(spec, rows);
	}, [spec, catalog.data, debouncedQuery]);

	const selected = useMemo(() => {
		for (const group of groups) {
			const found = group.items.find((i) => i.id === selectedId);
			if (found) {
				return found;
			}
		}
		return null;
	}, [groups, selectedId]);

	// When the catalog reports installed-state itself (`map.installed`), that is the
	// ONLY truth — unioning the session set would be wrong for a single-select
	// catalog like meeting-note styles, where picking a second card must un-mark the
	// first. The session set exists solely for catalogs that report nothing back
	// (the workflow template catalog mints a new workflow and forgets).
	const reportsInstalled = Boolean(spec?.map?.installed);
	const isInstalled = useCallback(
		(item: StoreCatalogItem) =>
			reportsInstalled ? item.installed : installedIds.has(item.id),
		[reportsInstalled, installedIds]
	);

	const runAction = useCallback(
		async (action: ViewAction, item: StoreCatalogItem) => {
			if (!action.http) {
				return;
			}
			// The declarative confirm gate, same as PluginViewPage's: a spec-declared
			// prompt before a destructive action.
			if (action.confirm && !(await confirm(action.confirm))) {
				return;
			}
			const target = toTarget(node);
			const rendered = renderContributionActionHttp(tab, action.http, {
				item: item.raw,
			});
			const resp = await fetch(apiUrl(target, rendered.path), {
				method: rendered.method,
				headers: await requestHeaders(target),
				body:
					rendered.body === undefined
						? undefined
						: JSON.stringify(rendered.body),
			});
			if (!resp.ok) {
				throw new Error(`${rendered.path} failed: ${resp.status}`);
			}
			await queryClient.invalidateQueries({
				queryKey: ["store-tab-catalog", tab.plugin, tab.id],
			});
		},
		[node, queryClient, tab.plugin, tab.id, confirm]
	);

	const handleInstall = useCallback(
		async (item: StoreCatalogItem) => {
			const install = spec?.install;
			if (!install) {
				return;
			}
			setPendingId(item.id);
			setErrorId(null);
			setInstallError(null);
			try {
				const target = toTarget(node);
				const rendered = renderContributionActionHttp(tab, install.http, {
					item: item.raw,
				});
				const resp = await fetch(apiUrl(target, rendered.path), {
					method: rendered.method,
					headers: await requestHeaders(target),
					body:
						rendered.body === undefined
							? undefined
							: JSON.stringify(rendered.body),
				});
				if (!resp.ok) {
					throw new Error(`${rendered.path} failed: ${resp.status}`);
				}
				const payload: unknown = await resp.json().catch(() => ({}));
				setInstalledIds((prev) => new Set(prev).add(item.id));
				toast.success(install.successMessage ?? "Added", {
					description: tl("{title} is ready.", { title: item.title }),
				});
				await queryClient.invalidateQueries({
					queryKey: ["store-tab-catalog", tab.plugin, tab.id],
				});
				// Open what was just created. `targetFrom` names the response key
				// holding its id; `openTarget` is the route template, resolving
				// `{{result.<key>}}` from the response and `{{item.<key>}}` from the row.
				if (install.openTarget) {
					const values = resultValues(payload);
					if (install.targetFrom && values[`result.${install.targetFrom}`]) {
						values["result.id"] = values[`result.${install.targetFrom}`];
					}
					// A CLIENT route, not a Core path — so it goes through the raw
					// template renderer, not `renderActionHttp` (whose `/api/` guard
					// exists to keep the node's credentials pointed at Core and would
					// reject every legitimate route here).
					openTab(
						renderTemplate(
							install.openTarget,
							{ item: item.raw, values },
							{
								uriEncode: true,
							}
						),
						{ title: item.title }
					);
				}
			} catch (e) {
				setErrorId(item.id);
				setInstallError(e instanceof Error ? e.message : String(e));
			} finally {
				setPendingId(null);
			}
		},
		[spec, node, queryClient, tab.plugin, tab.id, openTab, tl]
	);

	if (!tab.app_enabled) {
		return (
			<>
				{confirmationDialog}
				{
					<AppOffState
						onEnabled={() => {
							queryClient.invalidateQueries({
								queryKey: ["plugin-contributions"],
							});
						}}
						tab={tab}
					/>
				}
			</>
		);
	}

	if (!spec?.source) {
		return (
			<Empty className="h-full" inset="dense">
				{confirmationDialog}

				<EmptyHeader>
					<EmptyMedia variant="icon">
						<TabIcon icon={tab.icon} />
					</EmptyMedia>
					<EmptyTitle>{tab.title}</EmptyTitle>
					<EmptyDescription>
						This tab declares no catalog to browse.
					</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button
						onClick={() => openTab("/store", { title: "Store" })}
						size="sm"
						variant="ghost"
					>
						Browse other Store tabs
					</Button>
				</EmptyContent>
			</Empty>
		);
	}

	const total = groups.reduce((n, g) => n + g.items.length, 0);

	return (
		<>
			{confirmationDialog}
			{
				<StoreCatalogLayout
					detail={
						<DetailPanel
							busy={pendingId === selected?.id}
							error={errorId === selected?.id ? installError : null}
							installed={selected ? isInstalled(selected) : false}
							item={selected}
							onInstall={() => {
								if (selected) {
									handleInstall(selected);
								}
							}}
							runAction={(action, item) => {
								runAction(action, item).catch((e) => {
									toast.error(`${action.label} failed`, {
										description: e instanceof Error ? e.message : String(e),
									});
								});
							}}
							tab={tab}
						/>
					}
					detailTitle={selected?.title ?? tab.title}
					hasSelection={selected != null}
					list={
						<CatalogList
							error={
								catalog.error instanceof Error ? catalog.error.message : null
							}
							groups={groups}
							isInstalled={isInstalled}
							loading={catalog.isLoading}
							onClearSearch={() => setQuery("")}
							onInstall={handleInstall}
							onRetry={() => {
								void catalog.refetch();
							}}
							onSelect={setSelectedId}
							pendingId={pendingId}
							selectedId={selectedId}
							spec={spec}
							tab={tab}
							total={total}
						/>
					}
					onCloseDetail={() => setSelectedId(null)}
					search={{
						value: query,
						onChange: setQuery,
						placeholder: spec.searchPlaceholder ?? `Search ${tab.title}…`,
					}}
				/>
			}
		</>
	);
}
