import { useCallback, useState } from "react";
import { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import { useConversationFlagsStore } from "@/src/store/useConversationFlagsStore.ts";
import type { Node } from "@/src/store/useNodeStore.ts";
import { useQuickReplyStore } from "@/src/store/useQuickReplyStore.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import type { OpenTab } from "./layout-constants.ts";

/** State and handlers for the sidebar's Quick Preview and Quick Reply. */
export function useQuickConversationActions(
	conversations: ReturnType<typeof useChatHistoryContext>["conversations"],
	activeNode: Node,
	openTab: OpenTab
) {
	const quickReplyRequest = useQuickReplyStore((state) => state.request);
	const openQuickReply = useQuickReplyStore((state) => state.open);
	const closeQuickReply = useQuickReplyStore((state) => state.close);
	const submitQuickReply = useQuickReplyStore((state) => state.submit);
	const [quickPreviewConversationId, setQuickPreviewConversationId] = useState<
		string | null
	>(null);
	const quickPreviewConversation = quickPreviewConversationId
		? conversations.find((item) => item.id === quickPreviewConversationId)
		: undefined;
	const unreadIds = useConversationFlagsStore((state) => state.unreadIds);
	const markRead = useConversationFlagsStore((state) => state.markRead);
	const markUnread = useConversationFlagsStore((state) => state.markUnread);

	const handleOpenQuickPreview = useCallback((conversationId: string) => {
		setQuickPreviewConversationId(conversationId);
	}, []);

	const handleOpenQuickReply = useCallback(
		(conversationId: string) => {
			const conversation = conversations.find(
				(item) => item.id === conversationId
			);
			openQuickReply({
				conversationId,
				targetUrl: activeNode.url,
				title: conversation?.title ?? "Chat",
			});
		},
		[activeNode.url, conversations, openQuickReply]
	);

	const handleSubmitQuickReply = useCallback(
		(content: string) => {
			const request = useQuickReplyStore.getState().request;
			if (!request) {
				return;
			}
			// Ensure a ChatPage owns the target even when the conversation was not already
			// open. Its registration drains this request after the tab mounts.
			openTab("/chat", {
				conversationId: request.conversationId,
				title: request.title,
			});
			submitQuickReply(request.targetUrl, request.conversationId, content);
			closeQuickReply();
		},
		[closeQuickReply, openTab, submitQuickReply]
	);
	return {
		closeQuickReply,
		handleOpenQuickPreview,
		handleOpenQuickReply,
		handleSubmitQuickReply,
		markRead,
		markUnread,
		quickPreviewConversation,
		quickPreviewConversationId,
		quickReplyRequest,
		setQuickPreviewConversationId,
		unreadIds,
	};
}

/** Sidebar conversation actions: new, select and delete. */
export function useConversationHandlers(openTab: OpenTab) {
	const {
		activeConversationId,
		setActiveConversationId,
		deleteConversation,
		createConversation,
	} = useChatHistoryContext();
	const handleNewConversation = useCallback(() => {
		const id = `conv-${Date.now()}`;
		// Born under whatever project is open, so the sidebar nests it right away.
		// Read at call time (not subscribed) — this handler is a one-shot action,
		// and the value that matters is the folder as it is when the user asks.
		createConversation(id, {
			folderPath: useWorkspaceStore.getState().folder ?? undefined,
		});
		setActiveConversationId(id);
		openTab("/chat", { forceNew: true, conversationId: id, title: "New chat" });
	}, [createConversation, openTab, setActiveConversationId]);

	const handleSelectConversation = useCallback(
		(id: string) => {
			setActiveConversationId(id);
			openTab("/chat", { conversationId: id });
		},
		[openTab, setActiveConversationId]
	);

	const handleDeleteConversation = useCallback(
		(id: string) => {
			void deleteConversation(id).then((deleted) => {
				if (deleted && activeConversationId === id) {
					setActiveConversationId(null);
				}
			});
		},
		[activeConversationId, deleteConversation, setActiveConversationId]
	);
	return {
		handleDeleteConversation,
		handleNewConversation,
		handleSelectConversation,
	};
}
