import { useEffect, useMemo } from "react";
import type { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import type { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import type { useAgents } from "@/src/hooks/useAgents.ts";
import { useAutoSetupImport } from "@/src/hooks/useAutoSetupImport.ts";
import { useAutoThreadImport } from "@/src/hooks/useAutoThreadImport.ts";
import { useConversationFlagsStore } from "@/src/store/useConversationFlagsStore.ts";

type ChatHistory = ReturnType<typeof useChatHistoryContext>;

/** The import target for the active node, plus the background auto-importers
 *  that feed agents' on-disk threads and setup into the conversation list. */
export function useSidebarAutoImport({
	activeNode,
	agents,
	refresh,
}: {
	activeNode: ReturnType<typeof useActiveNode>;
	agents: ReturnType<typeof useAgents>["agents"];
	refresh: ChatHistory["refresh"];
}) {
	const importTarget = useMemo(
		() => ({
			url: activeNode.url,
			token: activeNode.token,
			userJwt: activeNode.userJwt ?? null,
		}),
		[activeNode.url, activeNode.token, activeNode.userJwt]
	);
	// Background auto-import of agents' own on-disk threads, gated by the General
	// setting. Imports new threads into their workspace folders and refreshes the
	// conversation list so they appear grouped without a manual step.
	useAutoThreadImport({
		agents,
		target: importTarget,
		onImported: () => {
			refresh();
		},
	});
	// Background auto-import of setup *instructions* from the well-known agent
	// config roots, gated by the General setting (skills/MCP/plugins stay behind
	// the explicit review in the manual dialog).
	useAutoSetupImport({
		target: importTarget,
		onImported: () => {
			refresh();
		},
	});
	return importTarget;
}

/** Keep the pin/archive/unread store in step with the conversation list. */
export function useConversationFlagSync(
	conversations: ChatHistory["conversations"],
	activeConversationId: string | null
) {
	const observeMessageCounts = useConversationFlagsStore(
		(s) => s.observeMessageCounts
	);
	const mergeServerFlags = useConversationFlagsStore((s) => s.mergeServerFlags);
	useEffect(() => {
		observeMessageCounts(conversations, activeConversationId);
	}, [conversations, activeConversationId, observeMessageCounts]);

	// Merge server-backed pin/archive state (the same columns coordinator threads
	// write) into the localStorage-seeded sets. Union, not replace: existing local
	// pins are preserved (no destructive un-pin), and a conversation pinned by a
	// coordinator or another client shows up here. Going forward, toggles
	// write-through to Core so the two stay consistent.
	useEffect(() => {
		mergeServerFlags({
			pinned: conversations.filter((c) => c.pinned).map((c) => c.id),
			archived: conversations.filter((c) => c.archived).map((c) => c.id),
		});
	}, [conversations, mergeServerFlags]);
}
