import { AgentChat } from "@ryu/blocks/desktop/agent-elements/agent-chat.tsx";
import {
	Sidebar,
	SidebarContent,
	SidebarHeader,
	SidebarProvider,
} from "@ryu/ui/components/sidebar.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { UIMessage } from "ai";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
	EmptyStateHeader,
	type EmptyStateLogo,
} from "../../components/agent-elements/empty-state-header.tsx";
import { BotChatHeader } from "../../src/components/chat/BotChatHeader.tsx";
import { ChatsSection } from "../../src/components/layout/AppSidebar.tsx";
import { SidebarBrandBadge } from "../../src/components/layout/SidebarBrandBadge.tsx";
import type { ChatRowHandlers } from "../../src/components/layout/sidebar-conversation-rows.tsx";
import {
	type AppSurface,
	AppSurfaceProvider,
} from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { TabsProvider } from "../../src/contexts/TabsContext.tsx";
import type { Conversation } from "../../types/chat.ts";
import "../../src/index.css";
import { IDLE_REORDER_SHIFT } from "@ryu/ui/hooks/use-reorder-shift.tsx";

const PROOF_TARGET = { token: null, url: "http://proof.local" };
const STORAGE_KEYS = [
	"ryu:bot-chat-sections:v1",
	"ryu:bot-chat-section-order:v1",
	"ryu:bot-chat-section-collapsed:v1",
];

function conversation(
	id: string,
	title: string,
	updatedAt: number
): Conversation {
	return {
		createdAt: updatedAt,
		id,
		lastMessage: `${title} latest update`,
		lastMessageAt: updatedAt,
		lastMessageRole: "assistant",
		messageCount: 2,
		messages: [],
		participants: [],
		title,
		updatedAt,
	};
}

const CONVERSATIONS = [
	conversation("chat-trip", "Plan my weekend", 20),
	conversation("chat-notes", "Summarize my notes", 10),
];

const BOT_AGENT = {
	avatarGlyph: null,
	avatarUrl: null,
	builtIn: true,
	engine: "ryu",
	id: "ryu",
	name: "Ryu",
	title: "Bot",
} as const;

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
	onOpenQuickReply: noOp,
	onOpenInNewTab: noOp,
	onOpenInNewWindow: noOp,
	onOpenNewSideChat: noOp,
	onOpenSideChat: noOp,
	onRenameConversation: noOp,
	onMoveToProject: noOp,
	onRemoveFromProject: noOp,
	onRequestConversationVisibility: noOp,
	onSelectConversation: noOp,
	onSetConversationIcon: noOp,
	onToggleArchive: noOp,
	onTogglePin: noOp,
	pinnedIds: new Set<string>(),
	projectTargets: [],
	projectNameForFolder: () => "proof",
	target: PROOF_TARGET,
	unreadIds: new Set<string>(),
} satisfies ChatRowHandlers;

const dnd = {
	draggingKey: null,
	dragOverKey: null,
	onDragEnd: noOp,
	onDragOver: noOp,
	onDragStart: noOp,
	onDrop: noOp,
	shift: IDLE_REORDER_SHIFT,
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

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

const ACTIVITY_PROMPT: UIMessage = {
	id: "bot-proof-activity-user",
	parts: [{ text: "What's on this weekend?", type: "text" }],
	role: "user",
};

/** Seeds a live turn so the header's status line can be proven per state. */
function activityFromUrl(): {
	messages: UIMessage[];
	status: "ready" | "streaming" | "submitted";
} {
	const activity = new URLSearchParams(window.location.search).get("activity");
	if (activity === "thinking") {
		return { messages: [ACTIVITY_PROMPT], status: "submitted" };
	}
	if (activity === "working") {
		return {
			messages: [
				ACTIVITY_PROMPT,
				{
					id: "bot-proof-activity-assistant",
					parts: [
						{
							input: { query: "events this weekend" },
							state: "input-available",
							toolCallId: "bot-proof-search",
							toolName: "web_search",
							type: "dynamic-tool",
						},
					],
					role: "assistant",
				},
			],
			status: "streaming",
		};
	}
	if (activity === "typing") {
		return {
			messages: [
				ACTIVITY_PROMPT,
				{
					id: "bot-proof-activity-assistant",
					parts: [{ text: "Here are a few ideas", type: "text" }],
					role: "assistant",
				},
			],
			status: "streaming",
		};
	}
	return { messages: [], status: "ready" };
}

function ChatPreview() {
	const [initialActivity] = useState(activityFromUrl);
	const [messages, setMessages] = useState<UIMessage[]>(
		initialActivity.messages
	);
	const [sent, setSent] = useState("");
	const logo: EmptyStateLogo = { engine: "ryu", kind: "single" };

	return (
		<section
			className="flex min-w-0 flex-1 flex-col bg-background"
			data-testid="bot-chat-surface"
		>
			<AgentChat
				assistantName="Ryu"
				composerFooter={
					<output
						className="block min-h-5 text-center text-muted-foreground text-xs"
						data-testid="bot-sent-message"
					>
						{sent}
					</output>
				}
				conversationHeader={
					<>
						<BotChatHeader agent={BOT_AGENT} clearTitleBar={false} />
						<div className="flex items-center justify-between border-border/60 border-b px-8 py-3">
							<div>
								<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
									Managed chat
								</p>
								<h1 className="mt-1 font-semibold text-xl tracking-tight">
									Bot
								</h1>
							</div>
							<div
								className="rounded-full border border-primary/20 bg-primary/5 px-3 py-1.5 text-primary text-xs"
								data-testid="bot-managed-default"
							>
								Ryu-managed models
							</div>
						</div>
					</>
				}
				emptyStateHeader={
					<EmptyStateHeader
						interactiveLogo={false}
						logo={logo}
						sections={[]}
						showProjectPicker={false}
						title="What can I help with?"
					/>
				}
				emptyStatePosition="center"
				messages={messages}
				onSend={(message) => {
					setSent(message.content);
					setMessages((previous) => [
						...previous,
						{
							id: `bot-proof-${previous.length}`,
							parts: [{ text: message.content, type: "text" }],
							role: "user",
						},
					]);
				}}
				onStop={noOp}
				status={initialActivity.status}
			/>
		</section>
	);
}

function surfaceFromUrl(): AppSurface {
	return new URLSearchParams(window.location.search).get("surface") === "web"
		? "web"
		: "desktop";
}

function Story() {
	if (new URLSearchParams(window.location.search).has("reset")) {
		for (const key of STORAGE_KEYS) {
			localStorage.removeItem(key);
		}
	}

	return (
		<AppSurfaceProvider surface={surfaceFromUrl()}>
			<QueryClientProvider client={queryClient}>
				<EntitlementProvider>
					<TabsProvider>
						<main
							className="min-h-screen bg-background p-8 text-foreground"
							data-product="ryu-bot"
						>
							<div className="mx-auto flex min-h-[720px] max-w-6xl overflow-hidden rounded-3xl border border-border/70 shadow-2xl">
								<SidebarProvider
									className="w-[280px] shrink-0"
									variant="sidebar"
								>
									<Sidebar collapsible="none" variant="sidebar">
										<SidebarHeader>
											<SidebarBrandBadge />
											<div
												aria-label="Ryu Cloud managed workspace: Connected"
												className="mx-2 mt-2 rounded-lg border border-success/20 bg-success/5 px-3 py-2"
												data-testid="bot-connection-status"
											>
												<p className="font-medium text-xs">Ryu Cloud</p>
												<p className="type-compact mt-0.5 text-success">
													Connected
												</p>
											</div>
										</SidebarHeader>
										<SidebarContent>
											<ChatsSection
												botMode
												collapsed={false}
												dnd={dnd}
												handlers={handlers}
												loose={CONVERSATIONS}
												managedProduct
												menu={menu}
												onNew={noOp}
												onToggleCollapsed={noOp}
												pageSize={10}
												sectionKey="chats"
												sort="default"
											/>
										</SidebarContent>
									</Sidebar>
								</SidebarProvider>
								<ChatPreview />
							</div>
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
