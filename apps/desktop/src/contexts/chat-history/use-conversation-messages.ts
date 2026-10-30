// History reads for the chat history provider: full and paged message loads,
// and the hover/focus prefetch of a conversation's newest page.
// Called only by ChatHistoryProvider.

import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { type RefObject, useCallback } from "react";
import type { createPrefetchCache } from "@/src/lib/prefetch-cache.ts";
import type { Node } from "@/src/store/useNodeStore.ts";
import type { Message } from "@/types/chat.ts";
import {
	CHAT_HISTORY_PAGE_SIZE,
	type CoreConversationPage,
	type CoreMessage,
	coreFetch,
	mapCoreMessages,
} from "./core-conversation.ts";
import type { LoadMessagesResult } from "./types.ts";

export function useConversationMessages({
	activeNode,
	conversationVersion,
	ownsAuthority,
	prefetchedPages,
}: {
	activeNode: Node;
	conversationVersion: (id: string) => number | undefined;
	ownsAuthority: () => boolean;
	prefetchedPages: RefObject<
		ReturnType<typeof createPrefetchCache<LoadMessagesResult>>
	>;
}) {
	const loadMessagesResult = useCallback(
		async (id: string): Promise<LoadMessagesResult> => {
			if (!ownsAuthority()) {
				return { messages: [], status: "error" };
			}
			const { url, token, userJwt } = activeNode;
			try {
				const res = await coreFetch(
					url,
					token,
					`/api/conversations/${encodeURIComponent(id)}`,
					undefined,
					userJwt
				);
				// 404 is an ANSWER, not a failure: the node is up and says this
				// conversation is gone (deleted, or never persisted). That is the
				// "does not exist" state, which correctly falls through to the
				// new-chat surface — unlike an unreachable node, which must not.
				if (!ownsAuthority()) {
					return { messages: [], status: "error" };
				}
				if (res.status === 404) {
					return { status: "ok", messages: [] };
				}
				if (!res.ok) {
					return { status: "error", messages: [] };
				}
				const data: { messages?: CoreMessage[] } = await res.json();
				const messages = await mapCoreMessages(data.messages);
				if (!ownsAuthority()) {
					return { messages: [], status: "error" };
				}
				return {
					status: "ok",
					messages,
				};
			} catch {
				return { status: "error", messages: [] };
			}
		},
		[activeNode, ownsAuthority]
	);

	const fetchMessagesPage = useCallback(
		async (id: string, before?: string): Promise<LoadMessagesResult> => {
			if (!ownsAuthority()) {
				return { messages: [], status: "error" };
			}
			const { url, token, userJwt } = activeNode;
			const query = new URLSearchParams({
				limit: String(CHAT_HISTORY_PAGE_SIZE),
			});
			if (before) {
				query.set("before", before);
			}
			try {
				const res = await coreFetch(
					url,
					token,
					`/api/conversations/${encodeURIComponent(id)}?${query.toString()}`,
					undefined,
					userJwt
				);
				if (!ownsAuthority()) {
					return { messages: [], status: "error" };
				}
				if (res.status === 404) {
					return {
						hasOlderMessages: false,
						messages: [],
						status: "ok",
					};
				}
				if (!res.ok) {
					return { messages: [], status: "error" };
				}
				const data: CoreConversationPage = await res.json();
				const messages = await mapCoreMessages(data.messages);
				if (!ownsAuthority()) {
					return { messages: [], status: "error" };
				}
				return {
					hasOlderMessages: data.has_older_messages === true,
					messages,
					olderMessagesCursor: isNativeText(data.older_messages_cursor)
						? data.older_messages_cursor
						: undefined,
					status: "ok",
				};
			} catch {
				return { messages: [], status: "error" };
			}
		},
		[activeNode, ownsAuthority]
	);

	const prefetchConversation = useCallback(
		(id: string) => {
			if (!ownsAuthority()) {
				return;
			}
			prefetchedPages.current.start(
				`${activeNode.url}\n${id}`,
				conversationVersion(id),
				() => fetchMessagesPage(id)
			);
		},
		[activeNode.url, conversationVersion, fetchMessagesPage, ownsAuthority]
	);

	const loadMessagesPageResult = useCallback(
		async (
			id: string,
			before?: string,
			options?: { fresh?: boolean }
		): Promise<LoadMessagesResult> => {
			if (!ownsAuthority()) {
				return { messages: [], status: "error" };
			}
			// `fresh` skips a hover prefetch: a running thread changes under the
			// same conversation version, so only a new read is current.
			const prefetched =
				before || options?.fresh
					? undefined
					: prefetchedPages.current.take(
							`${activeNode.url}\n${id}`,
							conversationVersion(id)
						);
			const result = await prefetched;
			if (!ownsAuthority()) {
				return { messages: [], status: "error" };
			}
			// A failed prefetch is retried rather than reported: Core may simply
			// not have been ready when the pointer passed over the row.
			if (result?.status === "ok") {
				return result;
			}
			return fetchMessagesPage(id, before);
		},
		[activeNode.url, conversationVersion, fetchMessagesPage, ownsAuthority]
	);

	const loadMessages = useCallback(
		async (id: string): Promise<Message[]> => {
			const { messages } = await loadMessagesResult(id);
			return messages;
		},
		[loadMessagesResult]
	);
	return {
		loadMessages,
		loadMessagesPageResult,
		loadMessagesResult,
		prefetchConversation,
	};
}
