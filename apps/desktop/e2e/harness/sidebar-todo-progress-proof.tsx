declare const window: Window;

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import {
	MessagingAgentRowBody,
	SidebarConversationList,
} from "../../src/components/layout/AppSidebar.tsx";
import type { ChatRowHandlers } from "../../src/components/layout/sidebar-conversation-rows.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { TabsProvider } from "../../src/contexts/TabsContext.tsx";
import type { AgentSummary } from "../../src/lib/api/agents.ts";
import type {
	TodoItemStatus,
	TodoProgressMessage,
} from "../../src/lib/todo-progress.ts";
import type { Conversation } from "../../types/chat.ts";
import "../../src/index.css";

const PROOF_TARGET = {
	token: null,
	url: "http://sidebar-progress-proof.local",
};

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

const AGENTS = [agent("builder", "Builder", "ryu")];

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
		messageCount: 4,
		messages: [],
		title,
		updatedAt,
	};
}

function todoMessages(
	items: Array<{ content: string; status: TodoItemStatus }>
): TodoProgressMessage[] {
	return [
		{
			role: "assistant",
			parts: [
				{
					type: "tool-TodoWrite",
					input: { todos: items },
				},
			],
		},
	];
}

const BOT_CONVERSATION = conversation(
	"bot-latest-direct",
	"Bot latest direct session",
	40
);
const PARTIAL_SESSION = conversation(
	"session-partial",
	"Refresh customer dashboard",
	30
);
const COMPLETE_UNREAD_SESSION = conversation(
	"session-complete-unread",
	"Ship the onboarding polish",
	20
);
const COMPLETE_READ_SESSION = conversation(
	"session-complete-read",
	"Archive the old rollout",
	10
);

const TODO_MESSAGES = new Map<string, TodoProgressMessage[]>(
	Object.entries({
		[BOT_CONVERSATION.id]: todoMessages([
			{ content: "Inspect the current bot run", status: "completed" },
			{ content: "Draft the next response", status: "in_progress" },
		]),
		[PARTIAL_SESSION.id]: todoMessages([
			{ content: "Inspect the dashboard", status: "completed" },
			{ content: "Refresh the data", status: "in_progress" },
			{ content: "Verify the report", status: "pending" },
		]),
		[COMPLETE_UNREAD_SESSION.id]: todoMessages([
			{ content: "Tune the spacing", status: "completed" },
			{ content: "Add the final copy", status: "completed" },
			{ content: "Verify the result", status: "completed" },
		]),
		[COMPLETE_READ_SESSION.id]: todoMessages([
			{ content: "Close the rollout", status: "completed" },
			{ content: "Record the outcome", status: "completed" },
		]),
	})
);

const SESSIONS = [
	PARTIAL_SESSION,
	COMPLETE_UNREAD_SESSION,
	COMPLETE_READ_SESSION,
];

const noOp = () => undefined;
const handlers: ChatRowHandlers = {
	activeConversationId: null,
	agents: AGENTS,
	archivedIds: new Set<string>(),
	canMakePrivate: true,
	loadMessages: async (id) => TODO_MESSAGES.get(id) ?? [],
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
	target: PROOF_TARGET,
	unreadIds: new Set([COMPLETE_UNREAD_SESSION.id]),
};

const realFetch = window.fetch.bind(globalThis);
window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
	const url = input instanceof Request ? input.url : String(input);
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
	return realFetch(input, init);
};

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

function Story() {
	return (
		<ThemeProvider
			attribute="class"
			defaultTheme="dark"
			enableSystem={false}
			forcedTheme="dark"
		>
			<QueryClientProvider client={queryClient}>
				<EntitlementProvider>
					<TabsProvider>
						<main className="min-h-screen bg-background p-8 text-foreground">
							<section
								className="mx-auto w-[380px] overflow-hidden rounded-2xl border border-border/70 bg-sidebar shadow-xl"
								data-testid="sidebar-todo-progress-proof"
							>
								<header className="border-border/70 border-b px-5 py-4">
									<p className="font-semibold text-sm">Agents view</p>
									<p className="mt-1 text-muted-foreground text-xs">
										Session progress at a glance
									</p>
								</header>
								<div className="space-y-5 p-3">
									<section>
										<p className="type-caption mb-1 px-2 font-medium text-muted-foreground uppercase tracking-wide">
											Bots
										</p>
										<div className="group/row relative flex min-h-14 items-center gap-2 overflow-hidden rounded-md bg-background/30 px-2 py-1.5">
											<MessagingAgentRowBody
												agent={AGENTS[0]}
												conversation={BOT_CONVERSATION}
												loadMessages={handlers.loadMessages}
												nodeUrl={PROOF_TARGET.url}
												onEdit={noOp}
												onToggleThreads={noOp}
												threadCount={0}
												threadsExpanded={false}
												usageBarVisible={false}
											/>
										</div>
									</section>
									<section>
										<p className="type-caption mb-1 px-2 font-medium text-muted-foreground uppercase tracking-wide">
											Sessions
										</p>
										<SidebarConversationList
											conversations={SESSIONS}
											groupMultiParticipant={false}
											handlers={handlers}
											pageSize={10}
										/>
									</section>
								</div>
							</section>
						</main>
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
