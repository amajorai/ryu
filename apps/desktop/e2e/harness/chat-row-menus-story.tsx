// Standalone browser story for the REAL sidebar `ChatRow` and its TWO menus.
//
// A chat row carries the same verbs on two surfaces: the ⋯ dropdown revealed on
// hover, and the right-click context menu. They are separate Base UI primitives
// (`DropdownMenuItem` vs `ContextMenuItem`), so the rendered rows genuinely
// cannot be one shared fragment — which is exactly how they drifted: the
// dropdown grew an app-contributed section (`contributes.context_menu_items`
// filtered to the `conversation` anchor) and the context menu never did. An app
// that registered a row appeared, to anyone who reaches for right-click, to have
// contributed nothing at all.
//
// Why a browser story rather than a unit test: the deliverable is that two
// different menu primitives, opened by two different gestures, list the same
// rows. That is a rendered fact about popups, focus and portals. A type-check
// sees neither menu, and the contribution plumbing itself is exercised further
// up in `usePluginContributions`.
//
// The only stub is the one seam a row cannot supply itself: `fetch`, standing in
// for Core's `/api/plugins/contributions`. Everything from the query through the
// anchor filter, the `order` sort and both menus is the shipping component.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { ChatRow } from "../../src/components/layout/AppSidebar.tsx";
import {
	type AppSurface,
	AppSurfaceProvider,
} from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { TabsProvider } from "../../src/contexts/TabsContext.tsx";
import type { Conversation } from "../../src/types/chat.ts";
import "../../src/index.css";

/** Canned `/api/plugins/contributions`. Two conversation rows deliberately given
 *  out-of-order `order` values (so the sort is observable), plus rows anchored
 *  elsewhere that must NOT reach a chat row's menus. */
const CONTRIBUTIONS = {
	context_menu_items: [
		{
			id: "summarize",
			plugin: "@ryu/learning",
			anchor: "conversation",
			label: "Summarize this chat",
			capability: "chat.summarize",
			icon: "lucide:sparkles",
			order: 20,
		},
		{
			id: "make-skill",
			plugin: "@ryu/learning",
			anchor: "conversation",
			label: "Make a skill from this chat",
			capability: "skill.fromChat",
			icon: "lucide:graduation-cap",
			order: 10,
		},
		{
			id: "rename-space",
			plugin: "@ryu/spaces",
			anchor: "space",
			label: "Space-only row",
			capability: "space.rename",
		},
	],
};

const CONV = {
	id: "conv-alpha",
	title: "Fix the flaky auth test",
	runStatus: "idle",
	folderPath: "D:\\Code\\ryu",
	worktreePath: null,
	branch: null,
	messages: [],
	participants: [],
	agentId: null,
	messageCount: 6,
} as unknown as Conversation;

function recordAction(value: string) {
	const out = document.getElementById("action");
	if (out) {
		out.textContent = value;
	}
}

/** Records the capability a menu row dispatched, so the spec can assert the row
 *  actually FIRES with the conversation id — not merely that it rendered. */
function recordInvoke(plugin: string, capability: string, args: unknown) {
	const out = document.getElementById("invoked");
	if (out) {
		const id = (args as { conversation_id?: string })?.conversation_id ?? "";
		out.textContent = `${plugin} :: ${capability} :: ${id}`;
	}
}

const handlers = {
	activeConversationId: null,
	agents: [],
	archivedIds: new Set<string>(),
	pinnedIds: new Set<string>(),
	unreadIds: new Set<string>(),
	loadMessages: () => Promise.resolve([]),
	onAddScheduledTask: (id: string) => recordAction(`schedule:${id}`),
	onDeleteConversation: () => undefined,
	onForkConversation: (id: string, destination: string) =>
		recordAction(`fork:${destination}:${id}`),
	onJumpToMessage: () => undefined,
	onMarkRead: () => undefined,
	onMarkUnread: () => undefined,
	onOpenInNewTab: () => undefined,
	onOpenInNewWindow: (id: string) => recordAction(`window:${id}`),
	onOpenNewSideChat: (id: string) => recordAction(`side-chat:${id}`),
	onOpenSideChat: () => undefined,
	onRenameConversation: () => undefined,
	onRemoveFromProject: (id: string) => recordAction(`remove-project:${id}`),
	onSelectConversation: () => undefined,
	onSetConversationIcon: () => undefined,
	onRequestConversationVisibility: () => undefined,
	canMakePrivate: true,
	onToggleArchive: () => undefined,
	onTogglePin: () => undefined,
	projectNameForFolder: () => "ryu",
	target: { url: "http://127.0.0.1:8980", token: null },
	// biome-ignore lint/suspicious/noExplicitAny: the story supplies only the
	// handlers a menu can reach; the rest of the bundle is unused here.
} as any;

// Stand in for Core. The contributions read is answered; the plugin-host
// dispatch a contributed row makes is recorded and acknowledged, so clicking a
// row in either menu resolves its toast instead of hanging.
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
	const url = typeof input === "string" ? input : input.toString();
	if (url.includes("/api/plugins/contributions")) {
		return Promise.resolve(
			new Response(JSON.stringify(CONTRIBUTIONS), {
				status: 200,
				headers: { "content-type": "application/json" },
			})
		);
	}
	if (url.includes("/api/plugins/") && url.endsWith("/host")) {
		// `pluginHostInvoke` posts `{ method, args }` to
		// `/api/plugins/<pluginId>/host`; the id is the third path segment.
		const body = init?.body ? JSON.parse(String(init.body)) : {};
		const parts = new URL(url, "http://localhost").pathname.split("/");
		recordInvoke(
			decodeURIComponent(parts[3] ?? ""),
			String(body.method ?? ""),
			body.args
		);
		return Promise.resolve(
			new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			})
		);
	}
	return realFetch(input as RequestInfo, init);
}) as typeof fetch;

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

function storySurface(): AppSurface {
	switch (new URLSearchParams(window.location.search).get("surface")) {
		case "web":
			return "web";
		case "extension":
			return "extension";
		case "mobile":
			return "mobile";
		default:
			return "desktop";
	}
}

function Story() {
	return (
		<AppSurfaceProvider surface={storySurface()}>
			<QueryClientProvider client={queryClient}>
				<EntitlementProvider>
					<TabsProvider>
						<div style={{ padding: 40 }}>
							<div data-sidebar-preview-boundary="" style={{ width: 260 }}>
								<ChatRow conv={CONV} handlers={handlers} />
							</div>
							<pre data-testid="invoked" id="invoked" />
							<pre data-testid="action" id="action" />
						</div>
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
