declare const window: Window;

import { AgentMessageTool } from "@ryu/blocks/desktop/agent-elements/tools/agent-message-tool.tsx";
import type { AgentMessageContext } from "@ryu/blocks/desktop/agent-elements/types.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QuickPreview } from "../../src/components/chat/QuickPreview.tsx";
import {
	AgentThreadList,
	MessagingAgentRowBody,
	SidebarConversationList,
} from "../../src/components/layout/AppSidebar.tsx";
import type { ChatRowHandlers } from "../../src/components/layout/sidebar-conversation-rows.tsx";
import { TabsContext } from "../../src/contexts/TabsContext.tsx";
import { groupDirectAgentThreads } from "../../src/lib/agent-conversation-groups.ts";
import type { AgentSummary } from "../../src/lib/api/agents.ts";
import type { Conversation } from "../../types/chat.ts";
import { createTabsProofContext } from "./tabs-proof-context.ts";
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

const GROUPED_DIRECT_THREADS =
	groupDirectAgentThreads([
		...DIRECT_THREADS.toReversed(),
		...GROUP_THREADS,
		conversation("archived-builder", "Archived design", {
			agentId: "builder",
			archived: true,
		}),
	]).get("builder") ?? [];

const PREVIEW_MESSAGES = [
	{
		content: "The branch keeps the main chat untouched.",
		id: "preview-user",
		role: "user" as const,
		timestamp: NOW - MINUTE,
	},
	{
		content: "That makes this session safe to preview before opening it.",
		id: "preview-assistant",
		role: "assistant" as const,
		timestamp: NOW,
	},
];

const CONTRIBUTIONS = {
	context_menu_items: [],
};

const realFetch = window.fetch.bind(globalThis);
window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
	const url = input instanceof Request ? input.url : String(input);
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
};

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

const noOp = () => undefined;

const handlers = {
	activeConversationId: null,
	agents: AGENTS,
	archivedIds: new Set<string>(),
	canMakePrivate: false,
	loadMessages: () => Promise.resolve([]),
	onAddScheduledTask: noOp,
	onDeleteConversation: noOp,
	onForkConversation: noOp,
	onJumpToMessage: noOp,
	onMarkRead: noOp,
	onMarkUnread: noOp,
	onMoveToProject: noOp,
	onOpenQuickReply: (id: string) => opened(`Quick reply ${id}`),
	onOpenInNewTab: noOp,
	onOpenInNewWindow: noOp,
	onOpenNewSideChat: noOp,
	onOpenSideChat: noOp,
	onRemoveFromProject: noOp,
	onRenameConversation: noOp,
	onRequestConversationVisibility: noOp,
	onSelectConversation: (id: string) => opened(`Selected ${id}`),
	onSetConversationIcon: noOp,
	onToggleArchive: noOp,
	onTogglePin: noOp,
	pinnedIds: new Set<string>(),
	projectNameForFolder: () => "proof",
	projectTargets: [],
	target: PROOF_TARGET,
	unreadIds: new Set<string>(),
} satisfies ChatRowHandlers;

const messageContext: AgentMessageContext = {
	current: { id: "builder", name: "Builder" },
	resolve: (id) => AGENTS.find((item) => item.id === id) ?? { id, name: id },
};

function Story() {
	const [unreadThreadIds, setUnreadThreadIds] = useState<Set<string>>(
		new Set()
	);
	const [previewId, setPreviewId] = useState<string | null>(null);
	const [threadsExpanded, setThreadsExpanded] = useState(false);
	return (
		<ThemeProvider
			attribute="class"
			defaultTheme="dark"
			enableSystem={false}
			forcedTheme="dark"
		>
			<QueryClientProvider client={queryClient}>
				<TabsContext.Provider
					value={createTabsProofContext({ openTab: () => "proof-chat" })}
				>
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
										<div className="type-caption mb-1 px-2 font-medium text-muted-foreground uppercase tracking-wide">
											Agents
										</div>
										<div className="rounded-md bg-background/30">
											<MessagingAgentRowBody
												agent={AGENTS[0]}
												conversation={GROUPED_DIRECT_THREADS[0]}
												onEdit={() => undefined}
												onToggleThreads={() =>
													setThreadsExpanded((value) => !value)
												}
												threadCount={GROUPED_DIRECT_THREADS.length}
												threadsExpanded={threadsExpanded}
												usageBarVisible={false}
											/>
										</div>
										{threadsExpanded ? (
											<AgentThreadList
												loadMessages={() => Promise.resolve(PREVIEW_MESSAGES)}
												onMarkRead={(id) =>
													setUnreadThreadIds((current) => {
														const next = new Set(current);
														next.delete(id);
														return next;
													})
												}
												onMarkUnread={(id) =>
													setUnreadThreadIds((current) =>
														new Set(current).add(id)
													)
												}
												onOpen={(id) => opened(`Opened ${id}`)}
												onOpenQuickPreview={setPreviewId}
												onOpenQuickReply={(id) => opened(`Quick reply ${id}`)}
												pageSize={1}
												threads={GROUPED_DIRECT_THREADS}
												unreadIds={unreadThreadIds}
											/>
										) : null}
									</div>
									<div>
										<div className="type-caption mb-1 px-2 font-medium text-muted-foreground uppercase tracking-wide">
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
						<QuickPreview
							conversationId={previewId ?? ""}
							isUnread={previewId ? unreadThreadIds.has(previewId) : false}
							loadMessages={() => Promise.resolve(PREVIEW_MESSAGES)}
							onMarkRead={(id) =>
								setUnreadThreadIds((current) => {
									const next = new Set(current);
									next.delete(id);
									return next;
								})
							}
							onMarkUnread={(id) =>
								setUnreadThreadIds((current) => new Set(current).add(id))
							}
							onOpenChange={(open) => {
								if (!open) {
									setPreviewId(null);
								}
							}}
							open={previewId !== null}
							title={
								GROUPED_DIRECT_THREADS.find((thread) => thread.id === previewId)
									?.title ?? "Session preview"
							}
						/>
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
