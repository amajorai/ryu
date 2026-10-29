// apps/desktop/src/contexts/TabNodeChatHistory.tsx
//
// Tab-scoped chat history. The app mounts ONE `ChatHistoryProvider`, outside
// every tab, and it talks to the default computer. A tab bound to another
// computer (a per-tab node override: the TitleBar "Connect to node" menu, an
// "All computers" sidebar row, a Continue-on-node handoff) streams through
// `useActiveNode()`, which honours the override, but ChatPage reads its
// transcript and list through `useChatHistoryContext()`. Without this boundary
// that read went to the default computer, so a remote tab showed the wrong
// node's copy of the thread, or nothing.
//
// The boundary sits in `CurrentTabIdProvider`, the one place every tab surface
// (TabViewPane, RouteWorkbenchItem, the panel dock) already passes through. When
// the tab's override resolves to a different authority than the default, the
// subtree gets its own provider pinned to that node; the provider's generation
// guard then drops any late write from a previous node, exactly as it does for a
// global switch. A tab without an override renders its children untouched.
//
// `tabId` is a prop (not `useCurrentTabId()`) so this module never imports
// `TabsContext` and there is no import cycle.

import { QueryClientContext } from "@tanstack/react-query";
import { type ReactNode, useContext, useEffect, useRef } from "react";
import {
	ChatHistoryProvider,
	useChatHistoryContext,
} from "@/src/contexts/ChatHistoryContext.tsx";
import { useNodeTabOverride } from "@/src/hooks/useNodeDisplayMode.ts";
import { type Node, useNodeStore } from "@/src/store/useNodeStore.ts";

/** True when two nodes address the same Core with the same credentials. */
function sameAuthority(a: Node, b: Node): boolean {
	return (
		a.url === b.url &&
		(a.token ?? null) === (b.token ?? null) &&
		(a.userJwt ?? null) === (b.userJwt ?? null)
	);
}

/** The node a tab is bound to when that differs from the default authority. */
export function useTabBoundNode(tabId: string | undefined): Node | null {
	const overridesEnabled = useNodeTabOverride();
	const overrideName = useNodeStore((s) =>
		tabId === undefined ? undefined : s.tabOverrides[tabId]
	);
	const overrideNode = useNodeStore((s) =>
		overrideName ? s.nodes.find((n) => n.name === overrideName) : undefined
	);
	const defaultNode = useNodeStore((s) => s.getActiveNode());
	if (!(overridesEnabled && overrideNode)) {
		return null;
	}
	return sameAuthority(overrideNode, defaultNode) ? null : overrideNode;
}

/**
 * Keeps the "All computers" sidebar's read-only list for `nodeName` in step
 * with this tab's own provider: when a turn in the tab changes the node's
 * thread list, the sidebar's cached query is marked stale instead of waiting
 * for its next poll. Renders nothing; tolerant of a tree with no query client.
 */
function NodeConversationsSync({ nodeName }: { nodeName: string }) {
	const queryClient = useContext(QueryClientContext);
	const { conversations } = useChatHistoryContext();
	const first = useRef(true);
	useEffect(() => {
		if (first.current) {
			first.current = false;
			return;
		}
		if (conversations) {
			queryClient?.invalidateQueries({
				queryKey: ["node-conversations", nodeName],
			});
		}
	}, [conversations, nodeName, queryClient]);
	return null;
}

export function TabNodeChatHistoryBoundary({
	tabId,
	children,
}: {
	tabId: string;
	children: ReactNode;
}) {
	const node = useTabBoundNode(tabId);
	if (!node) {
		return children;
	}
	// Keyed by name: a tab moved from one remote computer to another gets a
	// fresh provider rather than one that briefly holds the old node's list.
	return (
		<ChatHistoryProvider key={node.name} node={node}>
			<NodeConversationsSync nodeName={node.name} />
			{children}
		</ChatHistoryProvider>
	);
}
