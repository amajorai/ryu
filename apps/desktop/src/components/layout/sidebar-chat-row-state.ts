// Per-row state for a sidebar chat row: selection, unread, run status, inline
// rename, disclosure, dialog flags and the derived labels both menus share.
// Called only by `ChatRow`, so every hook here is still that row's hook.

import {
	Archive01Icon,
	ArchiveRestoreIcon,
	PinIcon,
	PinOffIcon,
} from "@hugeicons/core-free-icons";
import { useChatDisplayPrefs } from "@ryu/blocks/desktop/agent-elements/chat-display-prefs.tsx";
import { buildRyuDeepLink } from "@ryuhq/protocol/deep-link";
import {
	type DragEvent as ReactDragEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	useChatHistoryRowActions,
	useRunningMainThreadIds,
} from "@/src/contexts/ChatHistoryContext.tsx";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { useInterfaceLevel } from "@/src/hooks/useInterfaceLevel.ts";
import { useModifierClickHold } from "@/src/hooks/useModifierClickHold.ts";
import { useQuickPreviewModifier } from "@/src/hooks/useQuickPreviewModifier.ts";
import { useSidebarChatPreview } from "@/src/hooks/useSidebarChatPreview.ts";
import { isGroupConversation } from "@/src/lib/agent-conversation-groups.ts";
import { conversationRunStatusMeta } from "@/src/lib/conversation-run-status.ts";
import {
	RESOURCE_VISIBILITY_DND_MIME,
	type ResourceVisibility,
	resourceVisibilityDndMime,
	resourceVisibilityGroup,
	serializeVisibilityDragPayload,
} from "@/src/lib/resource-visibility.ts";
import { buildSidebarConversationPreviewStates } from "@/src/lib/sidebar-conversation-preview.ts";
import { useConversationFlagsStore } from "@/src/store/useConversationFlagsStore.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import type { Conversation } from "@/types/chat.ts";
import {
	type ChatRowHandlers,
	moveTargetsFor,
} from "./sidebar-chat-row-types.ts";
import { useSidebarChatSelection } from "./sidebar-chat-selection.tsx";

// How long the pointer must rest on a chat row before its history is prefetched.
const HOVER_PREFETCH_DELAY_MS = 100;

export function useChatRowState(conv: Conversation, handlers: ChatRowHandlers) {
	// A selector, not the whole tabs context: a tab switch must not re-render
	// every chat row.
	const openTab = useTabSelector((state) => state.openTab);
	const resolveConfiguredNodes = useCallback(
		() => useNodeStore.getState().nodes,
		[]
	);
	const {
		activeConversationId,
		agents,
		archivedIds,
		onOpenQuickPreview,
		onRenameConversation,
		pinnedIds,
		projectNameForFolder,
		projectTargets,
		unreadIds,
	} = handlers;
	const isActive = activeConversationId === conv.id;
	// Fetch the thread's newest page once the pointer rests on the row (or the
	// row takes focus), so opening it renders without the history skeleton.
	// The short delay keeps a pointer sweeping down the list from fetching
	// every row it crosses.
	// The stable row callbacks, not the whole history context: a title change
	// elsewhere must not re-render this row.
	const chatHistory = useChatHistoryRowActions();
	const prefetchConversation = chatHistory?.prefetchConversation;
	const prefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const cancelPrefetch = () => {
		if (prefetchTimerRef.current) {
			clearTimeout(prefetchTimerRef.current);
			prefetchTimerRef.current = null;
		}
	};
	const schedulePrefetch = () => {
		if (!prefetchConversation || isActive || prefetchTimerRef.current) {
			return;
		}
		prefetchTimerRef.current = setTimeout(() => {
			prefetchTimerRef.current = null;
			prefetchConversation(conv.id);
		}, HOVER_PREFETCH_DELAY_MS);
	};
	useEffect(
		() => () => {
			if (prefetchTimerRef.current) {
				clearTimeout(prefetchTimerRef.current);
			}
		},
		[]
	);
	const isUnread = unreadIds.has(conv.id);
	const unreadMessageCount = useConversationFlagsStore((state) =>
		state.unreadIds.has(conv.id)
			? (state.unreadMessageCounts.get(conv.id) ?? 1)
			: 0
	);
	const isPinned = pinnedIds.has(conv.id);
	const isArchived = archivedIds.has(conv.id);
	const bulk = handlers.bulk;
	const isSelected = useSidebarChatSelection((state) =>
		state.selectedIds.has(conv.id)
	);
	// Size of the selection this row belongs to (0 when unselected), so only
	// selected rows re-render as the selection grows.
	const bulkSelectionSize = useSidebarChatSelection((state) =>
		state.selectedIds.has(conv.id) ? state.selectedIds.size : 0
	);
	const showBulkMenu = Boolean(bulk) && bulkSelectionSize > 1;
	const runStatus = conversationRunStatusMeta(conv.runStatus);
	const [showSidebarChatPreview] = useSidebarChatPreview();
	const [quickPreviewModifier] = useQuickPreviewModifier();
	const interfaceLevel = useInterfaceLevel();
	const { animationsEnabled } = useChatDisplayPrefs();
	const sidebarPreviewStates = buildSidebarConversationPreviewStates({
		lastMessage: conv.lastMessage,
		lastMessageRole: conv.lastMessageRole,
		statusLabel: runStatus?.label,
		statusVisible: runStatus?.isRunning || runStatus?.needsAttention,
	});
	// A main thread shows the live spinner while any session it spawned runs,
	// since those sessions are not rows of their own.
	const sessionRunning = useRunningMainThreadIds().has(conv.id);
	const isRunning = runStatus?.isRunning === true || sessionRunning;
	// Who last took this thread. The row leads with that agent's mark — the same
	// avatar the Messages sub-accordion puts on each turn — so a sidebar full of
	// chats says WHO is on each one before it says anything else.
	//
	// A council thread (more than one participant) reads its LAST entry: Core
	// appends on join and never sorts (`add_participant`), so that is the most
	// recent joiner. Anything else prefers `agentId`, which tracks the agent the
	// chat is bound to NOW — on a thread whose agent was swapped, a one-entry
	// participants list still holds the original.
	const participants = conv.participants ?? [];
	const groupConversation = isGroupConversation(conv);
	const latestAgentId =
		participants.length > 1
			? participants.at(-1)
			: (conv.agentId ?? participants[0] ?? null);
	const latestAgent = latestAgentId
		? agents.find((a) => a.id === latestAgentId)
		: undefined;
	// Ring colour matches the surface the badge sits ON, which is the sidebar at
	// rest and `muted` once the row is hovered or active — a fixed sidebar-coloured
	// ring would read as a mis-tinted halo on exactly the row being pointed at.
	const dotRingClass = isActive
		? "ring-2 ring-muted"
		: "ring-2 ring-sidebar group-hover/row:ring-muted";

	const pinLabel = isPinned ? "Unpin" : "Pin";
	const pinIcon = isPinned ? PinOffIcon : PinIcon;
	const archiveLabel = isArchived ? "Unarchive" : "Archive";
	const archiveIcon = isArchived ? ArchiveRestoreIcon : Archive01Icon;
	const readLabel = isUnread ? "Mark as read" : "Mark as unread";
	const handleOpenQuickPreview = useCallback(
		() => onOpenQuickPreview?.(conv.id),
		[conv.id, onOpenQuickPreview]
	);
	const quickPreviewHold = useModifierClickHold({
		modifier: onOpenQuickPreview ? quickPreviewModifier : "none",
		onTrigger: handleOpenQuickPreview,
	});
	const shared = resourceVisibilityGroup(conv.visibility) === "team";
	const visibilityActionLabel = shared ? "Make private" : "Share with team";
	const nextVisibility: ResourceVisibility = shared ? "private" : "org";
	const visibilityGroup: "private" | "team" = shared ? "team" : "private";
	const handleVisibilityDragStart = (event: ReactDragEvent<HTMLDivElement>) => {
		event.dataTransfer.effectAllowed = "move";
		const payload = serializeVisibilityDragPayload({
			from: visibilityGroup,
			id: conv.id,
			name: conv.title,
			resourceType: "chat",
		});
		event.dataTransfer.setData(RESOURCE_VISIBILITY_DND_MIME, payload);
		event.dataTransfer.setData(resourceVisibilityDndMime("chat"), "1");
		event.dataTransfer.setData("text/plain", payload);
	};

	// Inline rename: when `isEditing`, the title is replaced by a text input.
	// Commit on Enter / blur, cancel on Escape. Seeded from the current title.
	const [isEditing, setIsEditing] = useState(false);
	const [draftTitle, setDraftTitle] = useState(conv.title);
	const inputRef = useRef<HTMLInputElement | null>(null);

	// Row disclosure expands nested Messages + Side chats sub-accordions.
	const [rowExpanded, setRowExpanded] = useState(false);
	const [messagesExpanded, setMessagesExpanded] = useState(true);
	const [sideChatsExpanded, setSideChatsExpanded] = useState(false);

	// Deleting a chat is permanent, so both the dropdown and context-menu Delete
	// actions open a confirmation dialog rather than wiping the thread outright.
	const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
	const [iconDialogOpen, setIconDialogOpen] = useState(false);
	const [pullRequestsDialogOpen, setPullRequestsDialogOpen] = useState(false);
	const setConversationPullRequestLinked =
		chatHistory?.setConversationPullRequestLinked;
	const linkedPullRequests = conv.linkedPullRequests ?? [];

	const startEditing = () => {
		setDraftTitle(conv.title);
		setIsEditing(true);
	};
	const commitEditing = () => {
		if (!isEditing) {
			return;
		}
		setIsEditing(false);
		const next = draftTitle.trim();
		if (next && next !== conv.title) {
			onRenameConversation(conv.id, next);
		}
	};
	const cancelEditing = () => setIsEditing(false);

	useEffect(() => {
		if (isEditing) {
			inputRef.current?.focus();
			inputRef.current?.select();
		}
	}, [isEditing]);

	// The FULL folder path, not its leaf. The leaf is the project name the row is
	// already filed under, so it carried no information at all; the path is the
	// only place the user can see which of two same-named folders a chat belongs
	// to (and the only way to tell an imported thread's folder from a native one).
	const folderPath = conv.folderPath || null;
	const workingDirectory = conv.worktreePath || folderPath;
	const projectName = folderPath ? projectNameForFolder(folderPath) : null;
	// A project's main thread is the project; it never moves out of it.
	const movable = conv.hierarchy?.role !== "main";
	const moveTargets = movable ? moveTargetsFor(projectTargets, folderPath) : [];
	const chatDeepLink = buildRyuDeepLink({
		kind: "chat",
		conversationId: conv.id,
	});
	const codeSession = Boolean(folderPath && conv.branch);
	return {
		animationsEnabled,
		archiveIcon,
		archiveLabel,
		bulk,
		cancelEditing,
		cancelPrefetch,
		chatDeepLink,
		chatHistory,
		codeSession,
		commitEditing,
		confirmDeleteOpen,
		dotRingClass,
		draftTitle,
		folderPath,
		groupConversation,
		handleVisibilityDragStart,
		iconDialogOpen,
		inputRef,
		interfaceLevel,
		isActive,
		isArchived,
		isEditing,
		isPinned,
		isRunning,
		isSelected,
		isUnread,
		latestAgent,
		linkedPullRequests,
		messagesExpanded,
		movable,
		moveTargets,
		nextVisibility,
		openTab,
		pinIcon,
		pinLabel,
		prefetchConversation,
		projectName,
		pullRequestsDialogOpen,
		quickPreviewHold,
		readLabel,
		resolveConfiguredNodes,
		rowExpanded,
		runStatus,
		schedulePrefetch,
		setConfirmDeleteOpen,
		setConversationPullRequestLinked,
		setDraftTitle,
		setIconDialogOpen,
		setMessagesExpanded,
		setPullRequestsDialogOpen,
		setRowExpanded,
		setSideChatsExpanded,
		shared,
		showBulkMenu,
		showSidebarChatPreview,
		sideChatsExpanded,
		sidebarPreviewStates,
		startEditing,
		unreadMessageCount,
		visibilityActionLabel,
		visibilityGroup,
		workingDirectory,
	};
}
