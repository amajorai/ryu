import type { LiteralMessage } from "@ryu/i18n/react";
import { toast } from "@ryu/ui/components/sileo.tsx";
import type { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import { sameFolder } from "@/src/lib/folder-path.ts";
import type { useConversationFlagsStore } from "@/src/store/useConversationFlagsStore.ts";
import type { Conversation } from "@/types/chat.ts";
import type {
	SidebarChatBulkActions,
	SidebarChatDropTarget,
} from "./sidebar-chat-selection.tsx";
import type { ProjectBucket } from "./sidebar-conversation-list.tsx";

type FlagsState = ReturnType<typeof useConversationFlagsStore.getState>;

/** The multi-select actions (pin, archive, move, drop, delete) shared by every
 *  chat row and section. */
export function buildSidebarChatBulkActions({
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
}: {
	allConversations: Conversation[];
	archivedIds: FlagsState["archivedIds"];
	handleOpenConversationInNewTab: (id: string) => void;
	handleToggleArchive: FlagsState["toggleArchive"];
	handleTogglePin: FlagsState["togglePin"];
	markRead: FlagsState["markRead"];
	markUnread: FlagsState["markUnread"];
	moveConversationToProject: ReturnType<
		typeof useChatHistoryContext
	>["moveConversationToProject"];
	onDeleteConversation?: (id: string) => void;
	pinnedIds: FlagsState["pinnedIds"];
	projectFolderFor: (folderPath: string) => string;
	projectList: ProjectBucket[];
	projectNameForFolder: (folderPath: string) => string;
	tl: LiteralMessage;
}): SidebarChatBulkActions {
	const conversationById = new Map(allConversations.map((c) => [c.id, c]));
	const existingChatIds = (ids: readonly string[]) =>
		ids.filter((id) => conversationById.has(id));
	const setChatsPinned = (ids: readonly string[], pinned: boolean) => {
		for (const id of existingChatIds(ids)) {
			if (pinnedIds.has(id) !== pinned) {
				handleTogglePin(id);
			}
		}
	};
	const setChatsArchived = (ids: readonly string[], archived: boolean) => {
		for (const id of existingChatIds(ids)) {
			if (archivedIds.has(id) !== archived) {
				handleToggleArchive(id);
			}
		}
	};
	const moveChatsToProject = (
		ids: readonly string[],
		folderPath: string | null
	) => {
		const moving = existingChatIds(ids).filter(
			(id) => (conversationById.get(id)?.folderPath || null) !== folderPath
		);
		if (moving.length === 0) {
			return;
		}
		void Promise.all(
			moving.map((id) => moveConversationToProject(id, folderPath))
		).then((results) => {
			const failed = results.filter((ok) => !ok).length;
			if (failed > 0) {
				toast.error(
					tl(
						"{failed, plural, one {Couldn't move a chat} other {Couldn't move {failedCount} chats}}",
						{ failed, failedCount: String(failed) }
					)
				);
				return;
			}
			const count = moving.length;
			const countText = String(count);
			toast.success(
				folderPath
					? tl(
							"{count, plural, one {Moved chat to {project}} other {Moved {countText} chats to {project}}}",
							{ count, countText, project: projectNameForFolder(folderPath) }
						)
					: tl(
							"{count, plural, one {Removed chat from project} other {Removed {countText} chats from project}}",
							{ count, countText }
						)
			);
		});
	};
	/** Whether a chat's folder already belongs to a dropped-on project. */
	const inProjectFolders = (
		folderPath: string | null | undefined,
		target: { folderPath: string; sourceFolders: readonly string[] }
	) =>
		Boolean(folderPath) &&
		[target.folderPath, ...target.sourceFolders].some((folder) =>
			sameFolder(folder, folderPath ?? "")
		);
	// What landing in each section means. A drop makes the chat show up where it
	// was dropped: Pinned pins, Archived archives, Chats clears pin/archive and the
	// project folder, and a project files the chat under that folder.
	const chatNeedsMove = (id: string, target: SidebarChatDropTarget) => {
		const conversation = conversationById.get(id);
		if (!conversation) {
			return false;
		}
		const pinned = pinnedIds.has(id);
		const archived = archivedIds.has(id);
		switch (target.kind) {
			case "pinned":
				return archived || !pinned;
			case "archived":
				return !archived;
			case "chats":
				return pinned || archived || Boolean(conversation.folderPath);
			case "folder": {
				// Compare projects, not raw strings: a chat already in this project
				// (another spelling, or another folder of it) does not need a move.
				const current = conversation.folderPath || null;
				if (current === null || target.folderPath === null) {
					return current !== target.folderPath;
				}
				return !sameFolder(
					projectFolderFor(current),
					projectFolderFor(target.folderPath)
				);
			}
			case "project":
				return (
					pinned ||
					archived ||
					!inProjectFolders(conversation.folderPath, target)
				);
			default:
				return false;
		}
	};
	const moveChatsTo = (
		ids: readonly string[],
		target: SidebarChatDropTarget
	) => {
		const moving = ids.filter((id) => chatNeedsMove(id, target));
		switch (target.kind) {
			case "pinned":
				setChatsArchived(moving, false);
				setChatsPinned(moving, true);
				return;
			case "archived":
				setChatsArchived(moving, true);
				return;
			case "chats":
				setChatsArchived(moving, false);
				setChatsPinned(moving, false);
				moveChatsToProject(moving, null);
				return;
			case "folder":
				moveChatsToProject(moving, target.folderPath);
				return;
			case "project": {
				setChatsArchived(moving, false);
				setChatsPinned(moving, false);
				const refile = moving.filter(
					(id) =>
						!inProjectFolders(conversationById.get(id)?.folderPath, target)
				);
				moveChatsToProject(refile, target.folderPath);
				return;
			}
			default:
				return;
		}
	};
	const chatBulkActions: SidebarChatBulkActions = {
		deleteMany: (ids) => {
			for (const id of existingChatIds(ids)) {
				onDeleteConversation?.(id);
			}
		},
		dropTarget: (target) => ({
			accepts: (ids) => ids.some((id) => chatNeedsMove(id, target)),
			onDrop: (ids) => moveChatsTo(ids, target),
		}),
		moveToProject: moveChatsToProject,
		openInNewTabs: (ids) => {
			for (const id of existingChatIds(ids)) {
				handleOpenConversationInNewTab(id);
			}
		},
		projects: projectList.map((project) => ({
			label: projectNameForFolder(project.path),
			path: project.path,
		})),
		setArchived: setChatsArchived,
		setPinned: setChatsPinned,
		setRead: (ids, read) => {
			for (const id of existingChatIds(ids)) {
				if (read) {
					markRead(id);
				} else {
					markUnread(id);
				}
			}
		},
	};
	return chatBulkActions;
}
