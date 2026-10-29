declare const window: Window;

// Proof for chat-history hover prefetch: the REAL sidebar rows inside the REAL
// `ChatHistoryProvider`, with `fetch` standing in for Core. History pages answer
// after HISTORY_LATENCY_MS and every page request is counted.
//
// Resting the pointer on a row should start exactly one page fetch; opening that
// conversation right after should resolve from it without a second request.
// Opening a conversation that was never hovered pays the full latency.
// `window.__openConversation(id)` times `loadMessagesPageResult`, the call
// ChatPage makes when it mounts.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { SidebarConversationList } from "../../src/components/layout/AppSidebar.tsx";
import type { ChatRowHandlers } from "../../src/components/layout/sidebar-conversation-rows.tsx";
import {
	ChatHistoryProvider,
	useChatHistoryContext,
} from "../../src/contexts/ChatHistoryContext.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { TabsProvider } from "../../src/contexts/TabsContext.tsx";
import type { Conversation } from "../../types/chat.ts";
import "../../src/index.css";

const HISTORY_LATENCY_MS = 400;

function conversation(
	id: string,
	title: string,
	updatedAt: number
): Conversation {
	return {
		agentId: "builder",
		createdAt: updatedAt,
		id,
		lastMessage: `${title} latest update`,
		lastMessageAt: updatedAt,
		lastMessageRole: "assistant",
		messageCount: 2,
		messages: [],
		title,
		updatedAt,
	};
}

const SESSIONS = [
	conversation("hovered", "Hover me, then open", 30),
	conversation("cold", "Open me without hovering", 20),
];

const pageRequests: string[] = [];
Reflect.set(window, "__pageRequests", pageRequests);

const json = <FixturePayload,>(value: FixturePayload) =>
	new Response(JSON.stringify(value), {
		headers: { "content-type": "application/json" },
		status: 200,
	});

const realFetch = window.fetch.bind(globalThis);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = input instanceof Request ? input.url : String(input);
	const page = url.match(/\/api\/conversations\/([^/?]+)\?/);
	if (page) {
		const id = decodeURIComponent(page[1] ?? "");
		pageRequests.push(id);
		await new Promise((resolve) => setTimeout(resolve, HISTORY_LATENCY_MS));
		return json({
			has_older_messages: false,
			messages: [
				{ content: `Question in ${id}`, id: `${id}-u`, role: "user" },
				{ content: `Answer in ${id}`, id: `${id}-a`, role: "assistant" },
			],
		});
	}
	if (url.includes("/api/conversations")) {
		return json({ conversations: [] });
	}
	if (url.includes("/api/plugins/contributions")) {
		return json({ context_menu_items: [] });
	}
	if (url.includes("/learning")) {
		return json({ excluded: false });
	}
	if (url.includes("/title-history")) {
		return json([]);
	}
	return realFetch(input, init);
};

const noOp = () => undefined;
const handlers: ChatRowHandlers = {
	activeConversationId: null,
	agents: [],
	archivedIds: new Set<string>(),
	canMakePrivate: true,
	loadMessages: async () => [],
	onAddScheduledTask: noOp,
	onDeleteConversation: noOp,
	onForkConversation: noOp,
	onJumpToMessage: noOp,
	onMarkRead: noOp,
	onMarkUnread: noOp,
	onOpenQuickReply: noOp,
	onOpenInNewTab: noOp,
	onOpenInNewWindow: noOp,
	onOpenNewSideChat: noOp,
	onOpenSideChat: noOp,
	onMoveToProject: noOp,
	onRemoveFromProject: noOp,
	onRenameConversation: noOp,
	onRequestConversationVisibility: noOp,
	onSelectConversation: noOp,
	onSetConversationIcon: noOp,
	onToggleArchive: noOp,
	onTogglePin: noOp,
	pinnedIds: new Set<string>(),
	projectTargets: [],
	projectNameForFolder: () => "proof",
	pullRequestsEnabled: false,
	schedulingEnabled: false,
	sideChatsEnabled: false,
	target: { token: null, url: "http://prefetch-proof.local" },
	unreadIds: new Set<string>(),
};

function OpenProbe() {
	const { loadMessagesPageResult } = useChatHistoryContext();
	Reflect.set(window, "__openConversation", async (id: string) => {
		const started = performance.now();
		const result = await loadMessagesPageResult(id);
		return {
			messages: result.messages.length,
			ms: Math.round(performance.now() - started),
			status: result.status,
		};
	});
	return null;
}

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

function Story() {
	return (
		<ThemeProvider attribute="class" defaultTheme="dark" forcedTheme="dark">
			<QueryClientProvider client={queryClient}>
				<EntitlementProvider>
					<TabsProvider>
						<ChatHistoryProvider>
							<OpenProbe />
							<main className="min-h-screen bg-background p-8 text-foreground">
								<section
									className="mx-auto w-[380px] rounded-2xl border border-border/70 bg-sidebar p-3"
									data-testid="chat-history-prefetch-proof"
								>
									<SidebarConversationList
										conversations={SESSIONS}
										groupMultiParticipant={false}
										handlers={handlers}
										pageSize={10}
									/>
								</section>
							</main>
						</ChatHistoryProvider>
					</TabsProvider>
				</EntitlementProvider>
			</QueryClientProvider>
		</ThemeProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
