import type { Conversation } from "@/types/chat.ts";

/**
 * Core stores the primary agent in `agentId` and additional agents in
 * `participants`. Older summaries only carried `agentId`, so keep the union in
 * one place for every sidebar and merged-thread consumer.
 */
export function conversationParticipantIds(
	conversation: Pick<Conversation, "agentId" | "participants">
): string[] {
	const ids = [conversation.agentId, ...(conversation.participants ?? [])];
	return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}

/** A conversation with more than one participant is shown as a group chat. */
export function isGroupConversation(
	conversation: Pick<Conversation, "agentId" | "participants">
): boolean {
	return conversationParticipantIds(conversation).length > 1;
}

/** Sort conversations by the activity stamp users see in the sidebar. */
export function sortConversationsByActivity(
	conversations: Conversation[]
): Conversation[] {
	const stampOf = (conversation: Conversation) =>
		conversation.lastMessageAt ?? conversation.updatedAt;
	return [...conversations].sort((a, b) => stampOf(b) - stampOf(a));
}

/**
 * Direct/private threads for one bot. Group conversations are deliberately
 * excluded: they belong in the group-chat branch of the Chats section instead
 * of being duplicated under every participating bot.
 */
export function directAgentThreads(
	agentId: string,
	conversations: Conversation[]
): Conversation[] {
	return sortConversationsByActivity(
		conversations.filter(
			(conversation) =>
				!(conversation.archived || isGroupConversation(conversation)) &&
				conversationParticipantIds(conversation).includes(agentId)
		)
	);
}

/** Conversations that cannot be represented beneath one known bot row. */
export function conversationsForOtherChats(
	conversations: Conversation[],
	knownAgentIds: ReadonlySet<string>
): Conversation[] {
	return conversations.filter((conversation) => {
		const ids = conversationParticipantIds(conversation);
		return ids.length !== 1 || !knownAgentIds.has(ids[0] ?? "");
	});
}

/** A stable key for grouping all conversations with the same participants. */
export function conversationGroupKey(
	conversation: Pick<Conversation, "agentId" | "participants">
): string | null {
	const ids = conversationParticipantIds(conversation);
	return ids.length > 1 ? ids.sort().join("\u001f") : null;
}

/** True for the title Core assigns to a forked conversation. */
export function isForkedConversation(conversation: Conversation): boolean {
	return /\s\(branch\)$/.test(conversation.title.trim());
}
