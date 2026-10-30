"use client";

import { useAgentChatDraft } from "./agent-chat-draft.ts";
import { getAgentChatNodes } from "./agent-chat-nodes.tsx";
import { useAgentChatPrompts } from "./agent-chat-prompts.tsx";
import type {
	AgentChatScope,
	AgentChatSurfaceProps,
} from "./agent-chat-scope.ts";
import { useAgentChatSurface } from "./agent-chat-surface.tsx";
import { ChatDisplayPrefsProvider } from "./chat-display-prefs.tsx";

export {
	appendDraftInsertion,
	findPendingQuestion,
	mergeDraftSeedWithInsertions,
} from "./agent-chat-helpers.tsx";
export type { AgentChatSurfaceProps } from "./agent-chat-scope.ts";
export type { LiveMessagesSource } from "./live-message-list.tsx";

export function AgentChat({
	emptyStatePosition = "default",
	emptySuggestionsPlacement = "input",
	emptySuggestionsPosition = "top",
	...props
}: AgentChatSurfaceProps) {
	// Each hook reads only bindings that earlier hooks already assigned.
	const scope = {
		...props,
		emptyStatePosition,
		emptySuggestionsPlacement,
		emptySuggestionsPosition,
	} as AgentChatScope;
	Object.assign(scope, useAgentChatDraft(scope));
	Object.assign(scope, useAgentChatPrompts(scope));
	Object.assign(scope, getAgentChatNodes(scope));
	Object.assign(scope, useAgentChatSurface(scope));
	const { densityPrefs, chatSurface } = scope;
	return densityPrefs ? (
		<ChatDisplayPrefsProvider value={densityPrefs}>
			{chatSurface}
		</ChatDisplayPrefsProvider>
	) : (
		chatSurface
	);
}

// Legacy component alias kept for compatibility.
export const AnAgentChat = AgentChat;
