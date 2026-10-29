declare const window: Window;

// Standalone browser story for sidebar chat MULTI-SELECTION on the real `ChatRow`.
//
// Selection is a pointer + keyboard + DOM-order fact (shift-click ranges are
// computed from the rows actually rendered), so it is proven in a browser rather
// than a unit test. The only stubs are `fetch` (Core) and the sidebar-owned bulk
// actions, which record what they were asked to do.

import { SidebarMenu } from "@ryu/ui/components/sidebar.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { SidebarChatBulkActions } from "../../src/components/layout/sidebar-chat-selection.tsx";
import {
	useSidebarChatSelection,
	useSidebarChatSelectionEscape,
} from "../../src/components/layout/sidebar-chat-selection.tsx";
import {
	ChatRow,
	type ChatRowHandlers,
} from "../../src/components/layout/sidebar-conversation-rows.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { TabsProvider } from "../../src/contexts/TabsContext.tsx";
import type { Conversation } from "../../types/chat.ts";
import "../../src/index.css";

const CHATS: Conversation[] = ["a", "b", "c", "d", "e"].map((id, index) => ({
	createdAt: 1_777_000_000_000 - index,
	id: `chat-${id}`,
	messages: [],
	title: `Chat ${id.toUpperCase()}`,
	updatedAt: 1_777_000_000_000 - index,
}));

const realFetch = window.fetch.bind(globalThis);
window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
	const url = input instanceof Request ? input.url : String(input);
	if (url.includes("/api/")) {
		const body = url.includes("/api/plugins/contributions")
			? { context_menu_items: [] }
			: url.includes("/api/learn/exclude")
				? { excluded: false }
				: [];
		return Promise.resolve(
			new Response(JSON.stringify(body), {
				headers: { "content-type": "application/json" },
				status: 200,
			})
		);
	}
	return realFetch(input, init);
};

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

function Story() {
	const [opened, setOpened] = useState<string[]>([]);
	const [bulkLog, setBulkLog] = useState<string[]>([]);
	const selected = useSidebarChatSelection((state) => state.selectedIds);
	// The sidebar shell mounts this; the story stands in for it.
	useSidebarChatSelectionEscape();
	const log = (entry: string) => setBulkLog((current) => [...current, entry]);
	const bulk = useMemo<SidebarChatBulkActions>(
		() => ({
			deleteMany: (ids) => log(`delete:${ids.join(",")}`),
			dropTarget: () => ({ accepts: () => true, onDrop: () => undefined }),
			moveToProject: (ids, path) => log(`move:${path}:${ids.join(",")}`),
			openInNewTabs: (ids) => log(`open:${ids.join(",")}`),
			projects: [{ label: "ryu", path: "/code/ryu" }],
			setArchived: (ids, archived) =>
				log(`archive:${archived}:${ids.join(",")}`),
			setPinned: (ids, pinned) => log(`pin:${pinned}:${ids.join(",")}`),
			setRead: (ids, read) => log(`read:${read}:${ids.join(",")}`),
		}),
		[]
	);
	const noop = () => undefined;
	const handlers: ChatRowHandlers = {
		activeConversationId: opened.at(-1) ?? null,
		agents: [],
		archivedIds: new Set(),
		bulk,
		canMakePrivate: true,
		loadMessages: async () => [],
		onAddScheduledTask: noop,
		onDeleteConversation: noop,
		onForkConversation: noop,
		onJumpToMessage: noop,
		onMarkRead: noop,
		onMarkUnread: noop,
		onOpenInNewTab: noop,
		onOpenInNewWindow: noop,
		onOpenNewSideChat: noop,
		onOpenQuickReply: noop,
		onOpenSideChat: noop,
		onRemoveFromProject: noop,
		onRenameConversation: noop,
		onRequestConversationVisibility: noop,
		onSelectConversation: (id) => setOpened((current) => [...current, id]),
		onSetConversationIcon: noop,
		onToggleArchive: noop,
		onTogglePin: noop,
		pinnedIds: new Set(),
		projectNameForFolder: () => "ryu",
		target: { token: "token", url: `${window.location.origin}/node` },
		unreadIds: new Set(),
	};
	return (
		<AppSurfaceProvider surface="desktop">
			<QueryClientProvider client={queryClient}>
				<EntitlementProvider>
					<TabsProvider>
						<main className="min-h-screen bg-background p-8 text-foreground">
							<section className="mx-auto w-[24rem] rounded-2xl border border-border/70 bg-card p-4">
								<SidebarMenu>
									{CHATS.map((conv) => (
										<ChatRow conv={conv} handlers={handlers} key={conv.id} />
									))}
								</SidebarMenu>
							</section>
							<output data-testid="selected">
								{[...selected].sort().join(",")}
							</output>
							<output data-testid="opened">{opened.join(",")}</output>
							<output data-testid="bulk-log">{bulkLog.join("|")}</output>
						</main>
					</TabsProvider>
				</EntitlementProvider>
			</QueryClientProvider>
		</AppSurfaceProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
