import { translate as tl } from "@ryu/i18n/core";

export interface SidebarConversationPreviewInput {
	lastMessage?: string;
	lastMessageRole?: string;
	statusLabel?: string;
	statusVisible?: boolean;
}

/**
 * Build the small set of activity states a sidebar row can show.
 *
 * Core's conversation list intentionally returns the latest conversational
 * message, while the persisted run status tells us when the latest activity is
 * still working or needs attention. Keeping this derivation pure makes the
 * normal Chats rows and Agent/Bot rows use exactly the same copy and ordering.
 */
export function buildSidebarConversationPreviewStates({
	lastMessage,
	lastMessageRole,
	statusLabel,
	statusVisible = false,
}: SidebarConversationPreviewInput): string[] {
	const trimmedMessage = lastMessage?.trim();
	const states: string[] = [];

	if (trimmedMessage) {
		states.push(
			lastMessageRole === "user"
				? tl("You: {message}", { message: trimmedMessage })
				: trimmedMessage
		);
	}

	if (statusVisible && statusLabel) {
		states.push(statusLabel);
	}

	if (states.length === 0) {
		states.push(tl("No messages yet"));
	}

	return states;
}
