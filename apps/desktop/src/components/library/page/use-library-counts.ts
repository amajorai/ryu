import { useMemo } from "react";
import type { SidebarLibraryItem } from "@/src/components/library/SidebarLibrarySection.tsx";
import type {
	LibraryItem,
	LibrarySection,
	SidebarOnlySection,
} from "./library-sections.ts";

/** Each Library tab's collection total for the tab strip, or `undefined` while
 *  that collection is still loading. Never the result of the search field. */
export function useLibraryCounts({
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
}: {
	agentItems: LibraryItem[];
	agentsLoading: boolean;
	alongsideEnginesLoading: boolean;
	anySourceLoading: boolean;
	appsLoading: boolean;
	channelItems: LibraryItem[];
	channelsLoading: boolean;
	chatItems: LibraryItem[];
	composioConnections: { isLoading: boolean };
	composioStatus: { isLoading: boolean };
	contributionsLoading: boolean;
	conversationsLoading: boolean;
	favoriteItems: LibraryItem[];
	identitiesLoading: boolean;
	identityItems: LibraryItem[];
	installedSkillsResult: { isLoading: boolean };
	installedWallpaperCount: number;
	localEnginesLoading: boolean;
	mcpLoading: boolean;
	meetingItems: LibraryItem[];
	meetingsLoading: boolean;
	recentItems: LibraryItem[];
	removedProjects: readonly string[];
	sandboxBackendsLoading: boolean;
	sidebarItemsBySection: Record<SidebarOnlySection, SidebarLibraryItem[]>;
	sidebarSectionLoading: Record<SidebarOnlySection, boolean>;
	spaceItems: LibraryItem[];
	spacesLoading: boolean;
	teamItems: LibraryItem[];
	workflowItems: LibraryItem[];
	workflowsLoading: boolean;
}) {
	return useMemo<Record<LibrarySection, number | undefined>>(
		() => ({
			agent: agentsLoading ? undefined : agentItems.length,
			archived: sidebarSectionLoading.archived
				? undefined
				: sidebarItemsBySection.archived.length,
			channel: channelsLoading ? undefined : channelItems.length,
			chat: conversationsLoading ? undefined : chatItems.length,
			companions: sidebarSectionLoading.companions
				? undefined
				: sidebarItemsBySection.companions.length,
			engines: sidebarSectionLoading.engines
				? undefined
				: sidebarItemsBySection.engines.length,
			favorites: anySourceLoading ? undefined : favoriteItems.length,
			identity: identitiesLoading ? undefined : identityItems.length,
			integrations: sidebarSectionLoading.integrations
				? undefined
				: sidebarItemsBySection.integrations.length,
			mcp: sidebarSectionLoading.mcp
				? undefined
				: sidebarItemsBySection.mcp.length,
			meeting: meetingsLoading ? undefined : meetingItems.length,
			pinned: sidebarSectionLoading.pinned
				? undefined
				: sidebarItemsBySection.pinned.length,
			plugins: sidebarSectionLoading.plugins
				? undefined
				: sidebarItemsBySection.plugins.length,
			projects: sidebarItemsBySection.projects.length,
			recents: anySourceLoading ? undefined : recentItems.length,
			skills: sidebarSectionLoading.skills
				? undefined
				: sidebarItemsBySection.skills.length,
			space: spacesLoading ? undefined : spaceItems.length,
			tabs: sidebarItemsBySection.tabs.length,
			team: teamItems.length,
			tools: sidebarSectionLoading.tools
				? undefined
				: sidebarItemsBySection.tools.length,
			wallpapers: installedWallpaperCount,
			workflow: workflowsLoading ? undefined : workflowItems.length,
		}),
		[
			agentItems.length,
			agentsLoading,
			anySourceLoading,
			channelItems.length,
			channelsLoading,
			chatItems.length,
			composioConnections.isLoading,
			composioStatus.isLoading,
			contributionsLoading,
			favoriteItems.length,
			identityItems.length,
			identitiesLoading,
			installedWallpaperCount,
			installedSkillsResult.isLoading,
			localEnginesLoading,
			alongsideEnginesLoading,
			mcpLoading,
			meetingItems.length,
			meetingsLoading,
			recentItems.length,
			removedProjects,
			sandboxBackendsLoading,
			spaceItems.length,
			spacesLoading,
			teamItems.length,
			workflowItems.length,
			workflowsLoading,
			sidebarItemsBySection,
			appsLoading,
			conversationsLoading,
		]
	);

	// The tab strip is a projection of the same data that renders each collection.
}
