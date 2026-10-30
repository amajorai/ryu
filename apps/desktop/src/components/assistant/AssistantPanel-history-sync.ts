import type { UseChatHelpers } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { type RefObject, useEffect, useRef } from "react";
import type { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import { hydrateHistoryMessage } from "@/src/lib/chat-history-hydrate.ts";
import type { AssistantBuilderSession } from "@/src/store/useAssistantStore.ts";

/** Rehydrates a reopened thread and syncs history / the builder page after a turn. */
export function useAssistantHistorySync({
	builderRef,
	convId,
	loadMessages,
	refresh,
	setMessages,
	status,
	targetIdRef,
}: {
	builderRef: RefObject<AssistantBuilderSession | null>;
	convId: string;
	loadMessages: ReturnType<typeof useChatHistoryContext>["loadMessages"];
	refresh: () => void;
	setMessages: UseChatHelpers<UIMessage>["setMessages"];
	status: UseChatHelpers<UIMessage>["status"];
	targetIdRef: RefObject<string | null>;
}) {
	// Rehydrate a previously-sent thread when the panel reopens on the same id
	// (the panel unmounts while closed, so in-memory messages are lost). Skipped
	// in builder mode — builder threads are ephemeral (`persist: false`). The
	// empty-history early return is load-bearing: it also fires right after the
	// first send, before Core has persisted anything — wiping useChat then would
	// drop the just-sent turn.
	useEffect(() => {
		if (builderRef.current) {
			return;
		}
		let cancelled = false;
		loadMessages(convId).then((history) => {
			if (cancelled || history.length === 0) {
				return;
			}
			setMessages(
				history.map((message) => hydrateHistoryMessage(message, Date.now()))
			);
		});
		return () => {
			cancelled = true;
		};
	}, [convId, loadMessages, setMessages]);

	// When a reply finishes: generic mode re-syncs the shared chat history (so the
	// new conversation + auto-title show up in the sidebar); builder mode refetches
	// the edited record so the page (config form / canvas) updates live.
	const prevStatus = useRef(status);
	useEffect(() => {
		const was = prevStatus.current;
		prevStatus.current = status;
		if (status !== "ready" || !(was === "streaming" || was === "submitted")) {
			return;
		}
		const session = builderRef.current;
		if (session) {
			const id = targetIdRef.current ?? session.targetId;
			if (id) {
				session.onChanged(id);
			}
		} else {
			refresh();
		}
	}, [status, refresh]);
}
