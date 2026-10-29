// Chat click modifiers proof (island-background-keys coverage).
//
// Mounts the REAL Settings → Keyboard Shortcuts tab next to the REAL sidebar
// chat row (`ChatRow`) that consumes its two click-modifier settings, so a spec
// can change "Quick reply click modifier" or "Quick preview click modifier" in
// Settings and then prove what a modified click or click-and-hold on the row
// does. The row's callbacks only count what the app would open. Network reads
// are answered in-page; nothing leaves the page.
import { ChatDisplayPrefsProvider } from "@ryu/blocks/desktop/agent-elements/chat-display-prefs.tsx";
import type { HotkeyStorage } from "@ryu/hotkeys/react";
import { HotkeysProvider } from "@ryu/hotkeys/react";
import type { Overrides } from "@ryu/hotkeys/registry";
import { I18nProvider } from "@ryu/i18n/react";
import { I18nDirectionProvider } from "@ryu/ui/components/direction.tsx";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import {
	ChatRow,
	type ChatRowHandlers,
} from "../../src/components/layout/sidebar-conversation-rows.tsx";
import { KeyboardShortcutsTab } from "../../src/components/settings/KeyboardShortcutsTab.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { TabsProvider } from "../../src/contexts/TabsContext.tsx";
import { DEFAULT_DICTATION_PREFS } from "../../src/lib/api/preferences.ts";
import { DESKTOP_HOTKEYS } from "../../src/lib/hotkeys/actions.ts";
import type { Conversation } from "../../types/chat.ts";
import "../../src/index.css";

export interface ClickModifierProofState {
	unexpected: string[];
}
declare global {
	interface Window {
		__clickModifierProof: ClickModifierProofState;
	}
}

const TARGET_URL = "http://127.0.0.1:8980";
const CONVERSATION_ID = "conv-click-modifiers";
const CONVERSATION = {
	agentId: null,
	branch: null,
	folderPath: "/workspace/ryu",
	id: CONVERSATION_ID,
	lastMessage: "Hold the configured modifier to act on this chat.",
	lastMessageRole: "assistant",
	messageCount: 2,
	messages: [],
	participants: [],
	runStatus: "idle",
	title: "Click modifier target",
	updatedAt: new Date().toISOString(),
	visibility: "private",
	worktreePath: null,
} as unknown as Conversation;

window.__clickModifierProof = { unexpected: [] };

let dictationValue = JSON.stringify(DEFAULT_DICTATION_PREFS);
const nativeFetch = window.fetch.bind(window);
async function proofFetch(
	input: RequestInfo | URL,
	init?: RequestInit
): Promise<Response> {
	const rawUrl = input instanceof Request ? input.url : String(input);
	const url = new URL(rawUrl, window.location.href);
	const method = (
		init?.method ?? (input instanceof Request ? input.method : "GET")
	).toUpperCase();
	const path = url.pathname;
	if (url.origin === window.location.origin && !path.startsWith("/api/")) {
		return nativeFetch(input, init);
	}
	if (path === "/api/plugins") {
		return Response.json({ apps: [] });
	}
	if (path === "/api/plugins/contributions") {
		return Response.json({ context_menu_items: [] });
	}
	if (path === "/api/preferences/keybindings") {
		return Response.json({ key: "keybindings", value: "{}" });
	}
	if (path === "/api/preferences/dictation") {
		if (method === "PUT" && typeof init?.body === "string") {
			dictationValue = (JSON.parse(init.body) as { value: string }).value;
		}
		return Response.json({ key: "dictation", value: dictationValue });
	}
	if (path.startsWith("/api/learn/exclude/")) {
		// The row's learning-privacy state for this chat.
		return Response.json({ excluded: false });
	}
	if (
		method === "PUT" &&
		(path === "/api/preferences/entitlement-active" ||
			path === "/api/preferences/managed-inference-entitled")
	) {
		// EntitlementProvider mirrors the plan to the node on mount.
		const { value } = JSON.parse(String(init?.body)) as { value: string };
		return Response.json({
			key: path.slice("/api/preferences/".length),
			value,
		});
	}
	if (path.endsWith("/title-history")) {
		return Response.json([]);
	}
	if (method === "GET" && path.startsWith("/api/preferences/")) {
		// Every other preference the tab reads is unset on this node.
		return Response.json({ error: "Preference not found" }, { status: 404 });
	}
	window.__clickModifierProof.unexpected.push(`${method} ${path}`);
	return Response.json({ error: "not part of this proof" }, { status: 404 });
}
Reflect.set(window, "fetch", proofFetch);

const overrides: Overrides = {};
const shortcutStorage: HotkeyStorage = {
	load: async () => overrides,
	save: async () => undefined,
};
const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

function Counter({ label, testId, value }: Readonly<CounterProps>) {
	return (
		<div className="flex items-center justify-between rounded-lg bg-muted/60 px-3 py-2 text-sm">
			<span className="text-muted-foreground">{label}</span>
			<span className="font-medium tabular-nums" data-testid={testId}>
				{value}
			</span>
		</div>
	);
}
interface CounterProps {
	label: string;
	testId: string;
	value: number;
}

function ProofSurface() {
	const [quickReplies, setQuickReplies] = useState(0);
	const [previews, setPreviews] = useState(0);
	const [selections, setSelections] = useState(0);
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
			onMarkRead: () => undefined,
			onMarkUnread: () => undefined,
			onMoveToProject: () => undefined,
			onOpenQuickPreview: () => setPreviews((count) => count + 1),
			onOpenQuickReply: () => setQuickReplies((count) => count + 1),
			onOpenInNewTab: () => undefined,
			onOpenInNewWindow: () => undefined,
			onOpenNewSideChat: () => undefined,
			onOpenSideChat: () => undefined,
			onRemoveFromProject: () => undefined,
			onRenameConversation: () => undefined,
			onRequestConversationVisibility: () => undefined,
			onSelectConversation: () => setSelections((count) => count + 1),
			onSetConversationIcon: () => undefined,
			onToggleArchive: () => undefined,
			onTogglePin: () => undefined,
			pinnedIds: new Set<string>(),
			projectNameForFolder: () => "ryu",
			projectTargets: [],
			target: { token: null, url: TARGET_URL },
			unreadIds: new Set<string>(),
		}),
		[]
	);

	return (
		<main className="grid min-h-dvh grid-cols-[22rem_minmax(0,1fr)] gap-6 bg-background p-6 text-foreground">
			<aside className="flex flex-col gap-3 rounded-2xl border bg-sidebar p-3">
				<p className="px-2 font-medium text-sm">Chats</p>
				<div data-sidebar-preview-boundary="">
					<ChatRow conv={CONVERSATION} handlers={handlers} />
				</div>
				<Counter
					label="Quick replies opened"
					testId="quick-reply-count"
					value={quickReplies}
				/>
				<Counter
					label="Quick previews opened"
					testId="quick-preview-count"
					value={previews}
				/>
				<Counter
					label="Chats selected"
					testId="selection-count"
					value={selections}
				/>
			</aside>
			<section className="h-[92dvh] min-h-0 rounded-2xl border bg-card p-6">
				<KeyboardShortcutsTab />
			</section>
		</main>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Missing click modifiers proof root");
}
createRoot(root).render(
	<MemoryRouter>
		<QueryClientProvider client={queryClient}>
			<HotkeysProvider registry={DESKTOP_HOTKEYS} storage={shortcutStorage}>
				<AppSurfaceProvider surface="desktop">
					<I18nProvider>
						<I18nDirectionProvider>
							<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
								<ChatDisplayPrefsProvider
									value={{
										animationsEnabled: true,
										composerSendShortcut: "enter",
									}}
								>
									<EntitlementProvider>
										<TabsProvider>
											<Toaster position="bottom-right" theme="dark" />
											<ProofSurface />
										</TabsProvider>
									</EntitlementProvider>
								</ChatDisplayPrefsProvider>
							</ThemeProvider>
						</I18nDirectionProvider>
					</I18nProvider>
				</AppSurfaceProvider>
			</HotkeysProvider>
		</QueryClientProvider>
	</MemoryRouter>
);
