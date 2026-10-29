// apps/desktop/src/hooks/useOpenConversationEvents.ts
//
// The shell side of the blocks package's `OPEN_CONVERSATION_EVENT`. Components
// in `@ryu/blocks` (the session cards a coordinator's `threads.*` calls render
// as) cannot reach the desktop's tab system, so they raise a window event and
// this opens the conversation in a tab — reusing the tab when it is open.

import {
	OPEN_CONVERSATION_EVENT,
	type OpenConversationDetail,
} from "@ryu/blocks/desktop/agent-elements/tools/session-card-tool-logic.ts";
import { useEffect } from "react";

export function useOpenConversationEvents(
	openTab: (
		path: string,
		opts?: { conversationId?: string; title?: string }
	) => void
): void {
	useEffect(() => {
		const onOpen = (event: Event) => {
			// SAFETY: requestOpenConversation publishes this named event with the complete
			// OpenConversationDetail owner; DOM EventListener erases the detail type.
			const detail = (event as CustomEvent<OpenConversationDetail>).detail;
			const conversationId = detail?.conversationId?.trim();
			if (!conversationId) {
				return;
			}
			openTab("/chat", { conversationId, title: detail.title });
		};
		window.addEventListener(OPEN_CONVERSATION_EVENT, onOpen);
		return () => window.removeEventListener(OPEN_CONVERSATION_EVENT, onOpen);
	}, [openTab]);
}
