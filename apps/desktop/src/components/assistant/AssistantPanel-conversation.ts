import { useEffect, useMemo, useRef, useState } from "react";
import type { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import { useAgentUiStateHost } from "@/src/hooks/useAgentUiStateHost.ts";
import { compactAge } from "@/src/lib/time.ts";
import type { AssistantBuilderSession } from "@/src/store/useAssistantStore.ts";

/** The panel's conversation ids, widget state host, and floating-window chats. */
export function useAssistantConversation({
	builder,
	listConversations,
	storeConvId,
}: {
	builder: AssistantBuilderSession | null;
	listConversations: ReturnType<
		typeof useChatHistoryContext
	>["listConversations"];
	storeConvId: string | null;
}) {
	// This panel's conversation id. In generic mode it is seeded from the store (so
	// reopening keeps the same thread) and regenerated when a fresh thread is
	// requested. In builder mode it is the builder session's own ephemeral id.
	const [convId, setConvId] = useState<string>(
		() => storeConvId ?? `conv-${Date.now()}`
	);
	// React only to the store's id changing — `convId` is the local mirror, read
	// via the functional updater so it is not a dependency. A null store id means
	// `newConversation()` was called, so start a brand-new thread.
	useEffect(() => {
		setConvId((current) => {
			if (storeConvId === null) {
				return `conv-${Date.now()}`;
			}
			return storeConvId === current ? current : storeConvId;
		});
	}, [storeConvId]);

	// An app-defined surface gets one thread per `thread` value (e.g. one per pull
	// request); the built-in builders keep one thread per page.
	const surfaceThreadId =
		builder &&
		builder.kind !== "agent" &&
		builder.kind !== "workflow" &&
		builder.thread
			? `${builder.conversationId}::${builder.thread}`
			: null;
	const activeConvId = builder
		? (surfaceThreadId ?? builder.conversationId)
		: convId;
	const activeConvIdRef = useRef(activeConvId);
	activeConvIdRef.current = activeConvId;
	// Generative-UI widget state is saved for normal threads; a builder session
	// is ephemeral, so its widgets keep state in memory.
	const agentUiStateHost = useAgentUiStateHost(builder ? null : convId);
	const conversations = useMemo(() => listConversations(), [listConversations]);
	const floatingRecentChats = useMemo(
		() =>
			conversations
				.filter((conversation) => !conversation.archived)
				.slice(0, 4)
				.map((conversation) => ({
					id: conversation.id,
					meta: compactAge(conversation.updatedAt),
					title: conversation.title || "Untitled chat",
				})),
		[conversations]
	);
	const activeConversation = conversations.find(
		(conversation) => conversation.id === activeConvId
	);
	const floatingTitle =
		activeConversation?.title && activeConversation.title !== "Untitled"
			? activeConversation.title
			: "New chat";
	const convIdRef = useRef(convId);
	convIdRef.current = convId;
	return {
		activeConvId,
		activeConvIdRef,
		agentUiStateHost,
		convId,
		convIdRef,
		floatingRecentChats,
		floatingTitle,
	};
}
