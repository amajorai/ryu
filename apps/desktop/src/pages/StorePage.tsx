import {
	Download01Icon,
	Key01Icon,
	Package01Icon,
	SlidersHorizontalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { StoreComingSoon } from "@ryu/blocks/desktop/store";
import { type ViewMode, ViewToggle } from "@ryu/blocks/desktop/view-toggle";
import MarketplaceHelpDialog from "@ryu/marketplace/catalog/chrome/marketplace-help-dialog";
import {
	MARKETPLACE_SECTION_TABS,
	MARKETPLACE_SECTION_VALUES,
	type MarketplaceSection,
} from "@ryu/marketplace/catalog/chrome/marketplace-sections";
import type { StoreSectionTab } from "@ryu/marketplace/catalog/chrome/marketplace-surface";
import MarketplaceSurface from "@ryu/marketplace/catalog/chrome/marketplace-surface";
import { StoreViewModeProvider } from "@ryu/marketplace/catalog/chrome/store-catalog-layout";
import { InstalledOnlyProvider } from "@ryu/marketplace/catalog/installed-filter";
import { Button } from "@ryu/ui/components/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import { useCallback, useEffect, useMemo, useState } from "react";
import ConnectionsTab from "@/src/components/marketplace/ConnectionsTab.tsx";
import { DesktopMarketplaceHost } from "@/src/components/marketplace/host.tsx";
import LicensesTab from "@/src/components/marketplace/LicensesTab.tsx";
import PrivatePackageInstallDialog from "@/src/components/marketplace/PrivatePackageInstallDialog.tsx";
import PrivatePackageShareDialog from "@/src/components/marketplace/PrivatePackageShareDialog.tsx";
import SellTab from "@/src/components/marketplace/SellTab.tsx";
import AgentsCatalogSection from "@/src/components/store/AgentsCatalogSection.tsx";
import AppsCatalogSection from "@/src/components/store/AppsCatalogSection.tsx";
import ContributedStoreSection from "@/src/components/store/ContributedStoreSection.tsx";
import { DesktopCatalogHost } from "@/src/components/store/catalog-host.tsx";
import EnginesCatalogSection from "@/src/components/store/EnginesCatalogSection.tsx";
import IntegrationsCatalogSection from "@/src/components/store/IntegrationsCatalogSection.tsx";
import MarketplaceBrowseSection from "@/src/components/store/MarketplaceBrowseSection.tsx";
import MarketplacesCatalogSection from "@/src/components/store/MarketplacesCatalogSection.tsx";
import McpCatalogSection from "@/src/components/store/McpCatalogSection.tsx";
import ModelsCatalogSection from "@/src/components/store/ModelsCatalogSection.tsx";
import SkillsCatalogSection from "@/src/components/store/SkillsCatalogSection.tsx";
import StoreHome from "@/src/components/store/StoreHome.tsx";
import StoreSearchResults from "@/src/components/store/StoreSearchResults.tsx";
import {
	type StoreToolbarConfig,
	StoreToolbarProvider,
} from "@/src/components/store/storeToolbar.tsx";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
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
import type { PluginStoreTab } from "@/src/lib/api/plugins.ts";

/** The built-in section values are shared with the web Marketplace. Everything
 * else in the bar is an app-registered `contributes.store_tabs[]` entry. */
type BuiltinStoreSection = MarketplaceSection;

/** An active section value: a {@link BuiltinStoreSection}, or a contributed tab's
 *  `plugin:<pluginId>:<tabId>` key. Deliberately open — the Store's section list is
 *  no longer a closed union the shell can enumerate at compile time. */
type StoreSection = string;

const BUILTIN_SECTION_VALUES = MARKETPLACE_SECTION_VALUES;

/** Store sections whose content uses the shared catalog grid/list geometry. */
const STORE_VIEW_SECTIONS: ReadonlySet<string> = new Set([
	"apps",
	"plugins",
	"skills",
	"mcp",
	"agents",
	"engines",
	"integrations",
	"workflows",
	"themes",
	"browse",
]);

function storeShowcaseSupported(section: string): boolean {
	// The Agents tab owns the employee-badge renderer. Other Store tabs keep the
	// compact catalog card in both Grid and List modes until they gain a real
	// alternate presentation of their own.
	return section === "agents";
}

/** Preserve old `/store/account` deep links while the visible nav uses the same
 * individual money tabs as the web surface. */
function canonicalStoreSection(value: string): string {
	return value === "account" ? "connections" : value;
}

function isBuiltinSection(value: string): value is BuiltinStoreSection {
	return (BUILTIN_SECTION_VALUES as string[]).includes(value);
}

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
	const { openTab } = useTabsContext();
	// App-registered sections. These arrive asynchronously (Core's contributions
	// endpoint), so `initialSection` is resolved against them in an effect below
	// rather than once at mount — a deep link to `/store/workflows` must land on the
	// Workflows tab even though the contribution has not loaded on first render.
	const contributedTabs = useContributedStoreTabs();
	// Warm every tab's opening view in the background, so switching tabs reads
	// from cache instead of spinning once per tab per session.
	useStorePrefetch();
	const sectionCounts = useStoreSectionCounts(contributedTabs);
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
		const builtIn = MARKETPLACE_SECTION_TABS.map((tab) => ({
			...tab,
			count: sectionCounts[tab.value],
		}));
		const contributed = contributedTabs
			.filter(
				(tab) =>
					!(MARKETPLACE_SECTION_VALUES as readonly string[]).includes(tab.id)
			)
			.map<StoreSectionTab>((tab) => ({
				group: storeTabGroup(tab),
				icon: tab.icon ?? "package-01",
				label: tab.title,
				count: sectionCounts[storeTabSectionValue(tab)],
				value: storeTabSectionValue(tab),
			}));
		return [...builtIn, ...contributed];
	}, [contributedTabs, sectionCounts]);

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

	const searching = search.hasQuery || searchQuery.trim().length > 0;
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
							className="h-full overflow-hidden pt-12"
							contentClassName="min-h-0 min-w-0 flex-1 overflow-hidden"
							fullBleed={fullBleed}
							onSearch={setSearchQuery}
							onSelect={selectSection}
							query={searchQuery}
							sections={navSections}
							trailing={
								<>
									{showStoreView ? (
										<ViewToggle
											onChange={setStoredStoreView}
											showShowcase={storeShowcaseSupported(section)}
											value={storeView}
										/>
									) : null}
									{sectionFilters?.panel ? (
										<Popover>
											<PopoverTrigger
												render={
													<Button className="gap-1.5" variant="ghost">
														<HugeiconsIcon
															className="size-4"
															icon={
																sectionFilters.panelIcon ??
																SlidersHorizontalIcon
															}
														/>
														{sectionFilters.panelLabel ?? "Filters"}
													</Button>
												}
											/>
											<PopoverContent
												align="end"
												className="w-[min(30rem,90vw)] p-0"
											>
												{sectionFilters.panel}
											</PopoverContent>
										</Popover>
									) : null}
									{section === "marketplaces" ? null : (
										<Tooltip>
											<TooltipTrigger
												render={
													<Button
														aria-pressed={installedOnly}
														className="gap-1.5"
														onClick={() => setInstalledOnly((on) => !on)}
														variant={installedOnly ? "secondary" : "ghost"}
													>
														<HugeiconsIcon
															className="size-4"
															icon={Download01Icon}
														/>
														Installed
													</Button>
												}
											/>
											<TooltipContent>
												{installedOnly
													? "Showing only what you have installed"
													: "Show only what you have installed"}
											</TooltipContent>
										</Tooltip>
									)}
									<Tooltip>
										<TooltipTrigger
											render={
												<Button
													className="gap-1.5"
													onClick={() => setPrivateInstallOpen(true)}
													variant="ghost"
												>
													<HugeiconsIcon
														className="size-4"
														icon={Package01Icon}
													/>
													Install from code
												</Button>
											}
										/>
										<TooltipContent>
											Install a private package with a publisher code
										</TooltipContent>
									</Tooltip>
									<Tooltip>
										<TooltipTrigger
											render={
												<Button
													className="gap-1.5"
													onClick={() => setPrivateShareOpen(true)}
													variant="ghost"
												>
													<HugeiconsIcon className="size-4" icon={Key01Icon} />
													Share package
												</Button>
											}
										/>
										<TooltipContent>
											Create a time-limited private package code
										</TooltipContent>
									</Tooltip>
									<MarketplaceHelpDialog />
								</>
							}
						>
							{searching ? (
								<StoreSearchResults
									groups={search.groups}
									isEmpty={search.isEmpty}
									loading={search.loading || searchPending}
									onClearSearch={() => setSearchQuery("")}
									onOpenRealm={(realm) => openRealm(realm, searchQuery)}
								/>
							) : (
								<StoreViewModeProvider mode={storeView}>
									<StoreContent
										contributedTab={activeContributedTab}
										initialMarketplaceItem={marketplaceItem}
										initialQuery={sectionInitialQuery}
										initialSelectedId={sectionInitialSelectedId}
										onBrowseHome={() => setSection("home")}
										onOpenConnections={openConnections}
										onOpenInstallChat={openInstallChat}
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

function StoreContent({
	section,
	initialQuery,
	initialSelectedId,
	initialMarketplaceItem,
	onOpenRealm,
	onOpenConnections,
	onOpenInstallChat,
	onBrowseHome,
	contributedTab,
}: {
	/** The app-registered tab this section belongs to, if it is not a built-in. */
	contributedTab: PluginStoreTab | null;
	section: StoreSection;
	/** Seed query carried over from the store-wide search (searchable realms only). */
	initialQuery?: string;
	/** Open this item's preview on arrival — a Home shelf card's id. Forwarded only
	 *  to the six sections that own a per-item preview; Integrations, Engines,
	 *  Account and app-registered tabs have no such concept. */
	initialSelectedId?: string;
	/** One-shot Marketplace result forwarded to the cross-kind paid Browse view. */
	initialMarketplaceItem?: { id: string; kind: string };
	onOpenRealm: (
		realm: StoreSearchRealm,
		query: string,
		itemId?: string
	) => void;
	onOpenConnections: () => void;
	onOpenInstallChat: (prompt: string) => void;
	onBrowseHome: () => void;
}) {
	if (section === "home") {
		return <StoreHome onOpenRealm={onOpenRealm} />;
	}
	if (section === "integrations") {
		return (
			<IntegrationsCatalogSection
				initialQuery={initialQuery}
				onOpenConnections={onOpenConnections}
				onOpenInstallChat={onOpenInstallChat}
				onOpenRealm={onOpenRealm}
			/>
		);
	}
	if (section === "apps") {
		return (
			<AppsCatalogSection
				initialQuery={initialQuery}
				initialSelectedId={initialSelectedId}
				variant="apps"
			/>
		);
	}
	if (section === "plugins") {
		return (
			<AppsCatalogSection
				initialQuery={initialQuery}
				initialSelectedId={initialSelectedId}
				variant="plugins"
			/>
		);
	}
	if (section === "models") {
		return (
			<ModelsCatalogSection
				initialQuery={initialQuery}
				initialSelectedId={initialSelectedId}
			/>
		);
	}
	if (section === "skills") {
		return (
			<SkillsCatalogSection
				initialQuery={initialQuery}
				initialSelectedId={initialSelectedId}
			/>
		);
	}
	if (section === "mcp") {
		return (
			<McpCatalogSection
				initialQuery={initialQuery}
				initialSelectedId={initialSelectedId}
			/>
		);
	}
	if (section === "agents") {
		return (
			<AgentsCatalogSection
				initialQuery={initialQuery}
				initialSelectedId={initialSelectedId}
			/>
		);
	}
	if (section === "engines") {
		return <EnginesCatalogSection />;
	}
	if (section === "workflows") {
		if (contributedTab) {
			return (
				<ContributedStoreSection
					initialQuery={initialQuery}
					tab={contributedTab}
				/>
			);
		}
		return <MarketplaceBrowseSection onlyKind="workflow" />;
	}
	if (section === "themes") {
		return <MarketplaceBrowseSection onlyKind="theme" />;
	}
	if (section === "marketplaces") {
		return <MarketplacesCatalogSection />;
	}
	if (section === "browse") {
		return (
			<MarketplaceBrowseSection
				initialItem={initialMarketplaceItem}
				initialQuery={initialQuery}
			/>
		);
	}
	if (section === "connections") {
		return <ConnectionsTab />;
	}
	if (section === "licenses") {
		return <LicensesTab />;
	}
	if (section === "sell") {
		return <SellTab />;
	}
	// App-registered tab. EVERY one renders from its declarative spec — there is no
	// per-plugin component table any more. The Workflows tab was the last holder of
	// one, purely so its preview could draw the template graph; that is now the
	// `spec.detail.graph` primitive, which any app can declare (see
	// `ContributedStoreSection`). A first-party escape hatch here is exactly what
	// makes a "you can own a Store section" promise untrue for everyone else.
	if (contributedTab) {
		return (
			<ContributedStoreSection
				initialQuery={initialQuery}
				tab={contributedTab}
			/>
		);
	}
	const meta = MARKETPLACE_SECTION_TABS.find((s) => s.value === section);
	return (
		<StoreComingSoon
			icon={meta?.icon ?? Package01Icon}
			label={meta?.label ?? "This"}
			onBrowse={onBrowseHome}
		/>
	);
}
