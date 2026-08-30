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

import {
	Add01Icon,
	AudioWave01Icon,
	Clock01Icon,
	ConnectIcon,
	DeliverySecure01Icon,
	FolderOpenIcon,
	GridIcon,
	LibraryIcon,
	ServerStack01Icon,
	StarIcon,
	Target01Icon,
	UserMultiple02Icon,
	WorkflowCircle06Icon,
	Wrench01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import {
	FavoriteStar,
	LibraryCard,
	type LibraryCardData,
	LibraryEmpty,
	LibraryFilterChip,
	LibraryGrid,
	LibraryLoading,
	type LibrarySortOption,
	LibraryToolbar,
} from "@ryu/blocks/desktop/library.tsx";
import {
	StoreGlobalSearch,
	type StoreSectionTab,
	StoreSectionTabs,
} from "@ryu/blocks/desktop/store.tsx";
import type {
	LibraryViewMode,
	ViewMode,
} from "@ryu/blocks/desktop/view-toggle.tsx";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import {
	StatusBadge,
	type StatusKind,
} from "@ryu/ui/components/status-badge.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { useQuery } from "@tanstack/react-query";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import { AgentBadgeCard } from "@/src/components/agents/AgentBadgeCard.tsx";
import {
	LibraryItemMenuContent,
	useLibraryContributedRows,
} from "@/src/components/layout/library-entity-menu.tsx";
import {
	BUILTIN_SECTIONS,
	type BuiltinSectionKey,
	SECTION_ICONS,
	SURFACE_PLUGIN_OWNER,
} from "@/src/components/layout/sidebar-sections.ts";
import ContributedLibrarySection from "@/src/components/library/ContributedLibrarySection.tsx";
import SidebarLibrarySection, {
	type SidebarLibraryItem,
} from "@/src/components/library/SidebarLibrarySection.tsx";
import SkillRelationsGraph from "@/src/components/library/SkillRelationsGraph.tsx";
import { SpaceProjectFolder } from "@/src/components/library/SpaceProjectFolder.tsx";
import { MemoryLibrary } from "@/src/components/memory/MemoryLibrary.tsx";
import { useSkillDistributionFlow } from "@/src/components/skills/SkillDistributionProvider.tsx";
import { CreateSpaceDialog } from "@/src/components/spaces/CreateSpaceDialog.tsx";
import {
	TeamDialog,
	type TeamDraft,
} from "@/src/components/teams/TeamDialog.tsx";
import ToolsLibrary from "@/src/components/tools/ToolsLibrary.tsx";
import { DestructiveConfirmDialog } from "@/src/components/ui/DestructiveConfirmDialog.tsx";
import { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import { useSpacesContext } from "@/src/contexts/SpacesContext.tsx";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import { useCompanionAlias } from "@/src/contributions/use-companion-alias.ts";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAgents } from "@/src/hooks/useAgents.ts";
import { useApps } from "@/src/hooks/useApps.ts";
import { useChannels } from "@/src/hooks/useChannels.ts";
import {
	useComposioConnections,
	useComposioStatus,
} from "@/src/hooks/useComposioCatalog.ts";
import { useEngines } from "@/src/hooks/useEngines.ts";
import { useCanManagePermission } from "@/src/hooks/useGatewayConfigurable.ts";
import { useIdentities } from "@/src/hooks/useIdentities.ts";
import { useMcp } from "@/src/hooks/useMcp.ts";
import { useMeetings } from "@/src/hooks/useMeetings.ts";
import {
	pluginCompanionPath,
	usePluginContributions,
	usePluginContributionsQuery,
} from "@/src/hooks/usePluginContributions.ts";
import { useSandboxBackends } from "@/src/hooks/useSandboxBackends.ts";
import { useSidebarSectionSources } from "@/src/hooks/useSidebarSectionSource.ts";
import { useSkillRelations } from "@/src/hooks/useSkillRelations.ts";
import { installedSkillsQuery } from "@/src/hooks/useSkillsCatalog.ts";
import { useTabViewMode } from "@/src/hooks/useTabViewMode.ts";
import { useTeams } from "@/src/hooks/useTeams.ts";
import { useVoiceEngines } from "@/src/hooks/useVoiceEngines.ts";
import { useWorkflows } from "@/src/hooks/useWorkflows.ts";
import { CHANNEL_LABELS } from "@/src/lib/api/channels.ts";
import type { PluginSidebarSection } from "@/src/lib/api/plugins.ts";
import type { InstalledSkill } from "@/src/lib/api/skills.ts";
import { basename } from "@/src/lib/files.ts";
import { dedupeFolders, folderKey } from "@/src/lib/folder-path.ts";
import {
	type LibraryItemType,
	normalizeTimestamp,
	refKey,
	stampRecent,
	useFavorites,
	useRecents,
} from "@/src/lib/library.ts";
import { WorkflowFlowStrip } from "@/src/lib/workflow-triggers.tsx";
import {
	findWorkspaceProject,
	workspaceProjectName,
} from "@/src/lib/workspace-projects.ts";
import { useConversationFlagsStore } from "@/src/store/useConversationFlagsStore.ts";
import { useCreateAgentDialog } from "@/src/store/useCreateAgentDialog.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";

/** A Library tab.
 *
 *  Most tabs are collections of `LibraryItem`s rendered by the shared card/grid
 *  machinery. `"tools"` is not: the MCP servers on the node and the tools they
 *  advertise have their own hierarchy (a tool belongs to a server) and their own
 *  actions (test-call a tool), so it renders a bespoke surface inside the Library
 *  shell — the same escape hatch `"memory"` already uses. */
type SidebarOnlySection = Exclude<
	BuiltinSectionKey,
	"agents" | "teams" | "chats" | "spaces" | "channels" | "identities"
>;

const LIBRARY_ITEM_TYPE_BY_BUILTIN_KEY: Partial<
	Record<BuiltinSectionKey, LibraryItemType>
> = {
	agents: "agent",
	chats: "chat",
	channels: "channel",
	identities: "identity",
	spaces: "space",
};

function isSidebarOnlySectionKey(
	key: BuiltinSectionKey
): key is SidebarOnlySection {
	return LIBRARY_ITEM_TYPE_BY_BUILTIN_KEY[key] === undefined;
}

type BuiltinSection = (typeof BUILTIN_SECTIONS)[number];
function isSidebarOnlySection(
	section: BuiltinSection
): section is BuiltinSection & { key: SidebarOnlySection } {
	return isSidebarOnlySectionKey(section.key);
}

const SIDEBAR_LIBRARY_SECTIONS = BUILTIN_SECTIONS.filter(isSidebarOnlySection);

type LibrarySection =
	| "recents"
	| "favorites"
	| "tools"
	| LibraryItemType
	| SidebarOnlySection;

/** Collections whose existing cards carry a richer, playful presentation. */
const LIBRARY_SHOWCASE_SECTIONS: ReadonlySet<LibrarySection> = new Set([
	"agent",
	"space",
	"skills",
	"workflow",
]);

const LIBRARY_VIEW_MODES: readonly LibraryViewMode[] = [
	"grid",
	"list",
	"showcase",
	"graph",
];

function defaultLibraryView(section: LibrarySection): LibraryViewMode {
	return LIBRARY_SHOWCASE_SECTIONS.has(section) ? "showcase" : "grid";
}

/** Sections that render their OWN surface instead of the shared card grid, and so
 *  bypass the collection pipeline (normalise → filter → sort → cards). They keep
 *  the section nav so switching tabs still works. */
const CUSTOM_SURFACE_SECTIONS = new Set<LibrarySection>(["tools"]);

const SIDEBAR_SURFACE_SECTIONS = new Set<SidebarOnlySection>(
	SIDEBAR_LIBRARY_SECTIONS.map((section) => section.key)
);

const SECTIONS: {
	value: LibrarySection;
	label: string;
	icon: IconSvgElement;
}[] = [
	{ value: "recents", label: "Recents", icon: Clock01Icon },
	{ value: "favorites", label: "Favorites", icon: StarIcon },
	...BUILTIN_SECTIONS.map((section) => ({
		icon: section.icon,
		label: section.label,
		value:
			LIBRARY_ITEM_TYPE_BY_BUILTIN_KEY[section.key] ??
			(section.key as SidebarOnlySection),
	})),
	// Meetings are a Library collection but intentionally are not a fixed sidebar
	// section: the Meetings app contributes its own dynamic sidebar section. Keep
	// the existing built-in collection available until that app is the source of
	// truth, while still letting a source-backed contribution replace it above.
	{ value: "meeting", label: "Meetings", icon: AudioWave01Icon },
];

/** The app that owns each built-in collection. A tab shows only when its owning
 *  app is enabled — so an uninstalled Workflows/Teams/Meetings app leaves no empty
 *  tab. Sections absent here (recents/favorites/chat/channel/identity) are host
 *  surfaces, always shown.
 *
 *  The plugin ids come from `SURFACE_PLUGIN_OWNER` — the ONE table naming which
 *  app owns each compiled-in surface, shared with the sidebar. This map only says
 *  which library TYPE maps onto which surface. */
const SECTION_PLUGIN: Partial<Record<LibrarySection, string>> = {
	agent: SURFACE_PLUGIN_OWNER.agents,
	workflow: SURFACE_PLUGIN_OWNER.workflows,
	space: SURFACE_PLUGIN_OWNER.spaces,
	team: SURFACE_PLUGIN_OWNER.teams,
	meeting: SURFACE_PLUGIN_OWNER.meetings,
};

/** Per-type display metadata for the synthetic (mixed) tabs and filter chips. */
const TYPE_META: Record<
	LibraryItemType,
	{ label: string; icon: IconSvgElement }
> = {
	agent: { label: "Agent", icon: Target01Icon },
	workflow: { label: "Workflow", icon: WorkflowCircle06Icon },
	chat: { label: "Chat", icon: SECTION_ICONS.chats },
	space: { label: "Space", icon: DeliverySecure01Icon },
	team: { label: "Group", icon: UserMultiple02Icon },
	meeting: { label: "Meeting", icon: AudioWave01Icon },
	channel: { label: "Channel", icon: SECTION_ICONS.channels },
	identity: { label: "Identity", icon: SECTION_ICONS.identities },
};

const SORT_OPTIONS: LibrarySortOption[] = [
	{ value: "updated", label: "Recently updated" },
	{ value: "name-asc", label: "Name A–Z" },
	{ value: "name-desc", label: "Name Z–A" },
];

/** A collection item normalised from its data hook into one shared shape. */
interface LibraryItem {
	/** Type-specific chip for typed tabs — a KIND or a type-specific label. On the
	 *  mixed tabs the item's TYPE takes this slot instead. */
	badge: string | null;
	icon: IconSvgElement;
	id: string;
	name: string;
	open: () => void;
	/** The same destination forced into a NEW tab, for the card's right-click
	 *  menu. Absent for the types that open a dialog rather than a route (teams),
	 *  where "in a new tab" has no meaning. */
	openInNewTab?: () => void;
	/** Optional richer card-body preview (grid view only). Local, cheap nodes
	 * only — anything that fetches must be gated per-tab in `toCardData`. */
	preview?: ReactNode;
	/** Delete this item. Every collection's hook exposes one, so this is set for
	 *  all of them; a per-ITEM refusal travels in `removeBlockedReason`. */
	remove?: () => Promise<unknown> | unknown;
	/** Why THIS item can't be deleted (a Ryu-owned system Space). */
	removeBlockedReason?: string;
	/** Persist a new name. Absent for the types whose hook exposes no rename —
	 *  the menu then omits the row rather than offering a dead one. */
	rename?: (title: string) => Promise<unknown> | unknown;
	/** The item's STATUS attribute, if it has one. A separate slot from `badge`
	 *  because the mixed tabs claim that one for the type label, and an agent can
	 *  be both an "Agent" and "Built-in". */
	status?: StatusKind | null;
	subtitle: string | null;
	type: LibraryItemType;
	/** Normalised epoch-ms, for "Recently updated" sort. */
	updatedAt: number;
}

function isLibrarySection(value: string): value is LibrarySection {
	return SECTIONS.some((s) => s.value === value);
}

/** The tab key of an app-registered collection, namespaced exactly like the
 *  sidebar's dynamic section keys so the two can never collide with a built-in. */
function contributedSectionValue(section: PluginSidebarSection): string {
	return `plugin:${section.plugin}:${section.id}`;
}

/** The active tab: one of the shell's own collections, or an app-registered one
 *  (`plugin:<pluginId>:<sectionId>`). Deliberately open — the Library's tab list
 *  is no longer a closed union the shell can enumerate at compile time. */
type ActiveSection = LibrarySection | string;

/** True for the sections that ARE a `LibraryItemType` — i.e. the ones backed by the
 *  shared collection pipeline. Excludes the synthetic mixed tabs and any
 *  custom-surface section (which has no `LibraryItem` representation at all, so it
 *  must never be offered as a type filter chip). */
function isItemType(value: LibrarySection): value is LibraryItemType {
	return (
		value === "agent" ||
		value === "workflow" ||
		value === "chat" ||
		value === "space" ||
		value === "team" ||
		value === "meeting" ||
		value === "channel" ||
		value === "identity"
	);
}

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
	}, [section]);

	const { activateTab, openTab, tabs } = useTabsContext();
	const { distributeInstalledSkill } = useSkillDistributionFlow();
	const { openCreateAgent } = useCreateAgentDialog();
	const { favorites, toggle: toggleFavorite } = useFavorites();
	const recents = useRecents();

	// Data sources. Each collection's mutation handles are destructured beside its
	// list because the card's right-click menu offers rename/delete inline — the
	// Library is a browsing surface, and making the user leave it to find the
	// sidebar row that owns those verbs was the whole gap.
	const {
		agents,
		engines,
		loading: agentsLoading,
		remove: removeAgent,
	} = useAgents();
	const {
		workflows,
		loading: workflowsLoading,
		remove: removeWorkflow,
	} = useWorkflows();
	const {
		teams,
		create: createTeam,
		remove: removeTeam,
		update: updateTeam,
	} = useTeams();
	const {
		meetings,
		loading: meetingsLoading,
		remove: removeMeeting,
		rename: renameMeeting,
	} = useMeetings();
	const {
		spaces,
		loading: spacesLoading,
		create: createSpace,
		remove: removeSpace,
	} = useSpacesContext();
	const {
		conversations,
		conversationsLoading,
		deleteConversation,
		renameConversation,
	} = useChatHistoryContext();
	const {
		channels,
		loading: channelsLoading,
		remove: removeChannel,
		update: updateChannel,
	} = useChannels();
	const {
		profiles,
		loading: identitiesLoading,
		remove: removeIdentity,
	} = useIdentities();
	const canDeleteAgents = useCanManagePermission("agent.delete");
	const canDeleteSpaces = useCanManagePermission("space.delete");

	// Only show a collection tab when its owning app is enabled — an uninstalled
	// Workflows/Teams/Meetings app should leave no empty tab. Host surfaces
	// (recents/favorites/chat/channel/identity) have no owner and always show.
	const { apps, loading: appsLoading } = useApps();
	const enabledPlugins = useMemo(
		() => new Set(apps.filter((a) => a.enabled).map((a) => a.id)),
		[apps]
	);
	// While the app list is still loading, show every tab — gating on an empty set
	// would flash the pre-installed collections (Agents/Spaces/Teams) off then on.
	const appVisibleSections = useMemo(
		() =>
			appsLoading
				? SECTIONS
				: SECTIONS.filter((s) => {
						const plugin = SECTION_PLUGIN[s.value];
						return !plugin || enabledPlugins.has(plugin);
					}),
		[enabledPlugins, appsLoading]
	);

	// App-registered collections, from the same `sidebar_sections` declaration the
	// sidebar renders. Core serves these only for ENABLED apps, so no gate is
	// needed here. A section owned by an app that also owns a built-in tab is
	// skipped: @ryu/meetings ships both, and two tabs called "Meetings" listing the
	// same rows is worse than either alone.
	const { isLoading: contributionsLoading } = usePluginContributionsQuery();
	const { companions, sidebar_sections } = usePluginContributions();
	const contributedSections = useMemo(
		() =>
			[...sidebar_sections].sort(
				(a, b) =>
					(a.order ?? 0) - (b.order ?? 0) || a.title.localeCompare(b.title)
			),
		[sidebar_sections]
	);
	const contributedSourceData = useSidebarSectionSources(contributedSections);
	const contributedSourceByValue = useMemo(
		() =>
			new Map(
				contributedSourceData.map((data) => [
					contributedSectionValue(data.contribution),
					data,
				])
			),
		[contributedSourceData]
	);

	// If an app owns one of the compiled-in surfaces and also contributes its
	// sidebar section, the source-backed app section is the Library tab. This
	// keeps Meetings/Workflows/etc. from appearing twice while still allowing any
	// other app-registered section to arrive automatically.
	const visibleSections = useMemo(
		() =>
			appVisibleSections.filter((section) => {
				const owner = SECTION_PLUGIN[section.value];
				return !(
					owner &&
					contributedSections.some(
						(c) => c.plugin === owner && Boolean(c.spec?.source)
					)
				);
			}),
		[appVisibleSections, contributedSections]
	);

	// The remaining Library collections mirror the sidebar's built-in registry. They
	// deliberately consume the same host hooks as the sidebar, so adding a sidebar
	// section is a data decision in one place rather than a second page-specific API.
	const activeNode = useActiveNode();
	const installedSkillsResult = useQuery(
		installedSkillsQuery({
			token: activeNode.token ?? null,
			userJwt: activeNode.userJwt ?? null,
			url: activeNode.url,
		})
	);
	const installedSkills = installedSkillsResult.data ?? [];
	const skillRelationsEnabled = section === "skills" && view === "graph";
	const skillRelations = useSkillRelations({
		agents,
		enabled: skillRelationsEnabled,
	});
	const composioStatus = useComposioStatus();
	const composioConnections = useComposioConnections(
		"",
		composioStatus.data?.configured ?? false
	);
	const {
		servers: mcpServers,
		tools: mcpTools,
		loading: mcpLoading,
	} = useMcp();
	const { engines: localEngines, loading: localEnginesLoading } = useEngines();
	const { engines: alongsideEngines, loading: alongsideEnginesLoading } =
		useVoiceEngines(["media", "voice", "embedding"]);
	const { backends: sandboxBackends, loading: sandboxBackendsLoading } =
		useSandboxBackends();
	const workspaceFolder = useWorkspaceStore((state) => state.folder);
	const recentFolders = useWorkspaceStore((state) => state.recentFolders);
	const removedProjects = useWorkspaceStore((state) => state.removedProjects);
	const projectNames = useWorkspaceStore((state) => state.projectNames);
	const workspaceProjects = useWorkspaceStore((state) => state.projects);
	const pinnedIds = useConversationFlagsStore((state) => state.pinnedIds);
	const archivedIds = useConversationFlagsStore((state) => state.archivedIds);

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

	// Create-dialog state for the collections that need a name before they exist.
	const [spaceDialogOpen, setSpaceDialogOpen] = useState(false);
	const [teamDialogOpen, setTeamDialogOpen] = useState(false);
	const [editingTeamId, setEditingTeamId] = useState<string | null>(null);

	// Rename and delete are reached from a card's right-click menu. The dialogs
	// live ONCE here rather than per card: the grid renders every item in the
	// collection, and mounting a dialog pair inside each card would put hundreds of
	// closed dialogs in the tree to serve the one the user actually opens.
	const [renaming, setRenaming] = useState<LibraryItem | null>(null);
	const [renameDraft, setRenameDraft] = useState("");
	const [deleting, setDeleting] = useState<LibraryItem | null>(null);
	const [busy, setBusy] = useState(false);

	const engineLabel = useCallback(
		(engine: string | null): string | null => {
			if (!engine) {
				return null;
			}
			const match = engines.find(
				(e) => e.id === engine || e.id.endsWith(`:${engine}`)
			);
			return match?.name ?? engine;
		},
		[engines]
	);

	const openTeam = useCallback((id: string | null) => {
		setEditingTeamId(id);
		setTeamDialogOpen(true);
	}, []);

	// --- Normalise each collection into LibraryItem[] -----------------------

	const agentItems = useMemo<LibraryItem[]>(
		() =>
			agents.map((a) => ({
				type: "agent",
				id: a.id,
				name: a.name,
				subtitle: engineLabel(a.engine) ?? a.description,
				badge: null,
				// A glyph, not the word: on the mixed tabs `badge` is already spoken
				// for by the type label, and "Built-in" spelled out down a column of
				// agent rows was the noisiest thing on the page.
				status: a.builtIn ? ("builtin" as const) : null,
				icon: Target01Icon,
				updatedAt: normalizeTimestamp(a.createdAt),
				// openTab stamps recents from the route; no explicit stamp needed.
				open: () => openTab(`/agents/${a.id}/edit`, { title: a.name }),
				openInNewTab: () =>
					openTab(`/agents/${a.id}/edit`, { title: a.name, forceNew: true }),
				// No rename row: the agent hook's `update` takes a whole `AgentInput`,
				// and the editor this card opens is where a name is changed.
				remove: () => removeAgent(a.id),
				removeBlockedReason: a.builtIn
					? "Built-in agents ship with Ryu and can't be deleted."
					: canDeleteAgents
						? undefined
						: "Only organization admins can delete agents.",
			})),
		// engines feed engineLabel; rebuild when either changes.
		[agents, canDeleteAgents, engineLabel, openTab, removeAgent]
	);

	const workflowItems = useMemo<LibraryItem[]>(
		() =>
			workflows.map((w) => ({
				type: "workflow",
				id: w.id,
				name: w.name,
				subtitle:
					w.description ??
					`${formatCount(w.nodes.length) ?? "—"} ${w.nodes.length === 1 ? "node" : "nodes"}`,
				badge: null,
				icon: WorkflowCircle06Icon,
				updatedAt: normalizeTimestamp(w.updatedAt ?? w.createdAt),
				open: () => openTab(`/workflows/${w.id}`, { title: w.name }),
				openInNewTab: () =>
					openTab(`/workflows/${w.id}`, { title: w.name, forceNew: true }),
				preview: (
					<WorkflowFlowStrip
						edges={w.edges}
						nodes={w.nodes}
						triggers={w.triggers}
					/>
				),
				remove: () => removeWorkflow(w.id),
			})),
		[workflows, openTab, removeWorkflow]
	);

	const chatItems = useMemo<LibraryItem[]>(
		() =>
			conversations.map((c) => ({
				type: "chat",
				id: c.id,
				name: c.title || "Untitled chat",
				subtitle: c.folderPath ?? null,
				badge: c.archived ? "Archived" : null,
				icon: SECTION_ICONS.chats,
				updatedAt: normalizeTimestamp(c.updatedAt ?? c.createdAt),
				open: () => openTab("/chat", { conversationId: c.id }),
				openInNewTab: () =>
					openTab("/chat", { conversationId: c.id, forceNew: true }),
				rename: (title: string) => renameConversation(c.id, title),
				remove: () => deleteConversation(c.id),
			})),
		[conversations, openTab, renameConversation, deleteConversation]
	);

	const spaceItems = useMemo<LibraryItem[]>(
		() =>
			spaces
				// Hide the auto-created Meetings space (surfaced under Meetings).
				.filter((s) => s.name !== "Meetings")
				.map((s) => ({
					type: "space",
					id: s.id,
					name: s.name,
					subtitle:
						s.description ??
						`${s.documentCount} ${s.documentCount === 1 ? "doc" : "docs"}`,
					badge: null,
					icon: DeliverySecure01Icon,
					updatedAt: normalizeTimestamp(s.updatedAt ?? s.createdAt),
					open: () => {
						stampRecent("space", s.id);
						// Path segment (not a query string): openTab strips query strings,
						// so the space id must live in the route to survive.
						openTab(`/spaces/${s.id}`, { title: s.name });
					},
					openInNewTab: () => {
						stampRecent("space", s.id);
						openTab(`/spaces/${s.id}`, { title: s.name, forceNew: true });
					},
					remove: () => removeSpace(s.id),
					// Core's `SpaceStore::delete_space` bails on `system = 1`, so the
					// row would only ever produce a failure toast — same call the
					// sidebar's Spaces row makes.
					removeBlockedReason: s.system
						? "System spaces can't be deleted — Ryu creates and maintains this one."
						: canDeleteSpaces
							? undefined
							: "You don't have permission to delete Spaces.",
				})),
		[canDeleteSpaces, spaces, openTab, removeSpace]
	);

	const teamItems = useMemo<LibraryItem[]>(
		() =>
			teams.map((t) => ({
				type: "team",
				id: t.id,
				name: t.name,
				subtitle:
					t.description ??
					`${formatCount(t.members.length) ?? "—"} ${t.members.length === 1 ? "member" : "members"}`,
				badge: null,
				icon: UserMultiple02Icon,
				updatedAt: normalizeTimestamp(t.updatedAt ?? t.createdAt),
				open: () => {
					stampRecent("team", t.id);
					openTeam(t.id);
				},
				// A team opens a DIALOG, not a route — "open in new tab" has nothing to
				// point at, and its name is edited in that same dialog.
				remove: () => removeTeam(t.id),
			})),
		[teams, openTeam, removeTeam]
	);

	const meetingItems = useMemo<LibraryItem[]>(
		() =>
			meetings.map((m) => ({
				type: "meeting",
				id: m.id,
				name: m.title,
				subtitle: m.status === "recording" ? "Recording…" : null,
				badge: m.status === "recording" ? "Live" : null,
				icon: AudioWave01Icon,
				updatedAt: normalizeTimestamp(m.updated_at ?? m.created_at),
				open: () => openTab(`/meetings/${m.id}`, { title: m.title }),
				openInNewTab: () =>
					openTab(`/meetings/${m.id}`, { title: m.title, forceNew: true }),
				rename: (title: string) => renameMeeting(m.id, title),
				remove: () => removeMeeting(m.id),
			})),
		[meetings, openTab, renameMeeting, removeMeeting]
	);

	const channelItems = useMemo<LibraryItem[]>(
		() =>
			channels.map((c) => ({
				type: "channel",
				id: c.id,
				name: c.name,
				subtitle: CHANNEL_LABELS[c.channelType],
				badge: c.enabled ? null : "Disabled",
				icon: SECTION_ICONS.channels,
				updatedAt: normalizeTimestamp(c.updatedAt ?? c.createdAt),
				open: () => openTab(`/channels/${c.id}`, { title: c.name }),
				openInNewTab: () =>
					openTab(`/channels/${c.id}`, { title: c.name, forceNew: true }),
				rename: (name: string) => updateChannel(c.id, { name }),
				remove: () => removeChannel(c.id),
			})),
		[channels, openTab, updateChannel, removeChannel]
	);

	const identityItems = useMemo<LibraryItem[]>(
		() =>
			profiles.map((p) => {
				const count = p.connections.length;
				const authenticated = p.connections.filter(
					(c) => c.status === "AUTHENTICATED"
				).length;
				const latest = p.connections.reduce(
					(max, c) => Math.max(max, c.updated_at ?? c.created_at ?? 0),
					0
				);
				return {
					type: "identity" as const,
					id: p.profile_id,
					name: p.profile_id,
					subtitle: `${formatCount(count) ?? "—"} ${count === 1 ? "connection" : "connections"}`,
					badge:
						count > 0
							? `${formatCount(authenticated) ?? "—"}/${formatCount(count) ?? "—"} signed in`
							: null,
					icon: SECTION_ICONS.identities,
					updatedAt: normalizeTimestamp(latest),
					open: () => {
						stampRecent("identity", p.profile_id);
						openTab(`/identities/profile/${encodeURIComponent(p.profile_id)}`, {
							title: p.profile_id,
						});
					},
					openInNewTab: () => {
						stampRecent("identity", p.profile_id);
						openTab(`/identities/profile/${encodeURIComponent(p.profile_id)}`, {
							title: p.profile_id,
							forceNew: true,
						});
					},
					// A profile IS its id — there is nothing to rename it to.
					remove: () => removeIdentity(p.profile_id),
				};
			}),
		[profiles, openTab, removeIdentity]
	);

	const projectPaths = useMemo(() => {
		const removed = new Set(removedProjects.map(folderKey));
		const candidates = dedupeFolders([
			...(workspaceFolder ? [workspaceFolder] : []),
			...recentFolders,
			...workspaceProjects.flatMap((project) => project.folders),
			...conversations.flatMap((conversation) =>
				conversation.folderPath ? [conversation.folderPath] : []
			),
		]);
		return dedupeFolders(
			candidates.map(
				(path) =>
					findWorkspaceProject(workspaceProjects, path)?.folders[0] ?? path
			)
		).filter((path) => !removed.has(folderKey(path)));
	}, [
		conversations,
		recentFolders,
		removedProjects,
		workspaceFolder,
		workspaceProjects,
	]);

	const setWorkspaceFolder = useWorkspaceStore((state) => state.setFolder);
	const sidebarItemsBySection = useMemo<
		Record<SidebarOnlySection, SidebarLibraryItem[]>
	>(() => {
		const chatToSidebarItem = (item: LibraryItem): SidebarLibraryItem => ({
			icon: item.icon,
			id: item.id,
			name: item.name,
			onOpen: item.open,
			subtitle: item.subtitle,
		});
		const engineItems = [
			...localEngines.map((engine) => ({
				icon: SECTION_ICONS.engines,
				id: `provider:${engine.name}`,
				name: engine.displayName || engine.name,
				onOpen: () => openTab("/store/engines", { title: "Engines" }),
				subtitle: "Text",
			})),
			...alongsideEngines.map((engine) => ({
				icon: SECTION_ICONS.engines,
				id: `${engine.category}:${engine.name}`,
				name: engine.displayName || engine.name,
				onOpen: () => openTab("/store/engines", { title: "Engines" }),
				subtitle: engine.category,
			})),
			...sandboxBackends.map((backend) => ({
				icon: SECTION_ICONS.engines,
				id: `sandbox:${backend.name}`,
				name: backend.name,
				onOpen: () => openTab("/store/engines", { title: "Engines" }),
				subtitle: "Sandbox",
			})),
		];
		const archivedItems = chatItems.filter(
			(item) => archivedIds.has(item.id) || item.badge === "Archived"
		);
		return {
			archived: archivedItems.map(chatToSidebarItem),
			companions: companions.map((companion) => ({
				icon: SECTION_ICONS.companions,
				id: companion.id,
				name: companion.label || companion.name,
				onOpen: () =>
					openTab(pluginCompanionPath(companion.id), {
						title: companion.label || companion.name,
					}),
				subtitle: companion.pluginId,
			})),
			engines: engineItems,
			integrations: (composioConnections.data ?? []).map((connection) => ({
				icon: ConnectIcon,
				id: connection.id,
				name: connection.toolkit || connection.id,
				onOpen: () => openTab("/store/account", { title: "Connections" }),
				subtitle: connection.active ? "Connected" : connection.status,
			})),
			mcp: mcpServers.map((server) => ({
				icon: ServerStack01Icon,
				id: server.name,
				name: server.name,
				onOpen: () => openTab("/store/mcp", { title: "MCP" }),
				subtitle: server.description,
			})),
			pinned: chatItems
				.filter((item) => pinnedIds.has(item.id))
				.map(chatToSidebarItem),
			plugins: apps
				.filter((app) => app.installed)
				.map((app) => ({
					icon: SECTION_ICONS.plugins,
					id: app.id,
					name: app.name,
					onOpen: () => openTab("/apps", { title: "Plugins" }),
					subtitle: app.tagline,
				})),
			projects: projectPaths.map((path) => {
				const project = findWorkspaceProject(workspaceProjects, path);
				const title = project
					? workspaceProjectName(project, projectNames)
					: projectNames[path]?.trim() || basename(path);
				return {
					icon: FolderOpenIcon,
					id: folderKey(path),
					name: title,
					onOpen: () => {
						void setWorkspaceFolder(path);
						openTab("/chat", {
							initialProject: path,
							title,
						});
					},
					subtitle: path,
				};
			}),
			skills: installedSkills.map((skill: InstalledSkill) => ({
				icon: SECTION_ICONS.skills,
				id: skill.id,
				name: skill.name,
				onOpen: () => openTab("/store/skills", { title: "Skills" }),
				secondaryAction: {
					label: `Use ${skill.name} with agents`,
					onSelect: () => void distributeInstalledSkill(skill.id),
				},
				subtitle: skill.description,
			})),
			tabs: tabs.map((tab) => ({
				icon: GridIcon,
				id: tab.id,
				name: tab.title,
				onOpen: () => activateTab(tab.id),
				subtitle: tab.path,
			})),
			tools: mcpTools.map((tool) => ({
				icon: Wrench01Icon,
				id: tool.id,
				name: tool.name,
				onOpen: () => openTab("/library/tools", { title: "Tools" }),
				subtitle: tool.server,
			})),
		};
	}, [
		activateTab,
		apps,
		archivedIds,
		alongsideEngines,
		companions,
		composioConnections.data,
		chatItems,
		distributeInstalledSkill,
		installedSkills,
		localEngines,
		mcpServers,
		mcpTools,
		openTab,
		pinnedIds,
		projectNames,
		projectPaths,
		sandboxBackends,
		setWorkspaceFolder,
		tabs,
	]);

	const itemsByType = useMemo<Record<LibraryItemType, LibraryItem[]>>(
		() => ({
			agent: agentItems,
			workflow: workflowItems,
			chat: chatItems,
			space: spaceItems,
			team: teamItems,
			meeting: meetingItems,
			channel: channelItems,
			identity: identityItems,
		}),
		[
			agentItems,
			workflowItems,
			chatItems,
			spaceItems,
			teamItems,
			meetingItems,
			channelItems,
			identityItems,
		]
	);

	// Flat lookup for resolving recents/favorites refs.
	const itemByKey = useMemo(() => {
		const map = new Map<string, LibraryItem>();
		for (const list of Object.values(itemsByType)) {
			for (const item of list) {
				map.set(refKey(item.type, item.id), item);
			}
		}
		return map;
	}, [itemsByType]);

	// Resolve the synthetic tabs, dropping refs whose item no longer resolves.
	const recentItems = useMemo<LibraryItem[]>(
		() =>
			recents
				.map((r) => itemByKey.get(refKey(r.type, r.id)))
				.filter((i): i is LibraryItem => i !== undefined),
		[recents, itemByKey]
	);

	const favoriteItems = useMemo<LibraryItem[]>(
		() =>
			favorites
				.map((f) => itemByKey.get(refKey(f.type, f.id)))
				.filter((i): i is LibraryItem => i !== undefined),
		[favorites, itemByKey]
	);

	const loadingByType: Record<LibraryItemType, boolean> = {
		agent: agentsLoading,
		workflow: workflowsLoading,
		// Chats are no exception to the rule every other collection follows: until
		// the list has actually come back, an empty one means "not loaded", not
		// "you have none". Hardcoding `false` here flashed the "nothing here"
		// empty state over a node that was still booting.
		chat: conversationsLoading && conversations.length === 0,
		space: spacesLoading,
		team: false,
		meeting: meetingsLoading,
		channel: channelsLoading,
		identity: identitiesLoading,
	};

	// --- Build the visible list for the active tab --------------------------

	const isMixed = section === "recents" || section === "favorites";
	// Everything in the library, flattened — the corpus the global search runs
	// over. Built from the same per-type lists the tabs render, so a search result
	// and the row you would have found by hand are the same object.
	const allItems = useMemo(
		() => Object.values(itemsByType).flat(),
		[itemsByType]
	);
	let baseItems: LibraryItem[];
	if (section === "recents") {
		baseItems = recentItems;
	} else if (section === "favorites") {
		baseItems = favoriteItems;
	} else if (isItemType(section)) {
		baseItems = itemsByType[section];
	} else {
		// A custom-surface section (Tools) has no LibraryItem representation — it
		// renders its own surface and never reaches the card grid, so the collection
		// pipeline below runs over an empty list rather than being skipped (keeping
		// every hook below unconditional).
		baseItems = [];
	}

	// Recents/Favorites resolve refs across every collection, so on launch (the
	// default tab is Recents) they must show a loading state while any source is
	// still loading and nothing has resolved yet — otherwise they'd flash the
	// "nothing here" empty state before the data arrives.
	const anySourceLoading =
		agentsLoading ||
		workflowsLoading ||
		spacesLoading ||
		meetingsLoading ||
		channelsLoading ||
		identitiesLoading ||
		conversationsLoading;
	const loading = isMixed
		? anySourceLoading && baseItems.length === 0
		: // A custom-surface section owns its own loading state.
			isItemType(section) && loadingByType[section];

	// A query in the shell's field takes over the page: it searches every
	// collection, so the result list is mixed no matter which tab is open (and the
	// type chips become the way to narrow it back down). A custom surface (Tools)
	// owns its own search and is left alone.
	const searchingAll =
		query.trim().length > 0 && !CUSTOM_SURFACE_SECTIONS.has(section);
	const mixedView = isMixed || searchingAll;

	const visibleItems = useMemo(() => {
		// A non-empty query searches the WHOLE library, not the open collection.
		// The field lives above the tab strip now, and a search box that sits above
		// the thing that scopes it has to mean "everything" — scoping it to the tab
		// underneath is the one reading the position rules out. It is also the
		// answer to the actual question: you look for a thing in the library, not
		// for a thing in the tab you happen to be standing on.
		let list = searchingAll ? allItems : baseItems;
		if (mixedView && typeFilter) {
			list = list.filter((i) => i.type === typeFilter);
		}
		const q = query.trim().toLowerCase();
		if (q) {
			list = list.filter(
				(i) =>
					i.name.toLowerCase().includes(q) ||
					(i.subtitle?.toLowerCase().includes(q) ?? false)
			);
		}
		// Recents keep their intrinsic (most-recent-first) order; the typed and
		// favorites tabs honour the sort control.
		if (section === "recents") {
			return list;
		}
		const sorted = [...list];
		if (sort === "name-asc") {
			sorted.sort((a, b) => a.name.localeCompare(b.name));
		} else if (sort === "name-desc") {
			sorted.sort((a, b) => b.name.localeCompare(a.name));
		} else {
			sorted.sort((a, b) => b.updatedAt - a.updatedAt);
		}
		return sorted;
	}, [
		allItems,
		baseItems,
		mixedView,
		searchingAll,
		typeFilter,
		query,
		sort,
		section,
	]);

	// Which types actually appear in a mixed tab, so we only offer real chips.
	const presentTypes = useMemo(() => {
		const set = new Set<LibraryItemType>();
		for (const i of searchingAll ? allItems : baseItems) {
			set.add(i.type);
		}
		return set;
	}, [allItems, baseItems, searchingAll]);

	const sidebarSectionLoading: Record<SidebarOnlySection, boolean> = {
		archived: conversationsLoading,
		companions: contributionsLoading,
		engines:
			localEnginesLoading || alongsideEnginesLoading || sandboxBackendsLoading,
		integrations: composioStatus.isLoading || composioConnections.isLoading,
		mcp: mcpLoading,
		pinned: conversationsLoading,
		plugins: appsLoading,
		projects: false,
		skills: installedSkillsResult.isLoading,
		tabs: false,
		tools: mcpLoading,
	};

	const libraryCounts = useMemo<Record<LibrarySection, number | undefined>>(
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

	// --- Per-tab CTA --------------------------------------------------------

	const handleNewChat = () => openTab("/chat", { forceNew: true });

	// Which enabled app answers to `/meetings` right now (null → none). Read here
	// because `ctaForSection` is a plain function, not a component.
	const meetingsCompanion = useCompanionAlias("/meetings");

	const ctaForSection = (): {
		label: string;
		onCta: () => void;
	} | null => {
		switch (section) {
			case "recents":
			case "chat":
				return { label: "New chat", onCta: handleNewChat };
			case "agent":
				return {
					label: "New agent",
					onCta: () => openCreateAgent(),
				};
			case "workflow":
				return {
					label: "New workflow",
					onCta: () => openTab("/workflows/new", { title: "New workflow" }),
				};
			case "space":
				return { label: "New space", onCta: () => setSpaceDialogOpen(true) };
			case "team":
				return { label: "New group", onCta: () => openTeam(null) };
			case "meeting":
				// `/meetings` is owned by the not-pre-installed `@ryu/meetings` app and
				// resolves through the companion-alias catch-all, so with no enabled
				// app claiming it this button's only outcome was an "App not enabled"
				// tab. No CTA at all is the honest answer — same AFFORDANCE gate the
				// `nav.timeline` hotkey uses in `Layout.tsx`.
				return meetingsCompanion
					? {
							label: "Record a meeting",
							onCta: () => openTab("/meetings", { title: "Meetings" }),
						}
					: null;
			case "channel":
				return {
					label: "New channel",
					onCta: () => openTab("/channels/new", { title: "New channel" }),
				};
			case "identity":
				return {
					label: "New identity",
					onCta: () => openTab("/identities/new", { title: "New identity" }),
				};
			case "favorites":
				return {
					label: "Browse agents",
					onCta: () => openTab("/library/agent", { title: "Agents" }),
				};
			default:
				return null;
		}
	};
	const cta = ctaForSection();
	const emptyAction = query.trim()
		? { label: "Clear search", onCta: () => setQuery("") }
		: cta;

	// --- Card context menu --------------------------------------------------

	// One factory for every type's app-contributed rows. Called per card below;
	// the hook itself runs once, which is why `useLibraryContributedRows` returns
	// a function rather than the rows.
	const contributedRowsFor = useLibraryContributedRows();

	const beginRename = useCallback((item: LibraryItem) => {
		setRenameDraft(item.name);
		setRenaming(item);
	}, []);

	const commitRename = useCallback(async () => {
		const item = renaming;
		const title = renameDraft.trim();
		if (!(item?.rename && title) || title === item.name) {
			setRenaming(null);
			return;
		}
		setBusy(true);
		try {
			await item.rename(title);
			setRenaming(null);
		} catch {
			toast.error(`Couldn't rename ${item.name}`);
		} finally {
			setBusy(false);
		}
	}, [renaming, renameDraft]);

	const commitDelete = useCallback(async (): Promise<boolean> => {
		const item = deleting;
		if (!item?.remove) {
			setDeleting(null);
			return true;
		}
		setBusy(true);
		try {
			await item.remove();
			setDeleting(null);
			return true;
		} catch {
			toast.error(`Couldn't delete ${item.name}`);
			return false;
		} finally {
			setBusy(false);
		}
	}, [deleting]);

	/** The right-click rows for one card — the same set on every surface the
	 *  Library renders (shared card, Spaces shelf, Agents badge wall). */
	const menuFor = (item: LibraryItem) => (
		<LibraryItemMenuContent
			contributedRows={contributedRowsFor(item.type, item.id)}
			item={{
				favorited: favorites.some(
					(f) => f.type === item.type && f.id === item.id
				),
				id: item.id,
				name: item.name,
				onOpen: item.open,
				onOpenInNewTab: item.openInNewTab,
				onRename: item.rename ? () => beginRename(item) : undefined,
				onRequestDelete: item.remove ? () => setDeleting(item) : undefined,
				onToggleFavorite: () => toggleFavorite(item.type, item.id),
				removeBlockedReason: item.removeBlockedReason,
				type: item.type,
			}}
		/>
	);

	// On the mixed tabs, prefix each card with its type so kinds are legible.
	const toCardData = (item: LibraryItem): LibraryCardData => {
		// Previews are grid-only (list rows stay compact). The workflow strip is
		// local data, so it renders wherever a workflow card appears. Spaces used to
		// mount a fetched markdown snippet here; the Spaces grid is a book shelf now
		// and never reaches this card, so nothing space-shaped is left to preview.
		const preview = view === "showcase" ? item.preview : undefined;
		return {
			key: refKey(item.type, item.id),
			icon: item.icon,
			name: item.name,
			subtitle: item.subtitle,
			badge: mixedView ? TYPE_META[item.type].label : item.badge,
			statusIcon: item.status ? <StatusBadge kind={item.status} /> : undefined,
			favorited: favorites.some(
				(f) => f.type === item.type && f.id === item.id
			),
			preview,
		};
	};

	const sectionMeta = SECTIONS.find((s) => s.value === section);

	const emptyCopy: Record<LibrarySection, string> = {
		recents: "Items you open will show up here.",
		favorites:
			"Star an agent, workflow, chat, or anything else to pin it here.",
		agent: "Create your first agent to get started.",
		workflow: "Build an automation on the workflow canvas.",
		chat: "Start a new chat to see it here.",
		space: "Create a space to give your agents a knowledge base.",
		team: "Group several agents into a group.",
		meeting: "Record a meeting to get AI-written notes.",
		channel: "Connect a Telegram, Slack, WhatsApp, or Discord bot.",
		identity: "Save a login profile agents can reuse on the web.",
		// Never rendered — the Tools tab owns its own empty states — but the record is
		// exhaustive over LibrarySection so a new tab cannot be added without deciding
		// what its empty state says.
		tools: "Add an MCP server to give your agents new tools.",
		tabs: "Open a tab to keep it close at hand.",
		companions: "Install an app with a workspace surface to see it here.",
		projects: "Open a project folder to see it here.",
		pinned: "Pin a chat to keep it close at hand.",
		integrations: "Connect an integration to see it here.",
		skills: "Install a skill to see it here.",
		mcp: "Register an MCP server to see it here.",
		engines: "Add an engine to see it here.",
		archived: "Archived chats will show up here.",
		plugins: "Install an app or plugin to see it here.",
	};

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
	const sidebarSurface = SIDEBAR_SURFACE_SECTIONS.has(
		section as SidebarOnlySection
	);
	const sidebarItems = sidebarSurface
		? sidebarItemsBySection[section as SidebarOnlySection]
		: [];

	return (
		<div className="flex h-full flex-col overflow-hidden pt-12">
			{/* Page chrome, inline and in the order it works: the library-wide search
			    (with the collection's own controls beside it), then the tabs. No
			    floating bar — the tab list is open-ended (every app may register a
			    collection), so it scrolls in the page flow.

			    There is no section TITLE. It restated the pill that was already
			    active directly beneath it. The search is above the tabs and searches
			    everything, mirroring the Store; the collection's sort/view/filter
			    controls ride the same row, so the page opens with one row of chrome
			    instead of three. */}
			<div className="mx-auto w-full max-w-4xl shrink-0 px-4 pt-4">
				{customSurface ? null : (
					<StoreGlobalSearch
						onChange={setQuery}
						placeholder="Search your library…"
						trailing={
							showCollectionToolbar ? (
								<LibraryToolbar
									className="shrink-0 p-0"
									ctaIcon={cta ? Add01Icon : undefined}
									ctaLabel={cta?.label}
									filterSlot={
										mixedView ? (
											<div className="flex items-center gap-0.5">
												<LibraryFilterChip
													active={typeFilter === null}
													label="All"
													onClick={() => setTypeFilter(null)}
												/>
												{SECTIONS.filter(
													(
														s
													): s is {
														value: LibraryItemType;
														label: string;
														icon: IconSvgElement;
													} => isItemType(s.value) && presentTypes.has(s.value)
												).map((s) => (
													<LibraryFilterChip
														active={typeFilter === s.value}
														icon={TYPE_META[s.value].icon}
														key={s.value}
														label={s.label}
														onClick={() => setTypeFilter(s.value)}
													/>
												))}
											</div>
										) : undefined
									}
									onCta={cta?.onCta}
									onSortChange={setSort}
									onViewChange={onViewChange}
									showGraph={section === "skills"}
									showSearch={false}
									showShowcase={showShowcase}
									sort={section === "recents" ? undefined : sort}
									sortOptions={section === "recents" ? [] : SORT_OPTIONS}
									view={view}
								/>
							) : null
						}
						value={query}
					/>
				)}
				<StoreSectionTabs
					active={active}
					className="pt-2"
					onSelect={setActive}
					sections={navSections}
				/>
			</div>

			{/* A custom-surface section fills the shell itself: it is a full-height
			    master/detail layout with its own scroll containers, so it must NOT be
			    nested inside the centered, scrolling card column below. */}
			{customSurface ? (
				<div className="min-h-0 flex-1 overflow-hidden">
					{section === "tools" ? <ToolsLibrary /> : null}
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
								loading={sidebarSectionLoading[section as SidebarOnlySection]}
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
										<Button onClick={emptyAction.onCta} size="sm">
											{emptyAction.label}
										</Button>
									) : null
								}
								description={
									query ? "Nothing matches your search." : emptyCopy[section]
								}
								icon={sectionMeta?.icon ?? LibraryIcon}
								title={
									query
										? "No results"
										: `No ${sectionMeta?.label.toLowerCase() ?? "items"} yet`
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
											item.badge ? (
												<Badge variant="outline">{item.badge}</Badge>
											) : null
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

			{/* One rename dialog for the whole page — the card menu only names which
			    item it is for. Submitting on Enter matches the sidebar's inline
			    rename, which is the gesture this replaces on this surface. */}
			<Dialog
				onOpenChange={(open) => {
					if (!open) {
						setRenaming(null);
					}
				}}
				open={renaming !== null}
			>
				<DialogContent className="sm:max-w-sm">
					<DialogHeader>
						<DialogTitle>Rename {renaming?.name}</DialogTitle>
					</DialogHeader>
					<Input
						autoFocus
						onChange={(e) => setRenameDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								void commitRename();
							}
						}}
						placeholder="Name"
						value={renameDraft}
					/>
					<DialogFooter>
						<Button
							onClick={() => setRenaming(null)}
							type="button"
							variant="ghost"
						>
							Cancel
						</Button>
						<Button
							disabled={busy || renameDraft.trim().length === 0}
							onClick={() => {
								void commitRename();
							}}
							type="button"
						>
							Rename
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<DestructiveConfirmDialog
				busy={busy}
				description={`"${deleting?.name ?? ""}" will be permanently deleted. This cannot be undone.`}
				impact={
					deleting?.type === "agent" ? (
						<p className="text-muted-foreground">
							Channels and their shared Core session history stay in place. If a
							channel receives a new message, it uses the default agent and
							shows a binding warning. Scheduled jobs for this agent are
							removed.
						</p>
					) : deleting?.type === "space" ? (
						<p className="text-muted-foreground">
							The Space and its documents are permanently deleted.
						</p>
					) : deleting?.type === "channel" ? (
						<p className="text-muted-foreground">
							The bot credentials and channel configuration are deleted; its
							Core session history is kept.
						</p>
					) : null
				}
				label={`Delete ${deleting?.name ?? "this item"}`}
				onConfirm={commitDelete}
				onOpenChange={(open) => {
					if (!(open || busy)) {
						setDeleting(null);
					}
				}}
				open={deleting !== null}
				title={`Delete ${deleting ? TYPE_META[deleting.type].label.toLowerCase() : "item"}?`}
			/>
		</div>
	);
}
