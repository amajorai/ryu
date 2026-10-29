import type { ReactNode } from "react";
import type { CoreConversationSummary } from "@/src/contexts/ChatHistoryContext.tsx";
import type { Conversation } from "@/types/chat.ts";

const context = {
	conversations: [],
	getConversation: () => undefined,
	loadMessages: async () => [],
	renameConversation: (conversationId: string, title: string) => {
		window.__VERTICAL_TAB_PROOF__?.renameCalls.push({ conversationId, title });
	},
};

export function ChatHistoryProvider({ children }: { children: ReactNode }) {
	return children;
}

export function useChatHistoryContext() {
	return context;
}

// Sidebar/titlebar prefetch is optional in this isolated history fixture.
export function useOptionalChatHistoryContext() {
	return context;
}

const noRunningMainThreads: ReadonlySet<string> = new Set();
export function useRunningMainThreadIds(): ReadonlySet<string> {
	return noRunningMainThreads;
}

// useNodeConversations imports this mapper from the real context. The fixture
// serves no remote node conversations, so only the identity fields matter.
export function summaryToConversation(
	summary: CoreConversationSummary
): Conversation {
	return {
		id: summary.id,
		title: summary.title ?? "Untitled",
		messages: [],
		createdAt: summary.created_at,
		updatedAt: summary.updated_at,
	};
}
