import { Image01Icon } from "@hugeicons/core-free-icons";
import { AGENT_ACCOUNT_ACCESS_SETTING_ID } from "@ryu/blocks/desktop/agent-settings-search.ts";
import type { ViewMode } from "@ryu/blocks/desktop/view-toggle.tsx";
import { MARKETPLACE_SECTION_TABS } from "@ryu/marketplace/catalog/chrome/marketplace-sections";
import type { StoreSectionTab } from "@ryu/marketplace/catalog/chrome/marketplace-surface";
import MarketplaceSurface from "@ryu/marketplace/catalog/chrome/marketplace-surface";
import { StoreViewModeProvider } from "@ryu/marketplace/catalog/chrome/store-catalog-layout";
import { InstalledOnlyProvider } from "@ryu/marketplace/catalog/installed-filter";
import type { MarketplaceCreatorListing } from "@ryu/marketplace/creators/types";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DesktopMarketplaceHost } from "@/src/components/marketplace/host.tsx";
import PrivatePackageInstallDialog from "@/src/components/marketplace/PrivatePackageInstallDialog.tsx";
import PrivatePackageShareDialog from "@/src/components/marketplace/PrivatePackageShareDialog.tsx";
import { DesktopCatalogHost } from "@/src/components/store/catalog-host.tsx";
import { StoreContent } from "@/src/components/store/page/store-content.tsx";
import { StorePageTrailingActions } from "@/src/components/store/page/store-page-trailing.tsx";
import {
	BUILTIN_SECTION_VALUES,
	canonicalStoreSection,
	isBuiltinSection,
	STORE_PRIMARY_SECTIONS,
	STORE_VIEW_SECTIONS,
	type StoreSection,
	storeShowcaseSupported,
	WALLPAPERS_STORE_SECTION,
} from "@/src/components/store/page/store-sections.ts";
import StoreSearchResults from "@/src/components/store/StoreSearchResults.tsx";
import {
	type StoreToolbarConfig,
	StoreToolbarProvider,
} from "@/src/components/store/storeToolbar.tsx";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import {
	contributedTabForSection,
	resolveStoreSection,
	storeTabGroup,
	storeTabSectionValue,
	useContributedStoreTabs,
} from "@/src/hooks/useContributedStoreTabs.ts";
import { useStorePrefetch } from "@/src/hooks/useStorePrefetch.ts";
import {
	type StoreSearchRealm,
	useStoreSearch,
} from "@/src/hooks/useStoreSearch.ts";
import { useStoreSectionCounts } from "@/src/hooks/useStoreSectionCounts.ts";
import { useStoreViewMode } from "@/src/hooks/useStoreViewMode.ts";
import {
	getMarketplaceBackdrops,
	usePluginBackgrounds,
} from "@/src/lib/plugin-backgrounds.ts";

/**
 * Unified Store shell, App Store-shaped: one inline page chrome — the section
 * title, the section tabs, and the store-wide search — over the active section's
 * content.
 *
 * The chrome used to be a floating, translucent bar pinned to the bottom of the
 * pane with the tabs, the search and the filter panel all folded inside it. It is
 * ordinary page furniture now: the tabs scroll in the flow (the list is
 * open-ended — every app may register one), search is a button beside them, and a
 * section's own filters live with that section's content
 * ({@link StoreToolbarProvider} → the toolbar row here).
 *
 * The section is decided once on mount from `initialSection` (driven by the tab
 * path in Layout) and switched in-place from the tabs. Typing in the store-wide
 * search shows aggregated cross-realm results in place of the section; picking a
 * result opens that realm with the query carried over.
 */
export default function StorePage({
	initialSection = "home",
	initialQuery,
	initialInstalledOnly = false,
	initialMarketplaceQuery,
	initialMarketplaceItem,
}: {
	initialSection?: string;
	/** Open with the "Installed only" switch already on. Set by the legacy
	 *  `/apps`, `/extensions` and `/fleet` routes, which used to open the retired
	 *  "Added" section — the switch is where that view lives now. */
	initialInstalledOnly?: boolean;
	/** Seed the active section's search (deep-links carry it, e.g. the
	 *  integrations.sh → MCP-catalog hand-off pre-filters by server name). */
	initialQuery?: string;
	/** One-shot query carried from the global command palette's Marketplace result. */
	initialMarketplaceQuery?: string;
	/** One-shot Marketplace listing to open after the Browse tab mounts. */
	initialMarketplaceItem?: { id: string; kind: string };
}) {
	const openTab = useTabSelector((state) => state.openTab);
	// An installed Agent Template opens on Account access: the one place to limit
	// which of the user's accounts it may use (it starts with no limit).
	const openAgentAccountAccess = useCallback(
		(agent: { id: string; name: string }) => {
			openTab(`/agents/${agent.id}/edit`, {
				title: agent.name,
				mountContext: { setting: AGENT_ACCOUNT_ACCESS_SETTING_ID },
			});
		},
		[openTab]
	);
	// App-registered sections. These arrive asynchronously (Core's contributions
	// endpoint), so `initialSection` is resolved against them in an effect below
	// rather than once at mount — a deep link to `/store/workflows` must land on the
	// Workflows tab even though the contribution has not loaded on first render.
	const contributedTabs = useContributedStoreTabs();
	// Warm every tab's opening view in the background, so switching tabs reads
	// from cache instead of spinning once per tab per session.
	useStorePrefetch();
	const sectionCounts = useStoreSectionCounts(contributedTabs);
	const pluginBackgrounds = usePluginBackgrounds();
	const wallpaperCount = useMemo(
		() => getMarketplaceBackdrops(pluginBackgrounds).length,
		[pluginBackgrounds]
	);
	const initialCanonicalSection = canonicalStoreSection(initialSection);
	const [section, setSection] = useState<StoreSection>(() =>
		isBuiltinSection(initialCanonicalSection) ? initialCanonicalSection : "home"
	);
	// The requested section, held until it can be resolved. Cleared once honoured so
	// a later manual pick is never overridden by a stale deep link.
	const [pendingSection, setPendingSection] = useState<string | null>(() =>
		isBuiltinSection(initialCanonicalSection) ? null : initialCanonicalSection
	);

	useEffect(() => {
		if (!pendingSection) {
			return;
		}
		const resolved = resolveStoreSection(
			canonicalStoreSection(pendingSection),
			BUILTIN_SECTION_VALUES,
			contributedTabs
		);
		if (resolved) {
			setSection(resolved);
			setPendingSection(null);
		}
	}, [pendingSection, contributedTabs]);

	const activeContributedTab = useMemo(
		() =>
			contributedTabForSection(section, contributedTabs) ??
			(section === "workflows"
				? (contributedTabs.find((tab) => tab.id === "workflows") ?? null)
				: null),
		[section, contributedTabs]
	);
	const [storedStoreView, setStoredStoreView] = useStoreViewMode(
		section,
		storeShowcaseSupported(section) ? "showcase" : "grid"
	);
	const storeView: ViewMode =
		storedStoreView === "showcase" && !storeShowcaseSupported(section)
			? "grid"
			: storedStoreView;

	// The built-in list is the shared web/desktop contract. Contributed tabs are
	// appended only when their id is not already represented by that contract, so
	// a Workflows contribution can own the body without creating a second pill.
	const navSections = useMemo(() => {
		const builtIn: StoreSectionTab[] = [];
		for (const tab of MARKETPLACE_SECTION_TABS) {
			builtIn.push({ ...tab, count: sectionCounts[tab.value] });
			if (tab.value === "home") {
				builtIn.push({
					count: wallpaperCount,
					group: "discover",
					icon: Image01Icon,
					label: "Wallpapers",
					value: WALLPAPERS_STORE_SECTION,
				});
			}
		}
		const contributed = contributedTabs
			.filter((tab) => !BUILTIN_SECTION_VALUES.includes(tab.id))
			.map<StoreSectionTab>((tab) => ({
				group: storeTabGroup(tab),
				icon: tab.icon ?? "package-01",
				label: tab.title,
				count: sectionCounts[storeTabSectionValue(tab)],
				value: storeTabSectionValue(tab),
			}));
		return [...builtIn, ...contributed];
	}, [contributedTabs, sectionCounts, wallpaperCount]);

	// Store-wide search, live from any section via the nav rail. A non-empty
	// query takes over the content pane with aggregated results.
	const [searchQuery, setSearchQuery] = useState("");
	const search = useStoreSearch(searchQuery);

	// When a store-wide search result opens a realm, the query rides along as that
	// section's initial search; cleared whenever a section is picked manually.
	const [sectionInitialQuery, setSectionInitialQuery] = useState<
		string | undefined
	>(initialQuery ?? initialMarketplaceQuery);

	// …and when a HOME shelf card opens a realm, the clicked item's id rides along
	// instead, so the section opens with that item's preview rather than with its
	// title typed into the search box. Two separate slots on purpose: a store-wide
	// search result carries a query and no id, a Home card carries an id and no
	// query, and collapsing them would make one of the two lie.
	const [sectionInitialSelectedId, setSectionInitialSelectedId] = useState<
		string | undefined
	>(initialMarketplaceItem?.id);
	const [marketplaceItem, setMarketplaceItem] = useState(
		initialMarketplaceItem
	);

	// The active section publishes its filter panel here; the chrome's toolbar row
	// renders it as a popover button beside the search.
	const [toolbar, setToolbar] = useState<StoreToolbarConfig | null>(null);

	// "Installed only" — the retired "Added" tab as a switch over whichever
	// section is open. Shell state rather than per-section state, so it survives
	// switching tabs: that is the whole point (browse Models installed, then
	// Plugins installed, without re-arming it each time).
	const [installedOnly, setInstalledOnly] = useState(initialInstalledOnly);
	const [privateInstallOpen, setPrivateInstallOpen] = useState(false);
	const [privateShareOpen, setPrivateShareOpen] = useState(false);

	const openRealm = (
		realm: StoreSearchRealm,
		query: string,
		itemId?: string
	) => {
		setSectionInitialQuery(query.trim() || undefined);
		setSectionInitialSelectedId(itemId || undefined);
		setMarketplaceItem(undefined);
		setSearchQuery("");
		setSection(realm);
	};

	// A creator profile's listing opens in the paid Browse view, which owns the
	// cross-kind Marketplace detail. Stable identity: the Creators tab keys its
	// reads on the service this callback is folded into.
	const openMarketplaceItem = useCallback(
		(listing: MarketplaceCreatorListing) => {
			setSectionInitialQuery(undefined);
			setSectionInitialSelectedId(undefined);
			setMarketplaceItem({ id: listing.id, kind: listing.kind });
			setSearchQuery("");
			setSection("browse");
		},
		[]
	);

	const openConnections = () => {
		setSectionInitialQuery(undefined);
		setSectionInitialSelectedId(undefined);
		setMarketplaceItem(undefined);
		setSearchQuery("");
		setSection("connections");
	};

	const openInstallChat = useCallback(
		(prompt: string) => {
			openTab("/chat", {
				forceNew: true,
				title: "Integration setup",
				initialPrompt: prompt,
				initialSubmit: true,
			});
		},
		[openTab]
	);

	const selectSection = useCallback(
		(value: string) => {
			const resolved = resolveStoreSection(
				canonicalStoreSection(value),
				BUILTIN_SECTION_VALUES,
				contributedTabs
			);
			if (resolved) {
				setSectionInitialQuery(undefined);
				// A manual tab pick must drop a stale preselect too, or the section
				// re-opens the last Home card's preview when the user comes back to it.
				setSectionInitialSelectedId(undefined);
				setMarketplaceItem(undefined);
				setSearchQuery("");
				setPendingSection(null);
				setSection(resolved);
			}
		},
		[contributedTabs]
	);

	const searching =
		section !== WALLPAPERS_STORE_SECTION &&
		(search.hasQuery || searchQuery.trim().length > 0);
	// Between the first keystroke and the debounced query firing, show the
	// spinner instead of a premature "Nothing found".
	const searchPending = searchQuery.trim().length > 0 && !search.hasQuery;

	// The Models tab keeps its full-width master-detail layout and publishes its
	// rich filters up here; every other (carded) section renders its own filter
	// button beside its list, so only Models fills this slot.
	const sectionFilters = section === "models" ? toolbar : null;
	// …and because Models is full-bleed, the chrome above it must be too. A
	// centered `max-w-4xl` search + tab strip sitting over an edge-to-edge
	// master-detail pane is the one place the shell visibly stopped being one
	// page.
	const fullBleed = section === "models";
	const showStoreView =
		!searching &&
		(STORE_VIEW_SECTIONS.has(section) || activeContributedTab !== null);

	return (
		<DesktopMarketplaceHost>
			<DesktopCatalogHost>
				<StoreToolbarProvider value={setToolbar}>
					<InstalledOnlyProvider value={installedOnly}>
						<MarketplaceSurface
							active={section}
							className="h-full overflow-hidden"
							contentClassName="min-h-0 min-w-0 flex-1 overflow-hidden"
							fullBleed={fullBleed}
							onSearch={setSearchQuery}
							onSelect={selectSection}
							primarySections={STORE_PRIMARY_SECTIONS}
							query={searchQuery}
							sections={navSections}
							showGlobalSearch={section !== WALLPAPERS_STORE_SECTION}
							trailing={
								section === WALLPAPERS_STORE_SECTION ? null : (
									<StorePageTrailingActions
										installedOnly={installedOnly}
										onOpenPrivateInstall={() => setPrivateInstallOpen(true)}
										onOpenPrivateShare={() => setPrivateShareOpen(true)}
										section={section}
										sectionFilters={sectionFilters}
										setInstalledOnly={setInstalledOnly}
										setStoredStoreView={setStoredStoreView}
										showStoreView={showStoreView}
										storeView={storeView}
									/>
								)
							}
						>
							{searching ? (
								<StoreSearchResults
									groups={search.groups}
									isEmpty={search.isEmpty}
									loading={search.loading || searchPending}
									onClearSearch={() => setSearchQuery("")}
									onOpenRealm={(realm, itemId) =>
										openRealm(realm, searchQuery, itemId)
									}
								/>
							) : (
								<StoreViewModeProvider mode={storeView}>
									<StoreContent
										contributedTab={activeContributedTab}
										initialMarketplaceItem={marketplaceItem}
										initialQuery={sectionInitialQuery}
										initialSelectedId={sectionInitialSelectedId}
										onBrowseHome={() => setSection("home")}
										onOpenAgentAccountAccess={openAgentAccountAccess}
										onOpenConnections={openConnections}
										onOpenInstallChat={openInstallChat}
										onOpenMarketplaceItem={openMarketplaceItem}
										onOpenRealm={openRealm}
										section={section}
									/>
								</StoreViewModeProvider>
							)}
						</MarketplaceSurface>
					</InstalledOnlyProvider>
				</StoreToolbarProvider>
				<PrivatePackageInstallDialog
					onClose={() => setPrivateInstallOpen(false)}
					open={privateInstallOpen}
				/>
				<PrivatePackageShareDialog
					onClose={() => setPrivateShareOpen(false)}
					open={privateShareOpen}
				/>
			</DesktopCatalogHost>
		</DesktopMarketplaceHost>
	);
}
