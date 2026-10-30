// Unified Library page — the single browsing surface for everything the app
// holds (agents, workflows, chats, spaces, teams, meetings, channels,
// identities) PLUS every collection an app registers, modelled on the Store
// shell (`StorePage`). One inline row of section tabs switches collections
// in-place; every tab shares the SAME toolbar + card/row (from
// `@ryu/blocks/desktop/library`) so the views are standardised rather than each
// collection having its own bespoke page.
//
// App-registered collections arrive from the same `contributes.sidebar_sections`
// declaration the sidebar reads (see `ContributedLibrarySection`), so an app
// ships ONE declaration and gets both surfaces. That is what keeps the sidebar
// from growing without bound as apps pile up: the Library is where a long list of
// collections belongs, and the sidebar can stay the short one.
//
// Two synthetic tabs sit in front: Recents (recently-opened, across all types,
// from the `library` store's stamp-on-open recents) and Favorites (items the
// user starred). Both resolve their stored `{type,id}` refs against the live
// data and silently drop any that no longer resolve (the item was deleted), so
// a stale ref never renders a blank card.
//
// The page is split under `components/library/page/`: the section model, one hook
// per data concern (collections, sidebar mirrors, counts, visible rows, CTA, item
// actions), the chrome, the collection body and the item dialogs.

import type { StoreSectionTab } from "@ryu/blocks/desktop/store.tsx";
import type {
	LibraryViewMode,
	ViewMode,
} from "@ryu/blocks/desktop/view-toggle.tsx";
import { useCallback, useEffect, useMemo, useState } from "react";
import { LibraryCollectionBody } from "@/src/components/library/page/library-collection-body.tsx";
import { LibraryItemDialogs } from "@/src/components/library/page/library-item-dialogs.tsx";
import { LibraryPageChrome } from "@/src/components/library/page/library-page-chrome.tsx";
import {
	type ActiveSection,
	CUSTOM_SURFACE_SECTIONS,
	contributedSectionValue,
	defaultLibraryView,
	isLibrarySection,
	LIBRARY_SHOWCASE_SECTIONS,
	LIBRARY_VIEW_MODES,
	type LibrarySection,
	SECTIONS,
	SIDEBAR_SURFACE_SECTIONS,
	type SidebarOnlySection,
} from "@/src/components/library/page/library-sections.ts";
import { useLibraryCardRenderers } from "@/src/components/library/page/use-library-card-renderers.tsx";
import { useLibraryCollectionItems } from "@/src/components/library/page/use-library-collection-items.ts";
import { useLibraryCounts } from "@/src/components/library/page/use-library-counts.ts";
import { useLibraryCta } from "@/src/components/library/page/use-library-cta.ts";
import { useLibraryItemActions } from "@/src/components/library/page/use-library-item-actions.ts";
import { useLibrarySidebarItems } from "@/src/components/library/page/use-library-sidebar-items.tsx";
import { useLibraryVisibleItems } from "@/src/components/library/page/use-library-visible-items.ts";
import { useLibraryVisibleSections } from "@/src/components/library/page/use-library-visible-sections.ts";
import { MemoryLibrary } from "@/src/components/memory/MemoryLibrary.tsx";
import { useSkillDistributionFlow } from "@/src/components/skills/SkillDistributionProvider.tsx";
import { CreateSpaceDialog } from "@/src/components/spaces/CreateSpaceDialog.tsx";
import { EngineDetailsDialog } from "@/src/components/store/EnginesCatalogSection.tsx";
import {
	TeamDialog,
	type TeamDraft,
} from "@/src/components/teams/TeamDialog.tsx";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { useSkillRelations } from "@/src/hooks/useSkillRelations.ts";
import { useTabViewMode } from "@/src/hooks/useTabViewMode.ts";
import {
	type LibraryItemType,
	useFavorites,
	useRecents,
} from "@/src/lib/library.ts";
import {
	getMarketplaceBackdrops,
	usePluginBackgrounds,
} from "@/src/lib/plugin-backgrounds.ts";
import { useInstalledWallpaperIds } from "@/src/lib/wallpaper-library.ts";
import { useCreateAgentDialog } from "@/src/store/useCreateAgentDialog.ts";

/**
 * Library entry point. The Memory section renders a bespoke management surface
 * (its items don't fit the shared card/grid machinery), so it's dispatched to
 * `MemoryLibrary` before the collection shell — keeping the collection hooks
 * below unconditional.
 */
export default function LibraryPage(props: { initialSection?: string }) {
	if (props.initialSection === "memory") {
		return <MemoryLibrary />;
	}
	return <LibraryCollections {...props} />;
}

function LibraryCollections({
	initialSection = "recents",
}: {
	initialSection?: string;
}) {
	const [engineDetailId, setEngineDetailId] = useState<string | null>(null);
	const [active, setActive] = useState<ActiveSection>(
		isLibrarySection(initialSection) || initialSection.startsWith("plugin:")
			? initialSection
			: "recents"
	);
	// Everything below the tab strip is written against the built-in collections;
	// an app-registered tab renders its own surface instead, so the built-in
	// pipeline runs on a harmless stand-in rather than being made nullable
	// throughout.
	const section: LibrarySection = isLibrarySection(active) ? active : "recents";
	const setSection = setActive;

	// View mode persists per Library section and session; query/sort reset per tab.
	const [storedView, onViewChange] = useTabViewMode({
		defaultMode: defaultLibraryView(section),
		storageKey: "ryu:library-view",
		tabKey: active,
		validModes: LIBRARY_VIEW_MODES,
	});
	const view: LibraryViewMode =
		storedView === "graph" && section !== "skills" ? "grid" : storedView;
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState("updated");
	// Type filter for the mixed tabs (Recents/Favorites); null = all.
	const [typeFilter, setTypeFilter] = useState<LibraryItemType | null>(null);

	// Reset the per-tab controls when switching collections.
	// `section` is load-bearing: it derives from in-component state driven by the
	// tab strip, not from the router, so the page does NOT remount per tab. Without
	// it the search query, sort and type filter leak across Library tabs.
	useEffect(() => {
		setQuery("");
		setSort("updated");
		setTypeFilter(null);
	}, [active]);

	const activateTab = useTabSelector((state) => state.activateTab);
	const openTab = useTabSelector((state) => state.openTab);
	const tabs = useTabSelector((state) => state.tabs);
	const pluginBackgrounds = usePluginBackgrounds();
	const marketplaceWallpapers = useMemo(
		() => getMarketplaceBackdrops(pluginBackgrounds),
		[pluginBackgrounds]
	);
	const installedWallpaperIds = useInstalledWallpaperIds();
	const installedWallpaperSet = useMemo(
		() => new Set(installedWallpaperIds),
		[installedWallpaperIds]
	);
	const installedWallpaperCount = marketplaceWallpapers.filter((wallpaper) =>
		installedWallpaperSet.has(wallpaper.id)
	).length;
	const { distributeInstalledSkill } = useSkillDistributionFlow();
	const { openCreateAgent } = useCreateAgentDialog();
	const { favorites, toggle: toggleFavorite } = useFavorites();
	const recents = useRecents();

	// Create-dialog state for the collections that need a name before they exist.
	const [spaceDialogOpen, setSpaceDialogOpen] = useState(false);
	const [teamDialogOpen, setTeamDialogOpen] = useState(false);
	const [editingTeamId, setEditingTeamId] = useState<string | null>(null);

	const openTeam = useCallback((id: string | null) => {
		setEditingTeamId(id);
		setTeamDialogOpen(true);
	}, []);

	// Data sources. Each collection's mutation handles ride beside its list because
	// the card's right-click menu offers rename/delete inline.
	const {
		agentItems,
		agents,
		agentsLoading,
		anySourceLoading,
		channelItems,
		channelsLoading,
		chatItems,
		conversations,
		conversationsLoading,
		createSpace,
		createTeam,
		favoriteItems,
		identitiesLoading,
		identityItems,
		itemsByType,
		loadingByType,
		meetingItems,
		meetingsLoading,
		recentItems,
		spaceItems,
		spaces,
		spacesLoading,
		teamItems,
		teams,
		updateTeam,
		workflowItems,
		workflowsLoading,
	} = useLibraryCollectionItems({ favorites, openTab, openTeam, recents });

	const {
		apps,
		appsLoading,
		companions,
		contributedSections,
		contributedSourceByValue,
		contributionsLoading,
		visibleSections,
	} = useLibraryVisibleSections();

	const {
		alongsideEnginesLoading,
		composioConnections,
		composioStatus,
		installedSkills,
		installedSkillsResult,
		localEnginesLoading,
		mcpLoading,
		removedProjects,
		sandboxBackendsLoading,
		sidebarItemsBySection,
		sidebarSectionLoading,
	} = useLibrarySidebarItems({
		activateTab,
		apps,
		appsLoading,
		chatItems,
		companions,
		contributionsLoading,
		conversations,
		conversationsLoading,
		distributeInstalledSkill,
		openTab,
		setEngineDetailId,
		tabs,
	});
	const skillRelationsEnabled = section === "skills" && view === "graph";
	const skillRelations = useSkillRelations({
		agents,
		enabled: skillRelationsEnabled,
	});

	const contributedFor = useCallback(
		(value: string) =>
			contributedSections.find((c) => contributedSectionValue(c) === value) ??
			null,
		[contributedSections]
	);
	const activeContributed = contributedFor(active);

	// If the active tab's app was just disabled (or its contribution withdrawn),
	// fall back to Recents so the page never sits on a now-hidden collection.
	useEffect(() => {
		const stillThere =
			visibleSections.some((s) => s.value === active) ||
			contributedSections.some((c) => contributedSectionValue(c) === active);
		if (!stillThere) {
			setSection("recents");
		}
	}, [visibleSections, contributedSections, active]);

	// Rename and delete are reached from a card's right-click menu; the dialogs live
	// ONCE on the page rather than per card.
	const actions = useLibraryItemActions();
	const { beginRename, setDeleteError, setDeleting } = actions;

	const { loading, mixedView, presentTypes, visibleItems } =
		useLibraryVisibleItems({
			anySourceLoading,
			favoriteItems,
			itemsByType,
			loadingByType,
			query,
			recentItems,
			section,
			sort,
			typeFilter,
		});

	const libraryCounts = useLibraryCounts({
		agentItems,
		agentsLoading,
		alongsideEnginesLoading,
		anySourceLoading,
		appsLoading,
		channelItems,
		channelsLoading,
		chatItems,
		composioConnections,
		composioStatus,
		contributionsLoading,
		conversationsLoading,
		favoriteItems,
		identitiesLoading,
		identityItems,
		installedSkillsResult,
		installedWallpaperCount,
		localEnginesLoading,
		mcpLoading,
		meetingItems,
		meetingsLoading,
		recentItems,
		removedProjects,
		sandboxBackendsLoading,
		sidebarItemsBySection,
		sidebarSectionLoading,
		spaceItems,
		spacesLoading,
		teamItems,
		workflowItems,
		workflowsLoading,
	});

	// The tab strip is a projection of the same data that renders each collection.
	// Counts are collection totals, never the result of the active search field.
	const navSections = useMemo<StoreSectionTab[]>(() => {
		const own = visibleSections.map((item) => ({
			count: libraryCounts[item.value],
			group: "own",
			icon: item.icon,
			label: item.label,
			value: item.value,
		}));
		const apps = contributedSections.map((item) => {
			const sourceData = contributedSourceByValue.get(
				contributedSectionValue(item)
			);
			return {
				count: sourceData?.total ?? undefined,
				group: "apps",
				icon: item.icon ?? "package-01",
				label: item.title,
				value: contributedSectionValue(item),
			};
		});
		return [...own, ...apps];
	}, [
		contributedSections,
		contributedSourceByValue,
		libraryCounts,
		visibleSections,
	]);

	const { cta, emptyAction } = useLibraryCta({
		openCreateAgent,
		openTab,
		openTeam,
		query,
		section,
		setQuery,
		setSpaceDialogOpen,
	});

	const { menuFor, toCardData } = useLibraryCardRenderers({
		beginRename,
		favorites,
		mixedView,
		setDeleteError,
		setDeleting,
		toggleFavorite,
		view,
	});

	const sectionMeta = SECTIONS.find((s) => s.value === section);

	const editingTeam = teams.find((t) => t.id === editingTeamId) ?? null;
	const handleTeamSubmit = async (draft: TeamDraft) => {
		if (editingTeam) {
			await updateTeam(editingTeam.id, draft);
		} else {
			await createTeam(draft);
		}
	};

	// A custom-surface section (Tools) brings its own search, filters and empty
	// states, so the shell's search box and collection toolbar are omitted rather
	// than rendered dead beside them — two search fields on one screen is the exact
	// kind of duplication that made this area feel bolted together.
	const customSurface = CUSTOM_SURFACE_SECTIONS.has(section);
	const collectionView: ViewMode =
		view === "list" ? "list" : view === "showcase" ? "showcase" : "grid";
	const standardView: ViewMode = view === "list" ? "list" : "grid";
	const showShowcase = LIBRARY_SHOWCASE_SECTIONS.has(section);

	// Neither a built-in collection's controls nor the shell's search apply to a
	// surface that owns its own (Tools) or to an app-registered collection, which
	// declares its rows and gets the shared search only.
	const showCollectionToolbar = !(customSurface || activeContributed);
	// SAFETY: The section remains its native string value for Set membership; the cast only bridges the private literal-key Set.has parameter and does not claim membership before this check.
	const sidebarSurface = SIDEBAR_SURFACE_SECTIONS.has(
		section as SidebarOnlySection
	);
	// SAFETY: The preceding private SIDEBAR_SURFACE_SECTIONS check admits exactly authored sidebar keys, and this true branch indexes the complete native sidebarItemsBySection record.
	const sidebarItems = sidebarSurface
		? sidebarItemsBySection[section as SidebarOnlySection]
		: [];

	return (
		<div className="flex h-full flex-col overflow-hidden">
			{/* Page chrome, inline and in the order it works: the library-wide search
			    (with the collection's own controls beside it), then the tabs. No
			    floating bar — the tab list is open-ended (every app may register a
			    collection), so it scrolls in the page flow.

			    There is no section TITLE. It restated the pill that was already
			    active directly beneath it. The search is above the tabs and searches
			    everything, mirroring the Store; the collection's sort/view/filter
			    controls ride the same row, so the page opens with one row of chrome
			    instead of three. */}
			<LibraryPageChrome
				active={active}
				cta={cta}
				customSurface={customSurface}
				mixedView={mixedView}
				navSections={navSections}
				onViewChange={onViewChange}
				presentTypes={presentTypes}
				query={query}
				section={section}
				setActive={setActive}
				setQuery={setQuery}
				setSort={setSort}
				setTypeFilter={setTypeFilter}
				showCollectionToolbar={showCollectionToolbar}
				showShowcase={showShowcase}
				sort={sort}
				typeFilter={typeFilter}
				view={view}
			/>

			<LibraryCollectionBody
				activeContributed={activeContributed}
				agents={agents}
				collectionView={collectionView}
				contributedSourceByValue={contributedSourceByValue}
				customSurface={customSurface}
				emptyAction={emptyAction}
				favorites={favorites}
				installedSkills={installedSkills}
				installedSkillsResult={installedSkillsResult}
				loading={loading}
				menuFor={menuFor}
				openTab={openTab}
				query={query}
				section={section}
				sectionMeta={sectionMeta}
				sidebarItems={sidebarItems}
				sidebarSectionLoading={sidebarSectionLoading}
				sidebarSurface={sidebarSurface}
				skillRelations={skillRelations}
				skillRelationsEnabled={skillRelationsEnabled}
				spaces={spaces}
				standardView={standardView}
				toCardData={toCardData}
				toggleFavorite={toggleFavorite}
				view={view}
				visibleItems={visibleItems}
			/>

			{engineDetailId ? (
				<EngineDetailsDialog
					engineId={engineDetailId}
					key={engineDetailId}
					onClose={() => setEngineDetailId(null)}
				/>
			) : null}
			<CreateSpaceDialog
				onClose={() => setSpaceDialogOpen(false)}
				onCreate={createSpace}
				open={spaceDialogOpen}
			/>
			<TeamDialog
				agents={agents}
				onClose={() => setTeamDialogOpen(false)}
				onSubmit={handleTeamSubmit}
				open={teamDialogOpen}
				team={editingTeam}
			/>

			<LibraryItemDialogs actions={actions} />
		</div>
	);
}
