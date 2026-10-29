import { type ViewSourceRow, viewSourceRowSchema } from "@ryu/app-host/views";
import { useConfirmDialog } from "@ryu/ui/hooks/use-confirm-dialog.tsx";
import { z } from "zod";
import { pluginStoreSpec } from "@/src/lib/api/plugin-contribution-specs.ts";
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
	Alert01Icon,
	CheckmarkCircle02Icon,
	Download01Icon,
	Link01Icon,
	Package01Icon,
	Settings01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	contributionSourceRequest,
	groupStoreItems,
	renderContributionActionHttp,
	renderTemplate,
	type StoreCatalogItem,
	type StoreTabSpec,
	storeDetailObject,
	storeGraphFromResponse,
	storeItemHaystack,
	type ViewAction,
} from "@ryu/app-host/views";
import { InstallProgressButton } from "@ryu/blocks/desktop/install-button.tsx";
import StoreCatalogCard from "@ryu/marketplace/catalog/chrome/store-catalog-card";
import StoreCatalogLayout, {
	StoreCardGrid,
} from "@ryu/marketplace/catalog/chrome/store-catalog-layout";
import StoreItemAction, {
	storeItemContextMenu,
} from "@ryu/marketplace/catalog/chrome/store-item-action";
import {
	ListingAsideCard,
	ListingDetailShell,
	ListingHero,
	ListingSection,
	ListingStatStrip,
} from "@ryu/marketplace/catalog/detail/listing-detail-shell";
import { safeHttpUrl } from "@ryu/marketplace/catalog/safe-url";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { Icon } from "@ryu/ui/components/icon.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { useDebouncedValue } from "@/src/hooks/use-debounced-value.ts";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useApps } from "@/src/hooks/useApps.ts";
import { useContributedStoreCatalog } from "@/src/hooks/useContributedStoreCatalog.ts";
import { usePluginSettingsOpener } from "@/src/hooks/usePluginSettingsOpener.ts";
import { apiUrl, requestHeaders, toTarget } from "@/src/lib/api/client.ts";
import type { PluginStoreTab } from "@/src/lib/api/plugins.ts";
import StoreDetailGraph from "./StoreDetailGraph.tsx";

const SEARCH_DEBOUNCE_MS = 200;

/** Fallback glyph when neither the tab nor the row declares one. */
const FALLBACK_ICON = Package01Icon;

function TabIcon({ icon, className }: { className?: string; icon?: string }) {
	if (icon) {
		return <Icon className={className} icon={icon} size={20} />;
	}
	return <HugeiconsIcon className={className} icon={FALLBACK_ICON} />;
}

/**
 * The prompt shown when a contributed tab's owning app is not installed, or is
 * installed but disabled. The tab itself is always listed (that is the point — this
 * is where the app gets installed from), but its catalog lives behind the app's own
 * route gate, so there is nothing to fetch until the app is on.
 */
function AppOffState({
	tab,
	onEnabled,
}: {
	onEnabled: () => void;
	tab: PluginStoreTab;
}) {
	const { install, toggle } = useApps();
	const [busy, setBusy] = useState(false);
	// An installed-but-disabled app can be configured before it is turned on — that
	// is often the point (paste the key, then enable). Absent for an app that isn't
	// installed yet: there is nothing on this node to configure.
	const openSettings = usePluginSettingsOpener()(tab.plugin);

	const handleEnable = async () => {
		setBusy(true);
		try {
			if (!tab.app_installed) {
				await install(tab.plugin);
			}
			const outcome = await toggle(tab.plugin, true);
			if (!outcome.success) {
				throw new Error(outcome.error);
			}
			toast.success(`${tab.title} is ready`);
			onEnabled();
		} catch (e) {
			toast.error("Couldn't enable the app", {
				description: e instanceof Error ? e.message : String(e),
			});
		} finally {
			setBusy(false);
		}
	};

	return (
		<Empty className="h-full" inset="dense">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<TabIcon icon={tab.icon} />
				</EmptyMedia>
				<EmptyTitle>Turn on {tab.title}</EmptyTitle>
				<EmptyDescription>
					{tab.subtitle ??
						"This catalog is provided by an app that isn't running yet."}
				</EmptyDescription>
			</EmptyHeader>
			<div className="flex items-center gap-2">
				<InstallProgressButton installing={busy} onClick={handleEnable}>
					<HugeiconsIcon className="size-4" icon={Download01Icon} />
					{tab.app_installed ? "Enable" : "Add"}
				</InstallProgressButton>
				{openSettings ? (
					<Button onClick={openSettings} size="sm" variant="ghost">
						<HugeiconsIcon className="size-4" icon={Settings01Icon} />
						Settings
					</Button>
				) : null}
			</div>
		</Empty>
	);
}

function InstalledPill() {
	return (
		<Badge variant="secondary">
			<HugeiconsIcon className="size-3" icon={CheckmarkCircle02Icon} />
			Added
		</Badge>
	);
}

function DetailPanel({
	tab,
	item,
	busy,
	installed,
	error,
	onInstall,
	runAction,
}: {
	busy: boolean;
	error: string | null;
	installed: boolean;
	item: StoreCatalogItem | null;
	onInstall: () => void;
	runAction: (action: ViewAction, item: StoreCatalogItem) => void;
	tab: PluginStoreTab;
}) {
	if (!item) {
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<TabIcon icon={tab.icon} />
					</EmptyMedia>
					<EmptyTitle>Nothing selected</EmptyTitle>
					<EmptyDescription>
						Pick an item on the left to review it before installing.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}
	const installSpec = pluginStoreSpec(tab)?.install;
	const installable = installSpec != null;
	const sourceHref = safeHttpUrl(item.sourceUrl);
	return (
		<ListingDetailShell
			actions={
				<>
					{installSpec ? (
						<InstallAction
							busy={busy}
							installed={installed}
							label={installSpec.label}
							onInstall={onInstall}
						/>
					) : null}
					{/* Declared per-item extras (Preview, Duplicate, …) fire against the
					    SELECTED row, so they live here rather than on the card — a
					    card-level slot would have to pick a row before the user did. */}
					{pluginStoreSpec(tab)?.itemActions?.map((action) => (
						<Button
							key={action.id}
							onClick={() => runAction(action, item)}
							size="sm"
							variant={action.style === "danger" ? "destructive" : "outline"}
						>
							{action.label}
						</Button>
					))}
					{sourceHref ? (
						<Button
							render={
								<a
									href={sourceHref}
									rel="noopener noreferrer"
									target="_blank"
								/>
							}
							size="sm"
							variant="ghost"
						>
							<HugeiconsIcon className="size-4" icon={Link01Icon} />
							Source
						</Button>
					) : null}
					{error ? (
						<span className="ml-auto flex items-center gap-1.5 text-sm text-status-destructive">
							<HugeiconsIcon className="size-4 shrink-0" icon={Alert01Icon} />
							{error}
						</span>
					) : null}
				</>
			}
			aside={
				item.tags.length > 0 ? (
					<ListingAsideCard title="Tags">
						<div className="flex flex-wrap gap-1">
							{item.tags.map((tag) => (
								<Badge key={tag} typography="normal" variant="outline">
									{tag}
								</Badge>
							))}
						</div>
					</ListingAsideCard>
				) : null
			}
			hero={
				<ListingHero
					badges={[
						item.badge ?? null,
						installable && installed ? "Added" : null,
					].filter((b): b is string => Boolean(b))}
					icon={<TabIcon className="size-8" icon={item.icon ?? tab.icon} />}
					name={item.title}
					tagline={item.description}
				/>
			}
			stats={
				<ListingStatStrip
					items={[
						{ label: "Catalog", value: tab.title },
						{
							label: "Status",
							value: installable
								? installed
									? "Added"
									: "Not added"
								: "Available",
						},
						{ label: "Tags", value: `${item.tags.length}` },
					]}
				/>
			}
		>
			<ListingSection title="About">
				<p className="text-muted-foreground text-sm leading-relaxed">
					{item.description || "No description provided."}
				</p>
			</ListingSection>
			<ContributedDetailGraph item={item} tab={tab} />
		</ListingDetailShell>
	);
}

/** The declared per-item detail picture (a graph today), for tabs whose spec
 *  carries `detail.graph`. Rendered as its own component rather than inline in
 *  {@link DetailPanel} because that function early-returns on `item === null`,
 *  so a hook called after it would change order between renders.
 *
 *  Renders nothing at all unless the tab DECLARES a graph — a contributed tab
 *  that says nothing about detail keeps exactly the panel it had before. */
function ContributedDetailGraph({
	tab,
	item,
}: {
	item: StoreCatalogItem;
	tab: PluginStoreTab;
}) {
	const node = useActiveNode();
	const spec = useMemo(() => pluginStoreSpec(tab), [tab]);
	const source = spec?.detail?.source;
	const sourceRequest =
		source?.http.method === "GET"
			? contributionSourceRequest(tab, {
					http: { method: "GET", path: source.http.path },
				})
			: null;
	const detail = useQuery({
		queryKey: [
			"store-tab-detail",
			tab.plugin,
			tab.id,
			item.id,
			node.url,
			node.token,
			sourceRequest?.path ?? "",
		],
		enabled: sourceRequest !== null,
		queryFn: async () => {
			if (!(source && sourceRequest)) {
				return null;
			}
			const rendered = renderContributionActionHttp(tab, source.http, {
				item: item.raw,
			});
			const target = toTarget(node);
			const resp = await fetch(apiUrl(target, rendered.path), {
				method: sourceRequest.method,
				headers: await requestHeaders(target),
			});
			if (!resp.ok) {
				throw new Error(`${rendered.path} failed: ${resp.status}`);
			}
			return z.json().parse(await resp.json());
		},
	});

	const graph = useMemo(() => {
		const graphSpec = spec?.detail?.graph;
		if (!graphSpec) {
			return null;
		}
		// No declared source means the row itself already carries the shape.
		const payload = source ? detail.data : item.raw;
		return storeGraphFromResponse(
			graphSpec,
			storeDetailObject(spec?.detail ?? {}, payload)
		);
	}, [spec, source, detail.data, item.raw]);

	if (!graph || graph.nodes.length === 0) {
		return null;
	}
	return (
		<ListingSection title={spec?.detail?.graph?.title ?? "Graph"}>
			<StoreDetailGraph edges={graph.edges} nodes={graph.nodes} />
		</ListingSection>
	);
}

/** Add affordance in the detail pane: a button until installed, then a
 *  non-interactive "Added" pill (a contributed catalog declares no uninstall, so
 *  surfacing one would be a promise the spec cannot keep). */
function InstallAction({
	installed,
	busy,
	label,
	onInstall,
}: {
	busy: boolean;
	installed: boolean;
	label?: string;
	onInstall: () => void;
}) {
	if (installed) {
		return <InstalledPill />;
	}
	return (
		<InstallProgressButton
			idleVariant="ghost"
			installing={busy}
			onClick={onInstall}
		>
			<HugeiconsIcon className="size-4" icon={Download01Icon} />
			{label ?? "Add"}
		</InstallProgressButton>
	);
}

/** Card-level add affordance — same rule as the detail pane's, and the same
 *  verb: a spec that calls its action "Use" must not say "Add" on the card and
 *  "Use" in the detail pane for the same item. `StoreItemAction` hardcodes
 *  "Add", so a declared label takes the plain button instead. */
function CardAction({
	installed,
	busy,
	label,
	onInstall,
}: {
	busy: boolean;
	installed: boolean;
	label?: string;
	onInstall: () => void;
}) {
	if (installed) {
		return (
			<Button disabled size="sm" variant="secondary">
				Added
			</Button>
		);
	}
	if (label && label !== "Add" && label !== "Install") {
		return (
			<Button disabled={busy} onClick={onInstall} size="sm" variant="ghost">
				{label}
			</Button>
		);
	}
	return (
		<StoreItemAction busy={busy} installed={false} onInstall={onInstall} />
	);
}

/** Flatten an install response into `{{result.<key>}}` template values. Only scalar
 *  leaves are exposed — a nested object in a route template would stringify to JSON
 *  and produce a broken path. */
const resultScalarSchema = z.union([
	z.string(),
	z.number(),
	z.boolean(),
	z.null(),
]);
function resultValues(
	payload: Parameters<typeof viewSourceRowSchema.safeParse>[0]
): ViewSourceRow {
	const parsed = viewSourceRowSchema.safeParse(payload);
	if (!parsed.success) {
		return {};
	}
	const out: ViewSourceRow = {};
	for (const [key, value] of Object.entries(parsed.data)) {
		const scalar = resultScalarSchema.safeParse(value);
		if (scalar.success) {
			out[`result.${key}`] = scalar.data;
		}
	}
	return out;
}

export default function ContributedStoreSection({
	tab,
	initialQuery = "",
}: {
	initialQuery?: string;
	tab: PluginStoreTab;
}) {
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
					description: `${item.title} is ready.`,
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
		[spec, node, queryClient, tab.plugin, tab.id, openTab]
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

function CatalogList({
	tab,
	spec,
	groups,
	total,
	loading,
	error,
	selectedId,
	pendingId,
	isInstalled,
	onSelect,
	onInstall,
	onClearSearch,
	onRetry,
}: {
	error: string | null;
	groups: { items: StoreCatalogItem[]; label: string; value: string }[];
	isInstalled: (item: StoreCatalogItem) => boolean;
	loading: boolean;
	onInstall: (item: StoreCatalogItem) => void;
	onClearSearch: () => void;
	onSelect: (id: string) => void;
	onRetry: () => void;
	pendingId: string | null;
	selectedId: string | null;
	spec: StoreTabSpec;
	tab: PluginStoreTab;
	total: number;
}) {
	if (loading && total === 0) {
		return <SkeletonRows inset="catalog" />;
	}
	if (error && total === 0) {
		return (
			<Empty className="h-full" inset="dense">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<TabIcon icon={tab.icon} />
					</EmptyMedia>
					<EmptyTitle>Couldn&apos;t load {tab.title}</EmptyTitle>
					<EmptyDescription>{error}</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button onClick={onRetry} size="sm" variant="ghost">
						Try again
					</Button>
				</EmptyContent>
			</Empty>
		);
	}
	if (total === 0) {
		return (
			<Empty className="h-full" inset="dense">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<TabIcon icon={tab.icon} />
					</EmptyMedia>
					<EmptyTitle>{spec.empty?.title ?? "Nothing found"}</EmptyTitle>
					<EmptyDescription>
						{spec.empty?.description ?? "Try a different search."}
					</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button onClick={onClearSearch} size="sm" variant="ghost">
						Clear search
					</Button>
				</EmptyContent>
			</Empty>
		);
	}

	return (
		<div>
			{groups.map((group) => (
				<section className="mb-6" key={group.value || "all"}>
					{group.label ? (
						<h3 className="mb-2 px-1 font-medium text-muted-foreground text-xs uppercase tracking-widest">
							{group.label}
						</h3>
					) : null}
					<StoreCardGrid>
						{group.items.map((item) => (
							<StoreCatalogCard
								action={
									spec.install ? (
										<CardAction
											busy={pendingId === item.id}
											installed={isInstalled(item)}
											label={spec.install.label}
											onInstall={() => onInstall(item)}
										/>
									) : undefined
								}
								// A contributed tab declares at most an install verb, so the
								// menu is that verb or nothing — an already-installed row
								// gets no menu rather than an empty one.
								contextMenu={
									spec.install && !isInstalled(item)
										? storeItemContextMenu({
												installed: false,
												onInstall: () => onInstall(item),
											})
										: undefined
								}
								description={item.description}
								icon={
									<TabIcon className="size-5" icon={item.icon ?? tab.icon} />
								}
								key={item.id}
								name={item.title}
								onClick={() => onSelect(item.id)}
								seedId={item.id}
								selected={item.id === selectedId}
							/>
						))}
					</StoreCardGrid>
				</section>
			))}
		</div>
	);
}
