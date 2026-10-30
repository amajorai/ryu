import { useLiteralMessages } from "@ryu/i18n/react";
import { toast } from "@ryu/ui/components/sileo.tsx";
import type { ContextType } from "react";
import type { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import type { TabsContext } from "@/src/contexts/TabsContext.tsx";
import type { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import type { BtwEntry } from "@/src/lib/api/btw.ts";
import {
	conversationEntityKey,
	openEntityInNewWindow,
	routeEntityOpen,
} from "@/src/lib/window-routing.ts";
import {
	findWorkspaceProject,
	workspaceProjectName,
} from "@/src/lib/workspace-projects.ts";
import type { useConversationFlagsStore } from "@/src/store/useConversationFlagsStore.ts";
import type { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import type { ChatRowHandlers } from "./sidebar-conversation-rows.tsx";

type ChatHistory = ReturnType<typeof useChatHistoryContext>;
type TabsValue = NonNullable<ContextType<typeof TabsContext>>;
type WorkspaceState = ReturnType<typeof useWorkspaceStore.getState>;

/** The sidebar's per-chat open/fork/move handlers and project-name lookups. */
export function useSidebarConversationHandlers({
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
}: {
	activeNode: ReturnType<typeof useActiveNode>;
	conversations: ChatHistory["conversations"];
	forkConversation: ChatHistory["forkConversation"];
	markRead: ReturnType<typeof useConversationFlagsStore.getState>["markRead"];
	moveConversationToProject: ChatHistory["moveConversationToProject"];
	onSelectConversation?: (id: string) => void;
	openTab: TabsValue["openTab"];
	projectNames: WorkspaceState["projectNames"];
	removeConversationFromProject: ChatHistory["removeConversationFromProject"];
	requestScrollToMessage: TabsValue["requestScrollToMessage"];
	workspaceProjects: WorkspaceState["projects"];
}) {
	const tl = useLiteralMessages();
	const openConversation = async (
		id: string,
		activation?: { messageId?: string }
	) => {
		markRead(id);
		const action = await routeEntityOpen(conversationEntityKey(id), activation);
		if (action === "focused") {
			return action;
		}
		onSelectConversation?.(id);
		const conv = conversations.find((c) => c.id === id);
		openTab("/chat", {
			conversationId: id,
			title: conv?.title,
			icon: conv?.icon ?? null,
		});
		return action;
	};

	const handleSelectConversation = (id: string) => {
		void openConversation(id);
	};

	const handleJumpToMessage = (conversationId: string, messageId: string) => {
		void openConversation(conversationId, { messageId }).then((action) => {
			if (action === "focused") {
				return;
			}
			requestScrollToMessage(conversationId, messageId);
			window.dispatchEvent(
				new CustomEvent("ryu:scroll-to-message", {
					detail: { messageId },
				})
			);
		});
	};

	// Open a persisted side chat from the sidebar: bring its thread into focus,
	// then hand the entry to that thread's ChatPage (it surfaces it in the btw
	// overlay). Decoupled via a window event so the sidebar never reaches into
	// chat state directly — same pattern as the run-notification click.
	const handleOpenSideChat = (conversationId: string, entry: BtwEntry) => {
		void openConversation(conversationId).then((action) => {
			if (action === "focused") {
				return;
			}
			window.dispatchEvent(
				new CustomEvent("ryu:open-side-chat", {
					detail: { conversationId, entry },
				})
			);
		});
	};

	const handleOpenNewSideChat = (conversationId: string) => {
		handleSelectConversation(conversationId);
		window.dispatchEvent(
			new CustomEvent("ryu:open-side-chat", {
				detail: { conversationId },
			})
		);
	};

	const handleOpenConversationInNewTab = (id: string) => {
		markRead(id);
		const conv = conversations.find((c) => c.id === id);
		openTab("/chat", {
			conversationId: id,
			forceNew: true,
			title: conv?.title,
			icon: conv?.icon ?? null,
		});
	};

	const handleOpenConversationInNewWindow = (id: string) => {
		markRead(id);
		const conversation = conversations.find((item) => item.id === id);
		void openEntityInNewWindow({
			conversationId: id,
			node: activeNode.name,
			path: "/chat",
			title: conversation?.title,
		});
	};

	const handleForkConversation: ChatRowHandlers["onForkConversation"] = (
		id,
		destination
	) => {
		void forkConversation(id)
			.then((newId) => {
				if (!newId) {
					throw new Error("fork failed");
				}
				openTab("/chat", {
					conversationId: newId,
					forceNew: true,
					worktreeMode: destination === "worktree",
				});
				toast.success("Chat forked");
			})
			.catch(() => {
				toast.error("Couldn't fork this chat");
			});
	};

	const handleRemoveFromProject = (id: string) => {
		void removeConversationFromProject(id).then((success) => {
			if (success) {
				toast.success("Chat removed from project");
				return;
			}
			toast.error("Couldn't remove this chat from the project");
		});
	};

	/** The folder that stands for `folderPath`'s project, as the Projects section
	 *  buckets it: a multi-folder workspace project's first folder. */
	const projectFolderFor = (folderPath: string) =>
		findWorkspaceProject(workspaceProjects, folderPath)?.folders[0] ??
		folderPath;

	const handleMoveToProject = (id: string, path: string) => {
		const name = projectNameForFolder(path);
		void moveConversationToProject(id, path).then((success) => {
			if (success) {
				toast.success(tl("Chat moved to {name}", { name }));
				return;
			}
			toast.error(tl("Couldn't move this chat to {name}", { name }));
		});
	};

	const projectNameForFolder = (folderPath: string) => {
		const project = findWorkspaceProject(workspaceProjects, folderPath);
		if (project) {
			return workspaceProjectName(project, projectNames);
		}
		const trimmed = folderPath.replace(/[\\/]+$/, "");
		return trimmed.split(/[\\/]/).at(-1) ?? "project";
	};
	return {
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
	};
}
