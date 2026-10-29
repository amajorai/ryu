import {
	Archive01Icon,
	ConnectIcon,
	DeliverySecure01Icon,
	FolderOpenIcon,
	ServerStack01Icon,
	Target01Icon,
	Wrench01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { z } from "zod";
import {
	BUILTIN_SECTIONS,
	type BuiltinSectionKey,
	SECTION_ICONS,
	SURFACE_PLUGIN_OWNER,
} from "@/src/components/layout/sidebar-sections.ts";
import { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import { useSpacesContext } from "@/src/contexts/SpacesContext.tsx";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAgents } from "@/src/hooks/useAgents.ts";
import { useApps } from "@/src/hooks/useApps.ts";
import { useChannels } from "@/src/hooks/useChannels.ts";
import {
	useComposioConnections,
	useComposioStatus,
} from "@/src/hooks/useComposioCatalog.ts";
import { useEngines } from "@/src/hooks/useEngines.ts";
import { useIdentities } from "@/src/hooks/useIdentities.ts";
import { useMcp } from "@/src/hooks/useMcp.ts";
import {
	pluginCompanionPath,
	usePluginContributions,
} from "@/src/hooks/usePluginContributions.ts";
import { useSandboxBackends } from "@/src/hooks/useSandboxBackends.ts";
import { installedSkillsQuery } from "@/src/hooks/useSkillsCatalog.ts";
import { useVoiceEngines } from "@/src/hooks/useVoiceEngines.ts";
import { CHANNEL_LABELS } from "@/src/lib/api/channels.ts";
import { pluginSidebarSpec } from "@/src/lib/api/plugin-contribution-specs.ts";
import type { InstalledSkill } from "@/src/lib/api/skills.ts";
import {
	chatPullRequestUrls,
	pullRequestSearchTerms,
} from "@/src/lib/chat-pull-request-search.ts";
import { basename } from "@/src/lib/files.ts";
import { dedupeFolders, folderKey } from "@/src/lib/folder-path.ts";
import { isNavigablePluginCompanion } from "@/src/lib/plugin-companion-navigation.ts";
import {
	findWorkspaceProject,
	workspaceProjectName,
} from "@/src/lib/workspace-projects.ts";
import { useChatPullRequestIndex } from "@/src/store/useChatPullRequestIndex.ts";
import { useConversationFlagsStore } from "@/src/store/useConversationFlagsStore.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";

/** One searchable row from a built-in sidebar section. */
export interface CommandSearchItem {
	icon?: IconSvgElement;
	id: string;
	/** Extra matched text that is not displayed (e.g. a chat's `#123` PRs). */
	keywords?: string;
	onSelect: () => void;
	subtitle?: string | null;
	timestamp?: number;
	title: string;
}

/** The result-type metadata needed by the shared command palette. */
export interface CommandSearchSection {
	icon: IconSvgElement;
	id: string;
	items: CommandSearchItem[];
	label: string;
}

/** Owner gates used by the sidebar's compiled-in app-backed sections. */
const SECTION_PLUGIN_OWNER = {
	agents: SURFACE_PLUGIN_OWNER.agents,
	spaces: SURFACE_PLUGIN_OWNER.spaces,
} satisfies Partial<Record<BuiltinSectionKey, string>>;

function searchItem(
	id: string,
	title: string,
	onSelect: () => void,
	options: {
		icon?: IconSvgElement;
		keywords?: string;
		subtitle?: string | null;
		timestamp?: number;
	} = {}
): CommandSearchItem {
	return { id, onSelect, title, ...options };
}

const timestampInputSchema = z.union([z.number(), z.string()]);
function toTimestamp(
	value: Parameters<typeof timestampInputSchema.parse>[0]
): number | undefined {
	const numeric = z.number().safeParse(value);
	if (numeric.success) {
		return numeric.data > 0 && numeric.data < 1_000_000_000_000
			? numeric.data * 1000
			: numeric.data;
	}
	const text = z.string().safeParse(value);
	if (!text.success) {
		return undefined;
	}
	const parsed = Date.parse(text.data);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Mirrors the sidebar's built-in collections into one search index. The hook
 * intentionally returns section ids from `BUILTIN_SECTIONS`; app-contributed
 * sections are added by the palette from the same contributions feed, so a new
 * app gets a filter tab without a shell code change.
 */
export function useCommandSearchSections() {
	const { activateTab, openTab, tabs } = useTabsContext();
	const { conversations, setActiveConversationId } = useChatHistoryContext();
	const { spaces } = useSpacesContext();
	const { agents } = useAgents();
	const { apps, loading: appsLoading } = useApps();
	const { channels } = useChannels();
	const { profiles } = useIdentities();
	const { servers: mcpServers, tools: mcpTools } = useMcp();
	const { engines: localEngines } = useEngines();
	const { engines: alongsideEngines } = useVoiceEngines([
		"media",
		"voice",
		"embedding",
	]);
	const { backends: sandboxBackends } = useSandboxBackends();
	const composioStatus = useComposioStatus();
	const composioConnections = useComposioConnections(
		"",
		composioStatus.data?.configured ?? false
	);
	const { companions, sidebar_sections: contributedSections } =
		usePluginContributions();
	const activeNode = useActiveNode();
	const installedSkillsOptions = useMemo(
		() =>
			installedSkillsQuery({
				token: activeNode.token ?? null,
				userJwt: activeNode.userJwt ?? null,
				url: activeNode.url,
			}),
		[activeNode.token, activeNode.url, activeNode.userJwt]
	);
	const installedSkillsResult = useQuery(installedSkillsOptions);
	const installedSkills = installedSkillsResult.data ?? [];
	const workspaceFolder = useWorkspaceStore((state) => state.folder);
	const recentFolders = useWorkspaceStore((state) => state.recentFolders);
	const removedProjects = useWorkspaceStore((state) => state.removedProjects);
	const projectNames = useWorkspaceStore((state) => state.projectNames);
	const workspaceProjects = useWorkspaceStore((state) => state.projects);
	const pinnedIds = useConversationFlagsStore((state) => state.pinnedIds);
	const archivedIds = useConversationFlagsStore((state) => state.archivedIds);
	const branchPullRequests = useChatPullRequestIndex(
		(state) => state.branchPullRequests
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

	const sections = useMemo<CommandSearchSection[]>(() => {
		const openChat = (id: string) => {
			setActiveConversationId(id);
			openTab("/chat", { conversationId: id });
		};
		const chatItems = conversations.map((conversation) =>
			searchItem(
				conversation.id,
				conversation.title || "Untitled chat",
				() => openChat(conversation.id),
				{
					icon: SECTION_ICONS.chats,
					keywords: pullRequestSearchTerms(
						chatPullRequestUrls(conversation, branchPullRequests)
					),
					subtitle: conversation.folderPath,
					timestamp: toTimestamp(
						conversation.updatedAt ?? conversation.createdAt
					),
				}
			)
		);
		const chatSidebarItems = chatItems.filter(
			(item) => !archivedIds.has(item.id)
		);
		const archivedItems = conversations
			.filter(
				(conversation) =>
					archivedIds.has(conversation.id) || conversation.archived
			)
			.map((conversation) =>
				searchItem(
					conversation.id,
					conversation.title || "Untitled chat",
					() => openChat(conversation.id),
					{
						icon: Archive01Icon,
						keywords: pullRequestSearchTerms(
							chatPullRequestUrls(conversation, branchPullRequests)
						),
						subtitle: conversation.folderPath,
						timestamp: toTimestamp(
							conversation.updatedAt ?? conversation.createdAt
						),
					}
				)
			);

		const itemsBySection = {
			archived: archivedItems,
			agents: agents.map((agent) =>
				searchItem(
					agent.id,
					agent.name,
					() => openTab(`/agents/${agent.id}/edit`, { title: agent.name }),
					{
						icon: Target01Icon,
						subtitle: agent.description,
						timestamp: toTimestamp(agent.createdAt),
					}
				)
			),
			channels: channels.map((channel) =>
				searchItem(
					channel.id,
					channel.name,
					() => openTab(`/channels/${channel.id}`, { title: channel.name }),
					{
						icon: SECTION_ICONS.channels,
						subtitle: CHANNEL_LABELS[channel.channelType],
						timestamp: toTimestamp(channel.updatedAt ?? channel.createdAt),
					}
				)
			),
			chats: chatSidebarItems,
			companions: companions
				.filter(isNavigablePluginCompanion)
				.map((companion) =>
					searchItem(
						companion.id,
						companion.label || companion.name,
						() =>
							openTab(pluginCompanionPath(companion.id), {
								title: companion.label || companion.name,
							}),
						{ icon: SECTION_ICONS.companions, subtitle: companion.pluginId }
					)
				),
			engines: [
				...localEngines.map((engine) =>
					searchItem(
						`provider:${engine.name}`,
						engine.displayName || engine.name,
						() => openTab("/store/engines", { title: "Engines" }),
						{ icon: SECTION_ICONS.engines, subtitle: "Text" }
					)
				),
				...alongsideEngines.map((engine) =>
					searchItem(
						`${engine.category}:${engine.name}`,
						engine.displayName || engine.name,
						() => openTab("/store/engines", { title: "Engines" }),
						{ icon: SECTION_ICONS.engines, subtitle: engine.category }
					)
				),
				...sandboxBackends.map((backend) =>
					searchItem(
						`sandbox:${backend.name}`,
						backend.displayName || backend.name,
						() => openTab("/store/engines", { title: "Engines" }),
						{ icon: SECTION_ICONS.engines, subtitle: "Sandbox" }
					)
				),
			],
			identities: profiles.map((profile) =>
				searchItem(
					profile.profile_id,
					profile.profile_id,
					() =>
						openTab(
							`/identities/profile/${encodeURIComponent(profile.profile_id)}`,
							{ title: profile.profile_id }
						),
					{
						icon: SECTION_ICONS.identities,
						subtitle: `${formatCount(profile.connections.length) ?? "—"} ${profile.connections.length === 1 ? "connection" : "connections"}`,
					}
				)
			),
			integrations: (composioConnections.data ?? []).map((connection) =>
				searchItem(
					connection.id,
					connection.toolkit || connection.id,
					() => openTab("/store/account", { title: "Connections" }),
					{
						icon: ConnectIcon,
						subtitle: connection.active ? "Connected" : connection.status,
					}
				)
			),
			mcp: mcpServers.map((server) =>
				searchItem(
					server.name,
					server.name,
					() => openTab("/store/mcp", { title: "MCP" }),
					{ icon: ServerStack01Icon, subtitle: server.description }
				)
			),
			pinned: chatItems.filter((item) => pinnedIds.has(item.id)),
			plugins: apps
				.filter((app) => app.installed)
				.map((app) =>
					searchItem(
						app.id,
						app.name,
						() => openTab("/apps", { title: "Plugins" }),
						{ icon: SECTION_ICONS.plugins, subtitle: app.tagline }
					)
				),
			projects: projectPaths.map((path) => {
				const project = findWorkspaceProject(workspaceProjects, path);
				const title = project
					? workspaceProjectName(project, projectNames)
					: projectNames[path]?.trim() || basename(path);
				return searchItem(
					folderKey(path),
					title,
					() => {
						openTab("/chat", { initialProject: path, title });
					},
					{ icon: FolderOpenIcon, subtitle: path }
				);
			}),
			skills: installedSkills.map((skill: InstalledSkill) =>
				searchItem(
					skill.id,
					skill.name,
					() => openTab("/store/skills", { title: "Skills" }),
					{ icon: SECTION_ICONS.skills, subtitle: skill.description }
				)
			),
			spaces: spaces
				.filter((space) => space.name !== "Meetings")
				.map((space) =>
					searchItem(
						space.id,
						space.name,
						() => openTab(`/spaces/${space.id}`, { title: space.name }),
						{
							icon: DeliverySecure01Icon,
							subtitle:
								space.description ??
								`${space.documentCount} ${space.documentCount === 1 ? "doc" : "docs"}`,
							timestamp: toTimestamp(space.updatedAt || space.createdAt),
						}
					)
				),
			tabs: tabs.map((tab) =>
				searchItem(tab.id, tab.title, () => activateTab(tab.id), {
					icon: SECTION_ICONS.tabs,
					subtitle: tab.path,
				})
			),
			tools: mcpTools.map((tool) =>
				searchItem(
					tool.id,
					tool.name,
					() => openTab("/library/tools", { title: "Tools" }),
					{ icon: Wrench01Icon, subtitle: tool.server }
				)
			),
		} satisfies Partial<Record<BuiltinSectionKey, CommandSearchItem[]>>;

		const enabledPluginIds = new Set(
			apps.filter((app) => app.enabled).map((app) => app.id)
		);
		const visibleSections = appsLoading
			? BUILTIN_SECTIONS
			: BUILTIN_SECTIONS.filter((section) => {
					const owner = Object.entries(SECTION_PLUGIN_OWNER).find(
						([key]) => key === section.key
					)?.[1];
					return !owner || enabledPluginIds.has(owner);
				}).filter((section) => {
					const owner = Object.entries(SECTION_PLUGIN_OWNER).find(
						([key]) => key === section.key
					)?.[1];
					return !(
						owner &&
						contributedSections.some(
							(contribution) =>
								contribution.plugin === owner &&
								Boolean(pluginSidebarSpec(contribution)?.source)
						)
					);
				});

		return visibleSections.map((section) => ({
			icon: SECTION_ICONS[section.key],
			id: section.key,
			items:
				Object.entries(itemsBySection).find(
					([key]) => key === section.key
				)?.[1] ?? [],
			label: section.label,
		}));
	}, [
		activateTab,
		agents,
		alongsideEngines,
		apps,
		appsLoading,
		archivedIds,
		branchPullRequests,
		channels,
		companions,
		contributedSections,
		composioConnections.data,
		conversations,
		localEngines,
		mcpServers,
		mcpTools,
		openTab,
		pinnedIds,
		profiles,
		projectNames,
		projectPaths,
		workspaceProjects,
		sandboxBackends,
		setActiveConversationId,
		spaces,
		tabs,
		installedSkills,
	]);

	return { agents, sections };
}
