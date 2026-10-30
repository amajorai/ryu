import { LibraryIcon } from "@hugeicons/core-free-icons";
import {
	FavoriteStar,
	LibraryCard,
	type LibraryCardData,
	LibraryEmpty,
	LibraryGrid,
	LibraryLoading,
} from "@ryu/blocks/desktop/library.tsx";
import type {
	LibraryViewMode,
	ViewMode,
} from "@ryu/blocks/desktop/view-toggle.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { AgentBadgeCard } from "@/src/components/agents/AgentBadgeCard.tsx";
import { AgentUpdateControl } from "@/src/components/agents/AgentUpdateControl.tsx";
import { SECTION_ICONS } from "@/src/components/layout/sidebar-sections.ts";
import ContributedLibrarySection from "@/src/components/library/ContributedLibrarySection.tsx";
import SidebarLibrarySection, {
	type SidebarLibraryItem,
} from "@/src/components/library/SidebarLibrarySection.tsx";
import SkillRelationsGraph from "@/src/components/library/SkillRelationsGraph.tsx";
import { SpaceProjectFolder } from "@/src/components/library/SpaceProjectFolder.tsx";
import ToolsLibrary from "@/src/components/tools/ToolsLibrary.tsx";
import { WallpaperCatalogSection } from "@/src/components/wallpaper/WallpaperCatalogSection.tsx";
import type { useSpacesContext } from "@/src/contexts/SpacesContext.tsx";
import type { useAgents } from "@/src/hooks/useAgents.ts";
import type { SidebarSectionSourceData } from "@/src/hooks/useSidebarSectionSource.ts";
import type { useSkillRelations } from "@/src/hooks/useSkillRelations.ts";
import type { PluginSidebarSection } from "@/src/lib/api/plugins.ts";
import type { InstalledSkill } from "@/src/lib/api/skills.ts";
import {
	type LibraryItemType,
	type LibraryRef,
	refKey,
} from "@/src/lib/library.ts";
import { LIBRARY_EMPTY_COPY } from "./library-empty-copy.ts";
import {
	contributedSectionValue,
	type LibraryItem,
	type LibrarySection,
	type SECTIONS,
	type SidebarOnlySection,
} from "./library-sections.ts";
import type { LibraryTabsValue } from "./library-tabs.ts";

/** Everything below the Library chrome: a custom surface (Tools, Wallpapers), an
 *  app-registered collection, the skill graph, a sidebar-mirror section, or the
 *  active collection's cards with its loading and empty states. */
export function LibraryCollectionBody({
	activeContributed,
	agents,
	collectionView,
	contributedSourceByValue,
	customSurface,
	emptyAction,
	favorites,
	installedSkills,
	installedSkillsResult,
	loading,
	menuFor,
	openTab,
	query,
	section,
	sectionMeta,
	sidebarItems,
	sidebarSectionLoading,
	sidebarSurface,
	skillRelations,
	skillRelationsEnabled,
	spaces,
	standardView,
	toCardData,
	toggleFavorite,
	view,
	visibleItems,
}: {
	activeContributed: PluginSidebarSection | null;
	agents: ReturnType<typeof useAgents>["agents"];
	collectionView: ViewMode;
	contributedSourceByValue: Map<string, SidebarSectionSourceData>;
	customSurface: boolean;
	emptyAction: { label: string; onCta: () => void } | null;
	favorites: LibraryRef[];
	installedSkills: InstalledSkill[];
	installedSkillsResult: UseQueryResult<InstalledSkill[]>;
	loading: boolean;
	menuFor: (item: LibraryItem) => ReactNode;
	openTab: LibraryTabsValue["openTab"];
	query: string;
	section: LibrarySection;
	sectionMeta: (typeof SECTIONS)[number] | undefined;
	sidebarItems: SidebarLibraryItem[];
	sidebarSectionLoading: Record<SidebarOnlySection, boolean>;
	sidebarSurface: boolean;
	skillRelations: ReturnType<typeof useSkillRelations>;
	skillRelationsEnabled: boolean;
	spaces: ReturnType<typeof useSpacesContext>["spaces"];
	standardView: ViewMode;
	toCardData: (item: LibraryItem) => LibraryCardData;
	toggleFavorite: (type: LibraryItemType, id: string) => void;
	view: LibraryViewMode;
	visibleItems: LibraryItem[];
}) {
	const tl = useLiteralMessages();
	return (
		<>
			{/* A custom-surface section fills the shell itself: it is a full-height
			    master/detail layout with its own scroll containers, so it must NOT be
			    nested inside the centered, scrolling card column below. */}
			{customSurface ? (
				<div className="min-h-0 flex-1 overflow-hidden">
					{section === "tools" ? <ToolsLibrary /> : null}
					{section === "wallpapers" ? (
						<WallpaperCatalogSection
							mode="library"
							onBrowseMarketplace={() =>
								openTab("/marketplace/wallpapers", { title: "Wallpapers" })
							}
						/>
					) : null}
				</div>
			) : (
				/* Centered, capped-width column mirroring the Store catalog layout —
			    the cards read as the same 2-column grid rather than a full-bleed
			    wall. */
				<div className="scroll-fade min-h-0 flex-1 overflow-y-auto px-4 pt-2 pb-24">
					<div className="mx-auto w-full max-w-4xl">
						{activeContributed ? (
							<ContributedLibrarySection
								query={query}
								section={activeContributed}
								sourceData={
									contributedSourceByValue.get(
										contributedSectionValue(activeContributed)
									) ?? {
										contribution: activeContributed,
										error: null,
										isLoading: true,
										rows: [],
										total: null,
									}
								}
								view={standardView}
							/>
						) : skillRelationsEnabled ? (
							<SkillRelationsGraph
								agents={skillRelations.agents}
								error={installedSkillsResult.isError}
								loading={
									installedSkillsResult.isLoading || skillRelations.loading
								}
								onOpenCatalog={() =>
									openTab("/store/skills", { title: "Skills" })
								}
								onRetry={() => {
									installedSkillsResult.refetch().catch(() => undefined);
								}}
								query={query}
								skills={installedSkills}
								usage={skillRelations.usage}
								usageAvailable={skillRelations.usageAvailable}
							/>
						) : sidebarSurface ? (
							<SidebarLibrarySection
								icon={sectionMeta?.icon ?? SECTION_ICONS.companions}
								items={sidebarItems}
								label={sectionMeta?.label ?? "Library"}
								loading={
									// SAFETY: This JSX branch is selected only by the same private sidebarSurface membership check; sidebarSectionLoading satisfies the complete native SidebarOnlySection boolean record.
									sidebarSectionLoading[section as SidebarOnlySection]
								}
								query={query}
								variant={section === "skills" ? "books" : "cards"}
								view={collectionView}
							/>
						) : loading ? (
							<LibraryLoading />
						) : visibleItems.length === 0 ? (
							<LibraryEmpty
								action={
									emptyAction ? (
										<Button
											onClick={emptyAction.onCta}
											size="sm"
											variant="outline"
										>
											{emptyAction.label}
										</Button>
									) : null
								}
								description={
									query
										? "Nothing matches your search."
										: LIBRARY_EMPTY_COPY[section]
								}
								icon={sectionMeta?.icon ?? LibraryIcon}
								title={
									query
										? "No results"
										: sectionMeta
											? tl("No {label} yet", {
													label: sectionMeta.label.toLowerCase(),
												})
											: tl("No items yet")
								}
							/>
						) : section === "space" && view === "showcase" ? (
							<div className="flex flex-wrap gap-6 pt-1">
								{visibleItems.flatMap((item) => {
									const space = spaces.find(
										(candidate) => candidate.id === item.id
									);
									if (!space) {
										return [];
									}
									return (
										<SpaceProjectFolder
											contextMenu={menuFor(item)}
											favorited={favorites.some(
												(f) => f.type === item.type && f.id === item.id
											)}
											key={refKey(item.type, item.id)}
											onToggleFavorite={() =>
												toggleFavorite(item.type, item.id)
											}
											space={space}
										/>
									);
								})}
							</div>
						) : section === "agent" && view === "showcase" ? (
							/* An agent gets the card it already has everywhere else: the
							   employee badge, the same physical object its profile page and
							   the Store's Agents tab show. Gated on the SECTION exactly like
							   the shelf above — an agent surfacing in Recents/Favorites stays
							   a card among cards, because those tabs mix types (a 27rem badge
							   beside a 5rem chat card reads as a broken grid) and Recents is
							   the tab the app lands on. */
							<LibraryGrid columns={2} view="grid">
								{visibleItems.map((item) => (
									<AgentBadgeCard
										action={
											<FavoriteStar
												favorited={favorites.some(
													(f) => f.type === item.type && f.id === item.id
												)}
												onToggle={() => toggleFavorite(item.type, item.id)}
											/>
										}
										contextMenu={menuFor(item)}
										employeeId={item.id}
										footer={
											<>
												{item.badge ? (
													<Badge variant="outline">{item.badge}</Badge>
												) : null}
												{/* Per-agent runtime version + in-place update (Core
												    /api/agents/:id/update-check). Renders nothing for an
												    agent with no versioned runtime. */}
												<AgentUpdateControl agentId={item.id} />
											</>
										}
										// The badge prints "Hired …", and an agent's creation is
										// exactly that date; the card carries it and the list row
										// never did.
										hiredAt={
											agents.find((a) => a.id === item.id)?.createdAt ??
											undefined
										}
										key={refKey(item.type, item.id)}
										name={item.name}
										onOpen={item.open}
										role={item.subtitle}
									/>
								))}
							</LibraryGrid>
						) : (
							<LibraryGrid columns={2} view={standardView}>
								{visibleItems.map((item) => (
									<LibraryCard
										contextMenu={menuFor(item)}
										item={toCardData(item)}
										key={refKey(item.type, item.id)}
										onOpen={item.open}
										onToggleFavorite={() => toggleFavorite(item.type, item.id)}
										view={standardView}
									/>
								))}
							</LibraryGrid>
						)}
					</div>
				</div>
			)}
		</>
	);
}
