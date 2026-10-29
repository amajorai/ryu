import { z } from "zod";

declare const window: Window;

import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import proofStyles from "./chat-row-menus-story.module.css";
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

import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import { SidebarMenu } from "@ryu/ui/components/sidebar.tsx";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatRow } from "../../src/components/layout/AppSidebar.tsx";
import type { ChatRowHandlers } from "../../src/components/layout/sidebar-conversation-rows.tsx";
import {
	type AppSurface,
	AppSurfaceProvider,
} from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { TabsProvider } from "../../src/contexts/TabsContext.tsx";
import { useConversationFlagsStore } from "../../src/store/useConversationFlagsStore.ts";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import type { Conversation } from "../../types/chat.ts";
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

const CONV: Conversation = {
	id: "conv-alpha",
	title: "Fix the flaky auth test",
	runStatus: "idle",
	folderPath: "D:\\Code\\ryu",
	worktreePath: undefined,
	branch: undefined,
	messages: [],
	participants: [],
	agentId: undefined,
	messageCount: 6,
	createdAt: Date.now(),
	updatedAt: Date.now(),
};
const CONV_OVERFLOW: Conversation = {
	...CONV,
	id: "conv-overflow",
	title: "Review unread archive",
	messageCount: 137,
};

useConversationFlagsStore.setState({
	lastObservedMessageCounts: new Map([
		[CONV.id, 3],
		[CONV_OVERFLOW.id, 20],
	]),
	unreadIds: new Set(),
	unreadMessageCounts: new Map(),
});

const SOURCE_URL = `${window.location.origin}/source`;
const PROOF_NODES = [
	{ name: "Laptop", url: SOURCE_URL, token: "source-token" },
	{
		name: "Studio node",
		url: `${window.location.origin}/destination`,
		token: "destination-token",
	},
];
useNodeStore.setState({
	cloudNodes: [],
	defaultNode: "Laptop",
	localNodes: PROOF_NODES,
	nodes: PROOF_NODES,
});

const FIXTURE_MESSAGES = [
	{
		content: "Could you compare the auth test results?",
		id: "message-user-1",
		role: "user",
	},
	{
		content: "The flaky case only fails when the token expires.",
		id: "message-assistant-1",
		role: "assistant",
	},
] as const;

const FIXTURE_SIDE_CHATS = [
	{
		answer: "The token refresh happens after the first retry.",
		conversation_id: "conv-alpha",
		created_at: 1_777_000_000_010,
		id: "btw-alpha",
		kind: "btw",
		question: "When does the token refresh?",
	},
];

const HANDOFF_BUNDLE = {
	protocol: "ryu-node-continuity",
	version: 0,
	bundleId: "sidebar-handoff-proof",
	createdAt: 1_777_000_000_000,
	source: {
		conversationId: "conv-alpha",
		updatedAt: 1_777_000_000_000,
		title: CONV.title,
		agentHint: "researcher",
	},
	selection: {
		transcript: { mode: "recent", maxMessages: 50 },
		omittedEarlierMessages: false,
	},
	messages: [
		{
			sourceId: "message-user-1",
			role: "user",
			text: "Could you compare the auth test results?",
			createdAt: 1_777_000_000_001,
		},
		{
			sourceId: "message-assistant-1",
			role: "assistant",
			text: "The flaky case only fails when the token expires.",
			createdAt: 1_777_000_000_002,
		},
	],
	context: { version: 0, items: [] },
};

interface RecordedAction {
	args: unknown[];
	name: string;
}
const API_CALLS: Array<{
	body?: unknown;
	method: string;
	path: string;
	authorization?: string;
}> = [];

function recordApi(call: (typeof API_CALLS)[number]) {
	API_CALLS.push(call);
	const out = document.getElementById("api-calls");
	if (out) {
		out.textContent = JSON.stringify(API_CALLS);
	}
}

/** Records the capability a menu row dispatched, so the spec can assert the row
 *  actually FIRES with the conversation id — not merely that it rendered. */
function recordInvoke(
	plugin: string,
	capability: string,
	args: { conversation_id?: string }
) {
	const out = document.getElementById("invoked");
	if (out) {
		// SAFETY: The mounted native sidebar runContributedRow appends the authored conversation string id to its arguments before real pluginHostInvoke JSON serialization. This private recorder receives that controlled publisher; forged host requests are outside this story.
		const id = args.conversation_id ?? "";
		out.textContent = `${plugin} :: ${capability} :: ${id}`;
	}
}

// Stand in for Core. The contributions read is answered; the plugin-host
// dispatch a contributed row makes is recorded and acknowledged, so clicking a
// row in either menu resolves its toast instead of hanging.
const realFetch = window.fetch.bind(globalThis);
window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
	const url = input instanceof Request ? input.url : String(input);
	const parsedUrl = new URL(url, window.location.origin);
	const method = (init?.method ?? "GET").toUpperCase();
	const body = isNativeText(init?.body) ? JSON.parse(init.body) : undefined;
	const json = <FixturePayload,>(value: FixturePayload, status = 200) =>
		Promise.resolve(
			new Response(JSON.stringify(value), {
				status,
				headers: { "content-type": "application/json" },
			})
		);
	if (url.includes("/api/plugins/contributions")) {
		return json(CONTRIBUTIONS);
	}
	if (url.includes("/api/plugins/") && url.endsWith("/host")) {
		// `pluginHostInvoke` posts `{ method, args }` to
		// `/api/plugins/<pluginId>/host`; the id is the third path segment.
		const pluginId = parsedUrl.pathname.match(
			/\/api\/plugins\/([^/]+)\/host$/
		)?.[1];
		// SAFETY: The real pluginHostInvoke serializer publishes an object with its native string method and args value. Only that mounted sidebar publisher reaches this controlled host recorder; args stays unknown and no arbitrary request validation is claimed.
		const dispatch = z
			.object({
				method: z.string(),
				args: z.object({ conversation_id: z.string().optional() }),
			})
			.parse(body);
		recordInvoke(
			decodeURIComponent(pluginId ?? ""),
			dispatch.method,
			dispatch.args
		);
		return json({ ok: true });
	}
	const authorization =
		new Headers(init?.headers).get("authorization") ?? undefined;
	if (parsedUrl.pathname.endsWith("/api/learn/exclude/conv-alpha")) {
		recordApi({ authorization, method, path: parsedUrl.pathname });
		return json({
			conversation_id: "conv-alpha",
			excluded: localStorage.getItem("proof:learning-excluded") === "true",
		});
	}
	if (parsedUrl.pathname.endsWith("/api/learn/exclude") && method === "POST") {
		recordApi({ authorization, body, method, path: parsedUrl.pathname });
		if (localStorage.getItem("proof:fail-learning-save") === "true") {
			localStorage.removeItem("proof:fail-learning-save");
			return json({ error: "fixture write failure" }, 503);
		}
		// SAFETY: The native sidebar learning toggle uses the real setConversationLearningExclusion object serializer. This view retains excluded as unknown and the actual equality check below decides the persisted boolean; forged requests are outside this story.
		const excluded = (body as { excluded?: unknown } | undefined)?.excluded;
		localStorage.setItem("proof:learning-excluded", String(excluded === true));
		return json({
			conversation_id: "conv-alpha",
			excluded: excluded === true,
			rows_updated: 2,
		});
	}
	if (
		parsedUrl.pathname.endsWith("/api/conversations/conv-alpha/title-history")
	) {
		return json([]);
	}
	if (parsedUrl.pathname.endsWith("/api/conversations/conv-alpha/btw")) {
		recordApi({ authorization, method, path: parsedUrl.pathname });
		return json(FIXTURE_SIDE_CHATS);
	}
	if (
		parsedUrl.pathname.endsWith("/api/rnp/v0/conversations/conv-alpha/export")
	) {
		recordApi({ authorization, body, method, path: parsedUrl.pathname });
		return json(HANDOFF_BUNDLE);
	}
	if (
		parsedUrl.pathname.endsWith("/api/rnp/v0/conversations/conv-alpha/resume")
	) {
		recordApi({ authorization, body, method, path: parsedUrl.pathname });
		return json({
			version: 0,
			conversationId: "conv-alpha",
			status: "created",
			imported: { messages: 2, contextItems: 0 },
			warnings: [],
		});
	}
	if (parsedUrl.pathname.endsWith("/api/agents")) {
		return json({ agents: [] });
	}
	return realFetch(input, init);
};

Object.defineProperty(navigator, "clipboard", {
	configurable: true,
	value: {
		writeText: async (value: string) => {
			const current = JSON.parse(
				localStorage.getItem("proof:clipboard") ?? "[]"
			);
			localStorage.setItem(
				"proof:clipboard",
				JSON.stringify([...current, value])
			);
		},
	},
});

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
	const [calls, setCalls] = useState<RecordedAction[]>([]);
	const [messageLoads, setMessageLoads] = useState<string[]>([]);
	const [selectedConversationId, setSelectedConversationId] = useState<
		string | null
	>(null);
	const [pinned, setPinned] = useState(false);
	const [archived, setArchived] = useState(false);
	const [unread, setUnread] = useState(false);
	const [conversationIcon, setConversationIcon] = useState<GlyphValue | null>(
		null
	);
	const record = useCallback((name: string, ...args: unknown[]) => {
		setCalls((current) => [...current, { args, name }]);
	}, []);
	const tabOverrides = useNodeStore((state) => state.tabOverrides);
	const handlers = useMemo<ChatRowHandlers>(
		() => ({
			activeConversationId: selectedConversationId,
			agents: [],
			archivedIds: archived ? new Set([CONV.id]) : new Set(),
			canMakePrivate: true,
			loadMessages: async (id) => {
				setMessageLoads((current) => [...current, id]);
				return [...FIXTURE_MESSAGES];
			},
			onAddScheduledTask: (id) => record("onAddScheduledTask", id),
			onDeleteConversation: (id) => record("onDeleteConversation", id),
			onForkConversation: (id, destination) =>
				record("onForkConversation", id, destination),
			onJumpToMessage: (conversationId, messageId) =>
				record("onJumpToMessage", conversationId, messageId),
			onMarkRead: (id) => {
				record("onMarkRead", id);
				setUnread(false);
			},
			onMarkUnread: (id) => {
				record("onMarkUnread", id);
				setUnread(true);
			},
			onOpenInNewTab: (id) => record("onOpenInNewTab", id),
			onOpenInNewWindow: (id) => record("onOpenInNewWindow", id),
			onOpenNewSideChat: (id) => record("onOpenNewSideChat", id),
			onOpenQuickPreview: (id) => record("onOpenQuickPreview", id),
			onOpenQuickReply: (id) => record("onOpenQuickReply", id),
			onOpenSideChat: (conversationId, entry) =>
				record("onOpenSideChat", conversationId, entry),
			onMoveToProject: (id, path) => record("onMoveToProject", id, path),
			onRemoveFromProject: (id) => record("onRemoveFromProject", id),
			onRenameConversation: (id, title) =>
				record("onRenameConversation", id, title),
			onRequestConversationVisibility: (request) =>
				record("onRequestConversationVisibility", request),
			onSelectConversation: (id) => {
				record("onSelectConversation", id);
				setSelectedConversationId(id);
			},
			onSetConversationIcon: (id, icon) => {
				record("onSetConversationIcon", id, icon);
				setConversationIcon(icon);
			},
			onToggleArchive: (id) => {
				record("onToggleArchive", id);
				setArchived((current) => !current);
			},
			onTogglePin: (id) => {
				record("onTogglePin", id);
				setPinned((current) => !current);
			},
			pinnedIds: pinned ? new Set([CONV.id]) : new Set(),
			projectTargets: [],
			projectNameForFolder: () => "ryu",
			schedulingEnabled: true,
			sideChatsEnabled: true,
			target: { url: SOURCE_URL, token: "source-token" },
			unreadIds: unread ? new Set([CONV.id]) : new Set(),
		}),
		[archived, pinned, record, selectedConversationId, unread]
	);
	const unreadIds = useConversationFlagsStore((state) => state.unreadIds);
	const showUnreadScenario = new URLSearchParams(window.location.search).has(
		"unread-count"
	);
	useEffect(() => {
		if (!showUnreadScenario) {
			return;
		}
		useConversationFlagsStore.getState().observeMessageCounts(
			[
				{ id: CONV.id, messageCount: CONV.messageCount },
				{
					id: CONV_OVERFLOW.id,
					messageCount: CONV_OVERFLOW.messageCount,
				},
			],
			null
		);
	}, [showUnreadScenario]);

	return (
		<AppSurfaceProvider surface={storySurface()}>
			<QueryClientProvider client={queryClient}>
				<EntitlementProvider>
					<TabsProvider>
						<main className="min-h-screen bg-background p-8 text-foreground">
							<section
								className="mx-auto w-[24rem] rounded-2xl border border-border/70 bg-card p-4 shadow-sm"
								data-testid="sidebar-proof-card"
							>
								<header className="mb-3 flex items-center justify-between px-2">
									<span className="font-medium text-sm">Chats</span>
									<span className="text-muted-foreground text-xs">
										Local row fixture
									</span>
								</header>
								<div
									className={proofStyles.fixture1}
									data-sidebar-preview-boundary=""
								>
									<SidebarMenu>
										<ChatRow
											conv={{ ...CONV, icon: conversationIcon }}
											handlers={
												showUnreadScenario
													? { ...handlers, unreadIds }
													: handlers
											}
										/>
										{showUnreadScenario && (
											<ChatRow
												conv={CONV_OVERFLOW}
												handlers={{ ...handlers, unreadIds }}
											/>
										)}
									</SidebarMenu>
								</div>
							</section>
							<div className="sr-only">
								<pre data-testid="invoked" id="invoked" />
								<output data-testid="action-log">
									{JSON.stringify(calls)}
								</output>
								<output data-testid="message-loads">
									{JSON.stringify(messageLoads)}
								</output>
								<output data-testid="selection-state">
									{selectedConversationId ?? "No chat selected"}
								</output>
								<output data-testid="row-state">
									{JSON.stringify({ archived, pinned, unread })}
								</output>
								<output data-testid="chat-icon-state">
									{JSON.stringify(conversationIcon)}
								</output>
								<output data-testid="tab-overrides">
									{JSON.stringify(tabOverrides)}
								</output>
								<pre data-testid="api-calls" id="api-calls">
									{JSON.stringify(API_CALLS)}
								</pre>
								<pre data-testid="action" id="action" />
							</div>
						</main>
						<Toaster position="bottom-right" />
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
