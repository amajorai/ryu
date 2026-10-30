import { AvatarConversationProvider } from "@ryu/ui/components/avatar-conversation.tsx";
import { useMemo } from "react";
import type { getAgentChatNodes } from "./agent-chat-nodes.tsx";
import type { useAgentChatPrompts } from "./agent-chat-prompts.tsx";
import type { AgentChatBaseScope } from "./agent-chat-scope.ts";
import {
	ConversationActivityProvider,
	describeConversationActivity,
} from "./conversation-activity.ts";

export type UseAgentChatSurfaceInput = AgentChatBaseScope &
	ReturnType<typeof useAgentChatPrompts> &
	ReturnType<typeof getAgentChatNodes>;

/** Density, conversation activity and the chat surface. */
export function useAgentChatSurface({
	density,
	visiblePendingQuestion,
	status,
	error,
	messages,
	chatNode,
}: UseAgentChatSurfaceInput) {
	// Stable identity: the provider memoises its merged prefs on `value`, so an
	// inline `{ density }` re-rendered every transcript consumer on every chunk.
	const densityPrefs = useMemo(
		() => (density ? { density } : undefined),
		[density]
	);
	const resolvedActivity = describeConversationActivity({
		status,
		error,
		pendingQuestion: Boolean(visiblePendingQuestion),
		messages,
	});
	// Keyed on the primitives so header consumers re-render when the activity
	// changes, not on every streamed chunk.
	const activity = useMemo(
		() => ({ label: resolvedActivity.label, state: resolvedActivity.state }),
		[resolvedActivity.label, resolvedActivity.state]
	);
	const chatSurface = (
		<AvatarConversationProvider state={activity.state}>
			<ConversationActivityProvider value={activity}>
				{chatNode}
			</ConversationActivityProvider>
		</AvatarConversationProvider>
	);
	return { densityPrefs, chatSurface } as const;
}
