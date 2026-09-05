import {
	Sidebar,
	SidebarContent,
	SidebarProvider,
} from "@ryu/ui/components/sidebar.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { ChatsSection } from "../../src/components/layout/AppSidebar.tsx";
import type { ChatRowHandlers } from "../../src/components/layout/sidebar-conversation-rows.tsx";
import {
	type AppSurface,
	AppSurfaceProvider,
} from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { TabsProvider } from "../../src/contexts/TabsContext.tsx";
import type { Conversation } from "../../types/chat.ts";
import "../../src/index.css";

const PROOF_TARGET = { token: null, url: "http://proof.local" };
const STORAGE_KEY = "ryu:bot-chat-sections:v1";
const ORDER_KEY = "ryu:bot-chat-section-order:v1";
const COLLAPSED_KEY = "ryu:bot-chat-section-collapsed:v1";

function conversation(
	id: string,
	title: string,
	updatedAt: number,
	lastMessageAt: number
): Conversation {
	return {
		createdAt: updatedAt,
		id,
		lastMessage: `${title} latest update`,
		lastMessageAt,
		lastMessageRole: "assistant",
		messageCount: 2,
		messages: [],
		participants: [],
		title,
		updatedAt,
	};
}

const CONVERSATIONS = [
	conversation("chat-newer", "Newer follow-up", 20, 90),
	conversation("chat-older", "Older follow-up", 80, 60),
	conversation("chat-loose", "Loose planning chat", 40, 40),
];

const noOp = () => undefined;
const handlers = {
	activeConversationId: null,
	agents: [],
	archivedIds: new Set<string>(),
	canMakePrivate: true,
	loadMessages: () => Promise.resolve([]),
	onAddScheduledTask: noOp,
	onDeleteConversation: noOp,
	onForkConversation: noOp,
	onJumpToMessage: noOp,
	onMarkRead: noOp,
	onMarkUnread: noOp,
	onOpenInNewTab: noOp,
	onOpenInNewWindow: noOp,
	onOpenNewSideChat: noOp,
	onOpenSideChat: noOp,
	onRenameConversation: noOp,
	onRemoveFromProject: noOp,
	onRequestConversationVisibility: noOp,
	onSelectConversation: noOp,
	onSetConversationIcon: noOp,
	onToggleArchive: noOp,
	onTogglePin: noOp,
	pinnedIds: new Set<string>(),
	projectNameForFolder: () => "proof",
	target: PROOF_TARGET,
	unreadIds: new Set<string>(),
} as unknown as ChatRowHandlers;

const dnd = {
	draggingKey: null,
	dragOverKey: null,
	onDragEnd: noOp,
	onDragOver: noOp,
	onDragStart: noOp,
	onDrop: noOp,
	order: [],
};

const menu = {
	canMove: () => false,
	onHide: noOp,
	onMove: noOp,
	onOpenCustomize: noOp,
	onSetPageSize: noOp,
	onSetSort: noOp,
};

const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
	const url = typeof input === "string" ? input : input.toString();
	if (url.includes("/api/plugins/contributions")) {
		return Promise.resolve(
			new Response(JSON.stringify({ context_menu_items: [] }), {
				headers: { "content-type": "application/json" },
				status: 200,
			})
		);
	}
	if (url.includes("/learning")) {
		return Promise.resolve(
			new Response(JSON.stringify({ excluded: false }), {
				headers: { "content-type": "application/json" },
				status: 200,
			})
		);
	}
	if (url.includes("/title-history")) {
		return Promise.resolve(
			new Response(JSON.stringify([]), {
				headers: { "content-type": "application/json" },
				status: 200,
			})
		);
	}
	return realFetch(input as RequestInfo, init);
}) as typeof fetch;

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

function surfaceFromUrl(): AppSurface {
	return new URLSearchParams(window.location.search).get("surface") === "web"
		? "web"
		: "desktop";
}

function Story() {
	if (new URLSearchParams(window.location.search).has("reset")) {
		localStorage.removeItem(STORAGE_KEY);
		localStorage.removeItem(ORDER_KEY);
		localStorage.removeItem(COLLAPSED_KEY);
	}

	return (
		<AppSurfaceProvider surface={surfaceFromUrl()}>
			<QueryClientProvider client={queryClient}>
				<EntitlementProvider>
					<TabsProvider>
						<main className="min-h-screen bg-background p-6 text-foreground">
							<div className="mb-4 max-w-sm">
								<h1 className="font-semibold text-lg">
									Agents view · Other chats
								</h1>
								<p className="mt-1 text-muted-foreground text-sm">
									Local custom chat sections proof.
								</p>
							</div>
							<SidebarProvider className="h-[660px] w-[360px]">
								<Sidebar collapsible="none" variant="sidebar">
									<SidebarContent>
										<ChatsSection
											botMode
											collapsed={false}
											dnd={dnd}
											handlers={handlers}
											loose={CONVERSATIONS}
											menu={menu}
											onImport={noOp}
											onImportSetup={noOp}
											onNew={noOp}
											onToggleCollapsed={noOp}
											pageSize={10}
											sectionKey="chats"
											sort="default"
										/>
									</SidebarContent>
								</Sidebar>
							</SidebarProvider>
							<output className="sr-only" data-testid="proof-status" />
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
