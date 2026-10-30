import type { useAgentChatDraft } from "./agent-chat-draft.ts";
import type { getAgentChatNodes } from "./agent-chat-nodes.tsx";
import type { useAgentChatPrompts } from "./agent-chat-prompts.tsx";
import type { useAgentChatSurface } from "./agent-chat-surface.tsx";
import type { LiveMessagesSource } from "./live-message-list.tsx";
import type { AgentChatProps } from "./types.ts";

/** AgentChat's props: the surface props plus the host's live transcript view. */
export type AgentChatSurfaceProps = AgentChatProps & {
	/** Newer messages than `messages` for the transcript alone. A host whose page
	 * re-renders only on structural changes streams text through this. */
	liveMessages?: LiveMessagesSource;
};

/** The props after AgentChat's parameter defaults are applied. */
export type AgentChatBaseScope = Omit<
	AgentChatSurfaceProps,
	| "emptyStatePosition"
	| "emptySuggestionsPlacement"
	| "emptySuggestionsPosition"
> &
	Required<
		Pick<
			AgentChatProps,
			| "emptyStatePosition"
			| "emptySuggestionsPlacement"
			| "emptySuggestionsPosition"
		>
	>;

/** Every binding AgentChat computes, in render order. */
export type AgentChatScope = AgentChatBaseScope &
	ReturnType<typeof useAgentChatDraft> &
	ReturnType<typeof useAgentChatPrompts> &
	ReturnType<typeof getAgentChatNodes> &
	ReturnType<typeof useAgentChatSurface>;
