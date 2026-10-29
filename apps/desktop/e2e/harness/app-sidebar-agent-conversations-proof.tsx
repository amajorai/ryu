import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import type { ContextType } from "react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
	AgentThreadList,
	MessagingAgentRowBody,
	SidebarConversationList,
} from "../../src/components/layout/AppSidebar.tsx";
import type { ChatRowHandlers } from "../../src/components/layout/sidebar-conversation-rows.tsx";
import { TabsContext } from "../../src/contexts/TabsContext.tsx";
import type { AgentSummary } from "../../src/lib/api/agents.ts";
import type { Conversation } from "../../types/chat.ts";
import { createTabsProofContext } from "./tabs-proof-context.ts";
import "../../src/index.css";

const NOW = Date.now();
const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

const BUILDER: AgentSummary = {
	avatarUrl: null,
	builtIn: true,
	createdAt: null,
	description: "Builder proof agent",
	engine: "ryu",
	id: "builder",
	installHint: null,
	installed: true,
	latestVersion: null,
	locked: false,
	model: null,
	name: "Builder",
	recommended: false,
	systemPrompt: null,
	transport: "acp",
	version: null,
	versionStatus: "unknown",
};

function thread(
	id: string,
	title: string,
	updatedAt: number,
	options: Partial<Conversation> = {}
): Conversation {
	return {
		createdAt: updatedAt,
		id,
		lastMessage: `Latest update for ${title}`,
		lastMessageAt: updatedAt,
		lastMessageRole: "assistant",
		messages: [],
		title,
		updatedAt,
		...options,
	};
}

const DIRECT_THREADS = [
	thread("builder-branch", "Design review (branch)", NOW - 60_000, {
		agentId: BUILDER.id,
		lastMessage: "The branch has the revised layout.",
	}),
	thread("builder-main", "Design review", NOW - 3_600_000, {
		agentId: BUILDER.id,
		lastMessage: "The main thread remains intact.",
	}),
];

const GROUP_THREADS = [
	thread("group-branch", "Launch plan (branch)", NOW - 120_000, {
		lastMessage: "Reviewer joined the launch branch.",
		participants: ["builder", "reviewer"],
	}),
	thread("group-main", "Launch plan", NOW - 7_200_000, {
		lastMessage: "Builder shared the launch checklist.",
		participants: ["builder", "reviewer"],
	}),
];

const REVIEWER: AgentSummary = {
	...BUILDER,
	engine: "claude",
	id: "reviewer",
	name: "Reviewer",
};

type TabOptions = NonNullable<
	Parameters<NonNullable<ContextType<typeof TabsContext>>["openTab"]>[1]
>;

interface RouteEvent {
	options: TabOptions;
	path: string;
}

function Story() {
	const [events, setEvents] = useState<RouteEvent[]>([]);
	const [threadsExpanded, setThreadsExpanded] = useState(false);
	const [unreadIds, setUnreadIds] = useState<Set<string>>(new Set());
	const openTab = (path: string, options: TabOptions = {}) => {
		setEvents((current) => [...current, { options, path }]);
		return "proof-tab";
	};
	const chatHandlers: ChatRowHandlers = {
		activeConversationId: null,
		agents: [BUILDER, REVIEWER],
		archivedIds: new Set(),
		canMakePrivate: true,
		loadMessages: async () => [],
		onAddScheduledTask: () => undefined,
		onDeleteConversation: () => undefined,
		onForkConversation: () => undefined,
		onJumpToMessage: () => undefined,
		onMarkRead: (id) =>
			setUnreadIds((current) => {
				const next = new Set(current);
				next.delete(id);
				return next;
			}),
		onMarkUnread: (id) => setUnreadIds((current) => new Set(current).add(id)),
		onOpenInNewTab: (id) =>
			openTab("/chat", { conversationId: id, forceNew: true }),
		onOpenInNewWindow: (id) => openTab("/chat/window", { conversationId: id }),
		onOpenNewSideChat: () => undefined,
		onOpenQuickReply: (id) =>
			openTab("/chat/quick-reply", { conversationId: id }),
		onOpenSideChat: () => undefined,
		onMoveToProject: () => undefined,
		onRemoveFromProject: () => undefined,
		onRenameConversation: () => undefined,
		onRequestConversationVisibility: () => undefined,
		onSelectConversation: (id) => openTab("/chat", { conversationId: id }),
		onSetConversationIcon: () => undefined,
		onToggleArchive: () => undefined,
		onTogglePin: () => undefined,
		pinnedIds: new Set(),
		projectTargets: [],
		projectNameForFolder: (folderPath) => folderPath,
		target: { token: null, url: "http://proof.local" },
		unreadIds,
	};

	return (
		<ThemeProvider
			attribute="class"
			defaultTheme="dark"
			enableSystem={false}
			forcedTheme="dark"
		>
			<QueryClientProvider client={queryClient}>
				<TabsContext.Provider value={createTabsProofContext({ openTab })}>
					<main className="min-h-screen bg-background p-6 text-foreground">
						<div className="mx-auto grid max-w-[1040px] gap-6 lg:grid-cols-2">
							<section className="rounded-xl border border-border bg-sidebar p-3">
								<h1 className="mb-3 px-2 font-semibold text-sm">Agents</h1>
								<div
									aria-label="Open Builder agent conversation"
									className="group/row flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted"
									data-testid="messaging-agent-row"
									onClick={() =>
										openTab("/chat/agent/builder", { title: BUILDER.name })
									}
									onKeyDown={(event) => {
										if (event.key === "Enter") {
											openTab("/chat/agent/builder", { title: BUILDER.name });
										}
									}}
									role="button"
									tabIndex={0}
								>
									<MessagingAgentRowBody
										agent={BUILDER}
										conversation={DIRECT_THREADS[0]}
										onEdit={() =>
											openTab("/agents/builder/edit", { title: BUILDER.name })
										}
										onToggleThreads={() =>
											setThreadsExpanded((current) => !current)
										}
										threadCount={DIRECT_THREADS.length}
										threadsExpanded={threadsExpanded}
										usageBarVisible={false}
									/>
								</div>
								{threadsExpanded ? (
									<AgentThreadList
										loadMessages={async () => []}
										onMarkRead={chatHandlers.onMarkRead}
										onMarkUnread={chatHandlers.onMarkUnread}
										onOpen={(id) => openTab("/chat", { conversationId: id })}
										onOpenQuickReply={chatHandlers.onOpenQuickReply}
										pageSize={1}
										threads={DIRECT_THREADS}
										unreadIds={unreadIds}
									/>
								) : null}
							</section>
							<section className="rounded-xl border border-border bg-sidebar p-3">
								<h2 className="mb-3 px-2 font-semibold text-sm">Other chats</h2>
								<SidebarConversationList
									conversations={GROUP_THREADS}
									handlers={chatHandlers}
									pageSize={1}
								/>
							</section>
						</div>
						<output className="sr-only" data-testid="route-events">
							{JSON.stringify(events)}
						</output>
					</main>
				</TabsContext.Provider>
			</QueryClientProvider>
		</ThemeProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
