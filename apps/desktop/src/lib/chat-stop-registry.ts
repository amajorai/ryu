// Chat pages stay mounted while users move between tabs. Keep the active local
// stop handlers addressable by conversation id so shell actions such as Archive
// can interrupt the exact chat they mutate, even when that tab is not focused.

type ChatStopHandler = () => void;

const activeStops = new Map<string, Set<ChatStopHandler>>();

/** Register a mounted chat's local stop handler and return its cleanup function. */
export function registerChatStop(
	conversationId: string,
	handler: ChatStopHandler
): () => void {
	const handlers = activeStops.get(conversationId) ?? new Set();
	handlers.add(handler);
	activeStops.set(conversationId, handlers);

	return () => {
		const current = activeStops.get(conversationId);
		if (!current) {
			return;
		}
		current.delete(handler);
		if (current.size === 0) {
			activeStops.delete(conversationId);
		}
	};
}

/** Stop every local stream currently registered for a conversation. */
export function stopConversation(conversationId: string): boolean {
	const handlers = activeStops.get(conversationId);
	if (!handlers || handlers.size === 0) {
		return false;
	}

	for (const handler of Array.from(handlers)) {
		handler();
	}
	return true;
}
