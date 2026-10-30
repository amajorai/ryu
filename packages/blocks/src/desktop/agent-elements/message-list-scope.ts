import type { useMessageListFollow } from "./message-list-follow.ts";
import type { useMessageListTurns } from "./message-list-turns.tsx";
import type { MessageListProps } from "./message-list-types.ts";

/** The props after MessageList's parameter defaults are applied. */
export type MessageListBaseScope = Omit<
	MessageListProps,
	| "showCopyToolbar"
	| "suppressQuestionTool"
	| "initialScrollBehavior"
	| "enableImagePreview"
	| "statsPluginEnabled"
> &
	Required<
		Pick<
			MessageListProps,
			| "showCopyToolbar"
			| "suppressQuestionTool"
			| "initialScrollBehavior"
			| "enableImagePreview"
			| "statsPluginEnabled"
		>
	>;

/** Every binding MessageList computes, in render order. */
export type MessageListScope = MessageListBaseScope &
	ReturnType<typeof useMessageListFollow> &
	ReturnType<typeof useMessageListTurns>;
