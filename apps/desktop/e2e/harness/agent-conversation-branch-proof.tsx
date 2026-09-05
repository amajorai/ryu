import { AgentMessageTool } from "@ryu/blocks/desktop/agent-elements/tools/agent-message-tool.tsx";
import type { AgentMessageContext } from "@ryu/blocks/desktop/agent-elements/types.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
	AgentThreadList,
	MessagingAgentRowBody,
	SidebarConversationList,
} from "../../src/components/layout/AppSidebar.tsx";
import { TabsContext } from "../../src/contexts/TabsContext.tsx";
import type { AgentSummary } from "../../src/lib/api/agents.ts";
import type { Conversation } from "../../src/types/chat.ts";
import "../../src/index.css";

const PROOF_TARGET = { token: null, url: "http://proof.local" };

function agent(id: string, name: string, engine: string): AgentSummary {
	return {
		avatarUrl: null,
		builtIn: true,
		createdAt: null,
		description: `${name} proof agent`,
		engine,
		id,
		installHint: null,
		installed: true,
		latestVersion: null,
		locked: false,
		model: null,
		name,
		recommended: false,
		systemPrompt: null,
		transport: "acp",
		version: null,
		versionStatus: "unknown",
	};
}

const AGENTS = [
	agent("builder", "Builder", "ryu"),
	agent("reviewer", "Reviewer", "claude"),
	agent("planner", "Planner", "codex"),
];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.now();

function conversation(
	id: string,
	title: string,
	options: Partial<Conversation>
): Conversation {
	return {
		createdAt: options.updatedAt ?? 1,
		id,
		lastMessage: options.lastMessage,
		lastMessageAt: options.lastMessageAt ?? options.updatedAt,
		lastMessageRole: options.lastMessageRole ?? "assistant",
		messages: [],
		title,
		updatedAt: options.updatedAt ?? 1,
		...options,
	};
}

const DIRECT_THREADS = [
	conversation("builder-branch", "Design review (branch)", {
		agentId: "builder",
		lastMessage: "Try the alternative layout here.",
		updatedAt: NOW - 15 * MINUTE,
	}),
	conversation("builder-main", "Design review", {
		agentId: "builder",
		lastMessage: "The main thread is still intact.",
		updatedAt: NOW - 2 * HOUR,
	}),
];

const GROUP_THREADS = [
	conversation("group-branch", "Launch plan (branch)", {
		lastMessage: "Reviewer joined the branch.",
		participants: ["builder", "reviewer"],
		updatedAt: NOW - 20 * MINUTE,
	}),
	conversation("group-main", "Launch plan", {
		lastMessage: "Builder shared the launch checklist.",
		participants: ["builder", "reviewer"],
		updatedAt: NOW - 3 * HOUR,
	}),
];

const CONTRIBUTIONS = {
	context_menu_items: [],
};

const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
	const url = typeof input === "string" ? input : input.toString();
	if (url.includes("/api/plugins/contributions")) {
		return Promise.resolve(
			new Response(JSON.stringify(CONTRIBUTIONS), {
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
	if (url.includes("/learning")) {
		return Promise.resolve(
			new Response(JSON.stringify({ excluded: false }), {
				headers: { "content-type": "application/json" },
				status: 200,
			})
		);
	}
	return realFetch(input, init);
}) as typeof fetch;

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

const opened = (label: string) => {
	const output = document.querySelector<HTMLOutputElement>(
		"[data-testid='opened-thread']"
	);
	if (output) {
		output.textContent = label;
	}
};

const handlers = {
	activeConversationId: null,
	agents: AGENTS,
	archivedIds: new Set<string>(),
	loadMessages: () => Promise.resolve([]),
	onDeleteConversation: () => undefined,
	onJumpToMessage: () => undefined,
	onMarkRead: () => undefined,
	onMarkUnread: () => undefined,
	onOpenInNewTab: () => undefined,
	onOpenSideChat: () => undefined,
	onRenameConversation: () => undefined,
	onSelectConversation: (id: string) => opened(`Selected ${id}`),
	onSetConversationIcon: () => undefined,
	onToggleArchive: () => undefined,
	onTogglePin: () => undefined,
	pinnedIds: new Set<string>(),
	target: PROOF_TARGET,
	unreadIds: new Set<string>(),
};

const messageContext: AgentMessageContext = {
	current: { id: "builder", name: "Builder" },
	resolve: (id) => AGENTS.find((item) => item.id === id) ?? { id, name: id },
};

function Story() {
	const [threadsExpanded, setThreadsExpanded] = useState(false);
	return (
		<ThemeProvider
			attribute="class"
			defaultTheme="dark"
			enableSystem={false}
			forcedTheme="dark"
		>
			<QueryClientProvider client={queryClient}>
				<TabsContext.Provider value={{ openTab: () => "proof-chat" } as never}>
					<main className="min-h-screen bg-background p-8 text-foreground">
						<div className="mx-auto grid max-w-[1180px] gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
							<section
								className="overflow-hidden rounded-2xl border border-border/70 bg-sidebar shadow-sm"
								data-testid="agent-sidebar-proof"
							>
								<header className="border-border/70 border-b px-5 py-4">
									<p className="font-semibold text-sm">Agents view</p>
									<p className="mt-1 text-muted-foreground text-xs">
										Direct agent threads inline · fallback group chats
									</p>
								</header>
								<div className="space-y-4 p-3">
									<div>
										<div className="mb-1 px-2 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
											Agents
										</div>
										<div className="rounded-md bg-background/30">
											<MessagingAgentRowBody
												agent={AGENTS[0]}
												conversation={DIRECT_THREADS[0]}
												onEdit={() => undefined}
												onToggleThreads={() =>
													setThreadsExpanded((value) => !value)
												}
												threadCount={DIRECT_THREADS.length}
												threadsExpanded={threadsExpanded}
												usageBarVisible={false}
											/>
										</div>
										{threadsExpanded ? (
											<AgentThreadList
												onOpen={(id) => opened(`Opened ${id}`)}
												pageSize={1}
												threads={DIRECT_THREADS}
											/>
										) : null}
									</div>
									<div>
										<div className="mb-1 px-2 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
											Other chats
										</div>
										<SidebarConversationList
											conversations={GROUP_THREADS}
											handlers={handlers}
											pageSize={1}
										/>
									</div>
								</div>
							</section>
							<section className="rounded-2xl border border-border/70 bg-background p-6 shadow-sm">
								<div className="mb-5 flex items-center justify-between">
									<div>
										<p className="font-semibold text-sm">
											Workspace transcript
										</p>
										<p className="mt-1 text-muted-foreground text-xs">
											Agent messages stay visible between turns.
										</p>
									</div>
									<span className="rounded-full bg-primary/10 px-2.5 py-1 text-primary text-xs">
										Switchboard
									</span>
								</div>
								<AgentMessageTool
									context={messageContext}
									part={{
										input: {
											question: "Can you review the launch branch?",
											to: "reviewer",
										},
										output: {
											from: "builder",
											question: "Can you review the launch branch?",
											reply:
												"It is ready. The branch keeps the main chat untouched.",
											to: "reviewer",
										},
										type: "tool-mcp-agent-comms.agents.ask",
									}}
								/>
							</section>
						</div>
						<output className="sr-only" data-testid="opened-thread" />
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
