import { useLiteralMessages } from "@ryu/i18n/react";
import { useMemo } from "react";
import {
	useChatHistoryContext,
	useRunningMainThreadIds,
} from "@/src/contexts/ChatHistoryContext.tsx";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import type { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import type { useAgents } from "@/src/hooks/useAgents.ts";
import type { useApps } from "@/src/hooks/useApps.ts";
import { useBotChatSections } from "@/src/hooks/useBotChatSections.ts";
import type { useVisibilityAdminAccess } from "@/src/hooks/useVisibilityAdminAccess.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import type { VisibilityChangeRequest } from "@/src/lib/resource-visibility.ts";
import { useConversationFlagsStore } from "@/src/store/useConversationFlagsStore.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import { buildSidebarChatBulkActions } from "./AppSidebar-chat-bulk.ts";
import { useSidebarConversationHandlers } from "./AppSidebar-conversation-handlers.ts";
import { useConversationFlagSync } from "./AppSidebar-conversation-sync.ts";
import { buildSidebarProjects } from "./AppSidebar-projects.ts";
import type { ChatGroupingValue } from "./sidebar-chat-grouping.tsx";
import { useSidebarChatSelectionEscape } from "./sidebar-chat-selection.tsx";
import type { ChatClassifyContext } from "./sidebar-chat-view.ts";
import type { ChatRowHandlers } from "./sidebar-conversation-rows.tsx";
import type { SidebarModeDescriptor } from "./sidebar-modes.ts";
import { useStableChatRowHandlers } from "./use-stable-chat-row-handlers.ts";

/** The sidebar's chat rows: conversations bucketed into pinned, project,
 *  archived and loose groups, plus the row handlers, bulk actions and chat
 *  grouping every chat section shares. */
export function useSidebarChatRows({
	activeConversationId,
	activeMode,
	activeNode,
	agents,
	canMakePrivate,
	onDeleteConversation,
	onOpenQuickPreview,
	onOpenQuickReply,
	onSelectConversation,
	pluginApps,
	requestConversationVisibility,
	setScheduledConversationId,
	sideChatsEnabled,
}: {
	activeConversationId: string | null;
	activeMode: SidebarModeDescriptor;
	activeNode: ReturnType<typeof useActiveNode>;
	agents: ReturnType<typeof useAgents>["agents"];
	canMakePrivate: ReturnType<typeof useVisibilityAdminAccess>["canMakePrivate"];
	onDeleteConversation?: (id: string) => void;
	onOpenQuickPreview?: (id: string) => void;
	onOpenQuickReply?: (id: string) => void;
	onSelectConversation?: (id: string) => void;
	pluginApps: ReturnType<typeof useApps>["apps"];
	requestConversationVisibility: (request: VisibilityChangeRequest) => void;
	setScheduledConversationId: (id: string | null) => void;
	sideChatsEnabled: boolean;
}) {
	const {
		listConversations,
		conversations,
		forkConversation,
		moveConversationToProject,
		removeConversationFromProject,
		autoRenameConversation,
		renameConversation,
		setConversationGlyph,
		loadMessages,
	} = useChatHistoryContext();
	const tl = useLiteralMessages();
	const openTab = useTabSelector((state) => state.openTab);
	const updateTabsIconWhere = useTabSelector(
		(state) => state.updateTabsIconWhere
	);
	const requestScrollToMessage = useTabSelector(
		(state) => state.requestScrollToMessage
	);
	const pullRequestsEnabled = pluginApps.some(
		(app) => app.id === "@ryu/pull-requests" && app.enabled
	);
	// The synced project list (shared with the composer's project picker): the
	// active folder, recent folders, and any removed-from-app folders.
	const workspaceFolder = useWorkspaceStore((s) => s.folder);
	const recentFolders = useWorkspaceStore((s) => s.recentFolders);
	const removedProjects = useWorkspaceStore((s) => s.removedProjects);
	const projectNames = useWorkspaceStore((s) => s.projectNames);
	const workspaceProjects = useWorkspaceStore((s) => s.projects);
	// Pin/archive/unread live in one module-level store (see
	// `useConversationFlagsStore`) because the tab context menus offer the same
	// rows; a second `useState` copy here would desync on the first toggle.
	const unreadIds = useConversationFlagsStore((s) => s.unreadIds);
	const pinnedIds = useConversationFlagsStore((s) => s.pinnedIds);
	const archivedIds = useConversationFlagsStore((s) => s.archivedIds);
	const markRead = useConversationFlagsStore((s) => s.markRead);
	const markUnread = useConversationFlagsStore((s) => s.markUnread);
	const handleTogglePin = useConversationFlagsStore((s) => s.togglePin);
	const handleToggleArchive = useConversationFlagsStore((s) => s.toggleArchive);
	useConversationFlagSync(conversations, activeConversationId);
	const {
		handleForkConversation,
		handleJumpToMessage,
		handleMoveToProject,
		handleOpenConversationInNewTab,
		handleOpenConversationInNewWindow,
		handleOpenNewSideChat,
		handleOpenSideChat,
		handleRemoveFromProject,
		handleSelectConversation,
		projectFolderFor,
		projectNameForFolder,
	} = useSidebarConversationHandlers({
		activeNode,
		conversations,
		forkConversation,
		markRead,
		moveConversationToProject,
		onSelectConversation,
		openTab,
		projectNames,
		removeConversationFromProject,
		requestScrollToMessage,
		workspaceProjects,
	});
	const {
		agentModeOtherChats,
		allConversations,
		archived,
		pinned,
		projectList,
		rest,
	} = buildSidebarProjects({
		activeMode,
		agents,
		archivedIds,
		listConversations,
		pinnedIds,
		projectNames,
		recentFolders,
		removedProjects,
		workspaceFolder,
		workspaceProjects,
	});

	useSidebarChatSelectionEscape();
	const chatGroups = useBotChatSections();
	const runningMainThreadIds = useRunningMainThreadIds();
	const chatClassify = useMemo<ChatClassifyContext>(
		() => ({ runningIds: runningMainThreadIds, unreadIds }),
		[runningMainThreadIds, unreadIds]
	);
	const chatGrouping: ChatGroupingValue = {
		agents: agents.map((agent) => ({ id: agent.id, name: agent.name })),
		classify: chatClassify,
		groups: chatGroups,
		projectFolder: projectFolderFor,
		projectName: projectNameForFolder,
	};
	const chatBulkActions = buildSidebarChatBulkActions({
		allConversations,
		archivedIds,
		handleOpenConversationInNewTab,
		handleToggleArchive,
		handleTogglePin,
		markRead,
		markUnread,
		moveConversationToProject,
		onDeleteConversation,
		pinnedIds,
		projectFolderFor,
		projectList,
		projectNameForFolder,
		tl,
	});

	// A stable facade, so memoized rows skip renders that change nothing they show.
	const chatRowHandlers: ChatRowHandlers = useStableChatRowHandlers({
		activeConversationId,
		agents,
		archivedIds,
		bulk: chatBulkActions,
		pinnedIds,
		unreadIds,
		loadMessages,
		onAddScheduledTask: setScheduledConversationId,
		onDeleteConversation: onDeleteConversation ?? (() => undefined),
		onForkConversation: handleForkConversation,
		onJumpToMessage: handleJumpToMessage,
		onMarkRead: markRead,
		onMarkUnread: markUnread,
		onOpenQuickPreview,
		onOpenQuickReply: onOpenQuickReply ?? (() => undefined),
		onOpenInNewTab: handleOpenConversationInNewTab,
		onOpenInNewWindow: handleOpenConversationInNewWindow,
		onOpenNewSideChat: handleOpenNewSideChat,
		onOpenSideChat: handleOpenSideChat,
		onAutoRenameConversation: autoRenameConversation,
		onRenameConversation: renameConversation,
		onMoveToProject: handleMoveToProject,
		onRemoveFromProject: handleRemoveFromProject,
		onSelectConversation: handleSelectConversation,
		onSetConversationIcon: (id, icon) => {
			setConversationGlyph(id, icon);
			updateTabsIconWhere((t) => t.conversationId === id, icon);
		},
		onRequestConversationVisibility: requestConversationVisibility,
		onToggleArchive: handleToggleArchive,
		onTogglePin: handleTogglePin,
		projectNameForFolder,
		projectTargets: projectList,
		canMakePrivate,
		pullRequestsEnabled,
		schedulingEnabled: pluginApps.some(
			(app) => app.id === "@ryu/calendar" && app.enabled
		),
		target: toTarget(activeNode),
		sideChatsEnabled,
	});

	return {
		agentModeOtherChats,
		archived,
		chatBulkActions,
		chatGrouping,
		chatRowHandlers,
		pinned,
		projectList,
		rest,
	};
}
