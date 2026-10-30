import {
	ConnectIcon,
	FolderOpenIcon,
	GridIcon,
	ServerStack01Icon,
	Wrench01Icon,
} from "@hugeicons/core-free-icons";
import { useLiteralMessages } from "@ryu/i18n/react";
import AppIcon from "@ryu/marketplace/catalog/chrome/app-icon";
import { engineLogoProps } from "@ryu/marketplace/catalog/engine-logos";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useRef } from "react";
import { SECTION_ICONS } from "@/src/components/layout/sidebar-sections.ts";
import type { SidebarLibraryItem } from "@/src/components/library/SidebarLibrarySection.tsx";
import type { useSkillDistributionFlow } from "@/src/components/skills/SkillDistributionProvider.tsx";
import type { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import type { useApps } from "@/src/hooks/useApps.ts";
import {
	useComposioConnections,
	useComposioStatus,
} from "@/src/hooks/useComposioCatalog.ts";
import { useEngines } from "@/src/hooks/useEngines.ts";
import { useMcp } from "@/src/hooks/useMcp.ts";
import {
	pluginCompanionPath,
	type usePluginContributions,
} from "@/src/hooks/usePluginContributions.ts";
import { useSandboxBackends } from "@/src/hooks/useSandboxBackends.ts";
import { installedSkillsQuery } from "@/src/hooks/useSkillsCatalog.ts";
import { useVoiceEngines } from "@/src/hooks/useVoiceEngines.ts";
import type { InstalledSkill } from "@/src/lib/api/skills.ts";
import { basename } from "@/src/lib/files.ts";
import { dedupeFolders, folderKey } from "@/src/lib/folder-path.ts";
import { isNavigablePluginCompanion } from "@/src/lib/plugin-companion-navigation.ts";
import {
	findWorkspaceProject,
	workspaceProjectName,
} from "@/src/lib/workspace-projects.ts";
import { useConversationFlagsStore } from "@/src/store/useConversationFlagsStore.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import type { LibraryItem, SidebarOnlySection } from "./library-sections.ts";
import type { LibraryTabsValue } from "./library-tabs.ts";

/** The Library tabs that mirror a sidebar section (pinned and archived chats,
 *  projects, skills, engines, MCP, …), as `SidebarLibraryItem` rows, plus each
 *  section's loading flag. */
export function useLibrarySidebarItems({
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
}: {
	activateTab: LibraryTabsValue["activateTab"];
	apps: ReturnType<typeof useApps>["apps"];
	appsLoading: boolean;
	chatItems: LibraryItem[];
	companions: ReturnType<typeof usePluginContributions>["companions"];
	contributionsLoading: boolean;
	conversations: ReturnType<typeof useChatHistoryContext>["conversations"];
	conversationsLoading: boolean;
	distributeInstalledSkill: ReturnType<
		typeof useSkillDistributionFlow
	>["distributeInstalledSkill"];
	openTab: LibraryTabsValue["openTab"];
	setEngineDetailId: (id: string | null) => void;
	tabs: LibraryTabsValue["tabs"];
}) {
	const tl = useLiteralMessages();
	// `tl` is a new function every render; read it through a ref so the sidebar
	// item memo below keeps its identity between renders.
	const tlRef = useRef(tl);
	tlRef.current = tl;
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
				iconNode: (
					<AppIcon
						{...engineLogoProps(engine.name)}
						className="size-8"
						name={engine.name}
					/>
				),
				icon: SECTION_ICONS.engines,
				id: `provider:${engine.name}`,
				name: engine.displayName || engine.name,
				onOpen: () => setEngineDetailId(`text:${engine.name}`),
				subtitle: "Text",
			})),
			...alongsideEngines.map((engine) => ({
				iconNode: (
					<AppIcon
						{...engineLogoProps(engine.name)}
						className="size-8"
						name={engine.name}
					/>
				),
				icon: SECTION_ICONS.engines,
				id: `${engine.category}:${engine.name}`,
				name: engine.displayName || engine.name,
				onOpen: () => setEngineDetailId(`${engine.category}:${engine.name}`),
				subtitle: engine.category,
			})),
			...sandboxBackends.map((backend) => ({
				iconNode: (
					<AppIcon
						{...engineLogoProps(backend.name)}
						className="size-8"
						name={backend.name}
					/>
				),
				icon: SECTION_ICONS.engines,
				id: `sandbox:${backend.name}`,
				name: backend.name,
				onOpen: () => setEngineDetailId(`sandbox:${backend.name}`),
				subtitle: "Sandbox",
			})),
		];
		const archivedItems = chatItems.filter(
			(item) => archivedIds.has(item.id) || item.badge === "Archived"
		);
		return {
			archived: archivedItems.map(chatToSidebarItem),
			companions: companions
				.filter(isNavigablePluginCompanion)
				.map((companion) => ({
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
					label: tlRef.current("Use {name} with agents", { name: skill.name }),
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

	const sidebarSectionLoading = {
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
	} satisfies Record<SidebarOnlySection, boolean>;

	return {
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
	};
}
