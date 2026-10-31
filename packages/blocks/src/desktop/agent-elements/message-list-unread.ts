import type { LiteralMessage } from "@ryu/i18n/react";
import type { UIMessage } from "ai";

export interface UnreadMessageState {
	conversationKey: string | null;
	incomingIds: readonly string[];
	unreadIds: readonly string[];
}

export function getIncomingMessageIds(
	messages: readonly Pick<UIMessage, "id" | "role">[]
): string[] {
	const seen = new Set<string>();
	const ids: string[] = [];

	for (const message of messages) {
		if (message.role !== "assistant" || seen.has(message.id)) {
			continue;
		}
		seen.add(message.id);
		ids.push(message.id);
	}

	return ids;
}

export function getUnreadMessageLabel(
	count: number,
	tl: LiteralMessage
): string {
	return tl(
		"{count, plural, one {{countLabel} new message} other {{countLabel} new messages}}",
		{ count, countLabel: String(count) }
	);
}

export function createUnreadMessageState(
	conversationKey: string | null,
	incomingIds: readonly string[]
): UnreadMessageState {
	return {
		conversationKey,
		incomingIds: [...incomingIds],
		unreadIds: [],
	};
}

export function reconcileUnreadMessageState(
	state: UnreadMessageState | null,
	conversationKey: string | null,
	incomingIds: readonly string[],
	following: boolean
): UnreadMessageState {
	if (!state || state.conversationKey !== conversationKey) {
		return createUnreadMessageState(conversationKey, incomingIds);
	}

	const previousIds = new Set(state.incomingIds);
	const nextIds = new Set(incomingIds);
	const newlyArrivedIds = incomingIds.filter((id) => !previousIds.has(id));
	const retainedUnreadIds = state.unreadIds.filter((id) => nextIds.has(id));

	return {
		conversationKey,
		incomingIds: [...incomingIds],
		unreadIds: following
			? []
			: [...new Set([...retainedUnreadIds, ...newlyArrivedIds])],
	};
}

export function clearUnreadMessageState(
	state: UnreadMessageState
): UnreadMessageState {
	return { ...state, unreadIds: [] };
}
