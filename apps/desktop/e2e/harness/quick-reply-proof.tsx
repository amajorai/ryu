import { ChatDisplayPrefsProvider } from "@ryu/blocks/desktop/agent-elements/chat-display-prefs.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { QuickPreview } from "../../src/components/chat/QuickPreview.tsx";
import { QuickReplyComposer } from "../../src/components/chat/QuickReplyComposer.tsx";
import {
	ChatRow,
	type ChatRowHandlers,
} from "../../src/components/layout/sidebar-conversation-rows.tsx";
import {
	type AppSurface,
	AppSurfaceProvider,
} from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { TabsProvider } from "../../src/contexts/TabsContext.tsx";
import { DEFAULT_QUICK_PREVIEW_MODIFIER } from "../../src/hooks/useQuickPreviewModifier.ts";
import { DEFAULT_QUICK_REPLY_MODIFIER } from "../../src/hooks/useQuickReplyModifier.ts";
import { useQuickReplyStore } from "../../src/store/useQuickReplyStore.ts";
import type { Conversation } from "../../types/chat.ts";
import "../../src/index.css";

const TARGET_URL = "http://127.0.0.1:8980";
const CONVERSATION_ID = "conv-quick-reply";
const CONVERSATION: Conversation = {
	createdAt: Date.now(),
	folderPath: "/Users/jiawei/Documents/Code/ryu",
	id: CONVERSATION_ID,
	lastMessage: "The sidebar can keep this thread in view.",
	lastMessageRole: "assistant",
	messageCount: 8,
	messages: [],
	participants: [],
	runStatus: "idle",
	title: "Review the release notes",
	updatedAt: Date.now(),
	visibility: "private",
};

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
	const url = String(input);
	if (url.includes("/api/plugins/contributions")) {
		return new Response(JSON.stringify({ context_menu_items: [] }), {
			headers: { "content-type": "application/json" },
			status: 200,
		});
	}
	if (url.includes("/learning")) {
		return new Response(JSON.stringify({ excluded: false }), {
			headers: { "content-type": "application/json" },
			status: 200,
		});
	}
	if (url.includes("/title-history")) {
		return new Response(JSON.stringify([]), {
			headers: { "content-type": "application/json" },
			status: 200,
		});
	}
	return realFetch(input, init);
};

function surface(): AppSurface {
	const value = new URLSearchParams(window.location.search).get("surface");
	return value === "extension" || value === "mobile" || value === "web"
		? value
		: "desktop";
}

function Story() {
	const request = useQuickReplyStore((state) => state.request);
	const openQuickReply = useQuickReplyStore((state) => state.open);
	const closeQuickReply = useQuickReplyStore((state) => state.close);
	const registerQuickReplyHandler = useQuickReplyStore(
		(state) => state.registerHandler
	);
	const submitQuickReply = useQuickReplyStore((state) => state.submit);
	const [unread, setUnread] = useState(false);
	const [previewOpen, setPreviewOpen] = useState(false);
	const [selected, setSelected] = useState("No chat selected");
	const [sentReply, setSentReply] = useState("No quick reply sent yet");

	useEffect(
		() =>
			registerQuickReplyHandler(TARGET_URL, CONVERSATION_ID, (content) => {
				setSentReply(content);
			}),
		[registerQuickReplyHandler]
	);

	const handlers = useMemo<ChatRowHandlers>(
		() => ({
			activeConversationId: null,
			agents: [],
			archivedIds: new Set<string>(),
			canMakePrivate: true,
			loadMessages: async () => [],
			onAddScheduledTask: () => undefined,
			onDeleteConversation: () => undefined,
			onForkConversation: () => undefined,
			onJumpToMessage: () => undefined,
			onMarkRead: () => setUnread(false),
			onMarkUnread: () => setUnread(true),
			onOpenQuickReply: (id) =>
				openQuickReply({
					conversationId: id,
					targetUrl: TARGET_URL,
					title: CONVERSATION.title,
				}),
			onOpenQuickPreview: () => setPreviewOpen(true),
			onOpenInNewTab: () => undefined,
			onOpenInNewWindow: () => undefined,
			onOpenNewSideChat: () => undefined,
			onOpenSideChat: () => undefined,
			onMoveToProject: () => undefined,
			onRemoveFromProject: () => undefined,
			onRenameConversation: () => undefined,
			onRequestConversationVisibility: () => undefined,
			onSelectConversation: (id) => setSelected(`Selected ${id}`),
			onSetConversationIcon: () => undefined,
			onToggleArchive: () => undefined,
			onTogglePin: () => undefined,
			pinnedIds: new Set<string>(),
			projectTargets: [],
			projectNameForFolder: () => "ryu",
			target: { token: null, url: TARGET_URL },
			unreadIds: unread ? new Set([CONVERSATION_ID]) : new Set<string>(),
		}),
		[openQuickReply, unread]
	);

	const handleSubmit = (content: string) => {
		submitQuickReply(TARGET_URL, CONVERSATION_ID, content);
		setSentReply(content);
		closeQuickReply();
	};

	return (
		<AppSurfaceProvider surface={surface()}>
			<ChatDisplayPrefsProvider
				value={{ animationsEnabled: true, composerSendShortcut: "enter" }}
			>
				<QueryClientProvider client={queryClient}>
					<EntitlementProvider>
						<TabsProvider>
							<main className="min-h-screen bg-background p-8 text-foreground">
								<div className="mx-auto grid max-w-5xl gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
									<header className="lg:col-span-2">
										<p className="font-medium text-primary text-xs uppercase tracking-(--tracking-section)">
											Sidebar interaction proof
										</p>
										<h1 className="mt-1 font-heading font-semibold text-2xl tracking-tight">
											Quick reply without leaving the sidebar
										</h1>
										<p className="mt-1 max-w-2xl text-muted-foreground text-sm">
											Use the row menu, right-click, or hold Alt / Option while
											clicking for a quick reply. Hold Shift and keep the click
											down for a read-only message preview.
										</p>
									</header>
									<aside className="rounded-2xl border border-border/70 bg-sidebar p-3 shadow-sm">
										<div className="mb-2 flex items-center justify-between px-2">
											<span className="font-medium text-sm">Chats</span>
											<span className="text-muted-foreground text-xs">
												Modifier: Alt / Option
											</span>
										</div>
										<div data-sidebar-preview-boundary="">
											<ChatRow conv={CONVERSATION} handlers={handlers} />
										</div>
										<p className="mt-3 px-2 text-muted-foreground text-xs">
											Alt-click replies; Shift-hold previews without selecting.
										</p>
									</aside>
									<section className="min-h-[22rem] rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
										<div className="flex items-center justify-between border-border/70 border-b pb-3">
											<div>
												<p className="font-medium text-sm">Interaction log</p>
												<p className="text-muted-foreground text-xs">
													The target session stays explicit.
												</p>
											</div>
											<span
												className="rounded-full bg-muted px-2 py-1 text-muted-foreground text-xs"
												data-testid="selection-state"
											>
												{selected}
											</span>
											<span
												className="rounded-full bg-muted px-2 py-1 text-muted-foreground text-xs"
												data-testid="unread-state"
											>
												{unread ? "Unread" : "Read"}
											</span>
										</div>
										<div className="mt-5 rounded-xl bg-muted/60 p-4 text-sm">
											<p className="font-medium">Last quick reply</p>
											<p
												className="mt-2 whitespace-pre-wrap text-muted-foreground"
												data-testid="sent-reply"
											>
												{sentReply}
											</p>
										</div>
									</section>
								</div>
							</main>
							<QuickReplyComposer
								onClose={closeQuickReply}
								onSubmit={handleSubmit}
								request={request}
							/>
							<QuickPreview
								conversationId={CONVERSATION_ID}
								isUnread={unread}
								loadMessages={() =>
									Promise.resolve([
										{
											content:
												"Please keep the release notes review in the sidebar.",
											id: "quick-preview-user",
											role: "user" as const,
											timestamp: Date.now() - 60_000,
										},
										{
											content:
												"The preview does not open the chat or clear unread.",
											id: "quick-preview-assistant",
											role: "assistant" as const,
											timestamp: Date.now(),
										},
									])
								}
								onMarkRead={() => setUnread(false)}
								onMarkUnread={() => setUnread(true)}
								onOpenChange={setPreviewOpen}
								open={previewOpen}
								title={CONVERSATION.title}
							/>
						</TabsProvider>
					</EntitlementProvider>
				</QueryClientProvider>
			</ChatDisplayPrefsProvider>
		</AppSurfaceProvider>
	);
}

localStorage.setItem("ryu:quick-reply-modifier", DEFAULT_QUICK_REPLY_MODIFIER);
localStorage.setItem(
	"ryu:quick-preview-modifier",
	DEFAULT_QUICK_PREVIEW_MODIFIER
);

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
