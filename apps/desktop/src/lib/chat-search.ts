/** The message fields needed by the chat-local find surface. */
export interface ChatSearchableMessage {
	content?: unknown;
	id: string;
	parts?: readonly unknown[];
	role?: string;
}

/** One message matched by the chat-local find surface. */
export interface ChatSearchMatch {
	/** The turn anchor that the transcript can scroll to. */
	anchorMessageId: string;
	content: string;
	messageId: string;
	role: string;
}

function textFromPart(part: unknown): string {
	if (typeof part !== "object" || part === null) {
		return "";
	}
	const candidate = part as { text?: unknown; type?: unknown };
	return candidate.type === "text" && typeof candidate.text === "string"
		? candidate.text
		: "";
}

/** Read the same visible text parts that the transcript renders. */
export function chatMessageText(message: ChatSearchableMessage): string {
	if (Array.isArray(message.parts) && message.parts.length > 0) {
		return message.parts.map(textFromPart).join("\n\n");
	}
	return typeof message.content === "string" ? message.content : "";
}

/**
 * Find literal, case-insensitive matches in the messages currently loaded into
 * the active chat. The preceding user message is the scroll anchor for an
 * assistant match because the transcript groups both sides into one turn.
 */
export function searchChatMessages(
	messages: readonly ChatSearchableMessage[],
	query: string
): ChatSearchMatch[] {
	const normalizedQuery = query.trim().toLocaleLowerCase();
	if (!normalizedQuery) {
		return [];
	}

	const matches: ChatSearchMatch[] = [];
	let currentAnchorMessageId: string | null = null;
	for (const message of messages) {
		if (message.role === "user") {
			currentAnchorMessageId = message.id;
		}
		const content = chatMessageText(message);
		if (!content.toLocaleLowerCase().includes(normalizedQuery)) {
			continue;
		}
		matches.push({
			anchorMessageId: currentAnchorMessageId ?? message.id,
			content,
			messageId: message.id,
			role: message.role?.trim() || "message",
		});
	}
	return matches;
}
