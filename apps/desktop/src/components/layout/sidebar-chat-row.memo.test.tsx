// Sidebar chat rows are memoized behind one stable handler facade: an
// unrelated sidebar render, or a tab switch, re-renders only the rows whose
// shown state changed, and a row that skipped renders still calls the latest
// handlers.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import type { Conversation } from "@/types/chat.ts";

const nativeFetch = globalThis.fetch;
const NativeAbortController = globalThis.AbortController;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
globalThis.fetch = nativeFetch;
globalThis.AbortController = NativeAbortController;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

mock.module("@/src/contexts/entitlement-context.tsx", () => ({
	useEntitlementContext: () => ({
		requestUpgrade: () => undefined,
		verdict: null,
	}),
}));
const EMPTY_CONTRIBUTIONS = { context_menu_items: [] };
mock.module("@/src/hooks/usePluginContributions.ts", () => ({
	usePluginContributions: () => EMPTY_CONTRIBUTIONS,
}));
// Counts how often each row's body renders (the progress glyph is one of the
// row's own children, so it renders exactly when the row does).
const rowRenders = new Map<string, number>();
mock.module("./SidebarTodoProgress.tsx", () => ({
	SidebarTodoProgress: ({ conversation }: { conversation: Conversation }) => {
		rowRenders.set(conversation.id, (rowRenders.get(conversation.id) ?? 0) + 1);
		return null;
	},
}));

const { createRoot } = await import("react-dom/client");
const { TabsProvider } = await import("@/src/contexts/TabsContext.tsx");
const { ChatRow } = await import("./sidebar-chat-row.tsx");
const { useStableChatRowHandlers } = await import(
	"./use-stable-chat-row-handlers.ts"
);
type Handlers = Parameters<typeof ChatRow>[0]["handlers"];

const ROW_COUNT = 40;
const conversations: Conversation[] = Array.from(
	{ length: ROW_COUNT },
	(_, index) =>
		({
			id: `c${index}`,
			messages: [],
			title: `Chat ${index}`,
			updatedAt: new Date(0),
			createdAt: new Date(0),
		}) as unknown as Conversation
);
const NO_IDS: Set<string> = new Set();
const NO_AGENTS: Handlers["agents"] = [];
const selected: string[] = [];

/** A fresh bag every render, the way the sidebar builds it. */
function buildHandlers(activeId: string, tick: number): Handlers {
	const noop = () => undefined;
	return {
		activeConversationId: activeId,
		agents: NO_AGENTS,
		archivedIds: NO_IDS,
		canMakePrivate: false,
		loadMessages: async () => [],
		onAddScheduledTask: noop,
		onDeleteConversation: noop,
		onForkConversation: noop,
		onJumpToMessage: noop,
		onMarkRead: noop,
		onMarkUnread: noop,
		onMoveToProject: noop,
		onOpenInNewTab: noop,
		onOpenInNewWindow: noop,
		onOpenNewSideChat: noop,
		onOpenQuickReply: noop,
		onOpenSideChat: noop,
		onRemoveFromProject: noop,
		onRenameConversation: noop,
		onRequestConversationVisibility: noop,
		onSelectConversation: (id: string) => selected.push(`${id}@${tick}`),
		onSetConversationIcon: noop,
		onToggleArchive: noop,
		onTogglePin: noop,
		pinnedIds: NO_IDS,
		projectNameForFolder: (folder: string) => folder,
		projectTargets: [],
		target: { token: null, url: "http://127.0.0.1:7980" },
		unreadIds: NO_IDS,
	};
}

let setActive: (id: string) => void = () => undefined;
let bump: () => void = () => undefined;

function Sidebar() {
	const [activeId, setActiveId] = useState("c0");
	const [tick, setTick] = useState(0);
	setActive = setActiveId;
	bump = () => setTick((value) => value + 1);
	const handlers = useStableChatRowHandlers(buildHandlers(activeId, tick));
	return (
		<ul>
			{conversations.map((conv) => (
				<ChatRow conv={conv} handlers={handlers} key={conv.id} />
			))}
		</ul>
	);
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(async () => {
	rowRenders.clear();
	selected.length = 0;
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => {
		root?.render(
			<QueryClientProvider client={new QueryClient()}>
				<TabsProvider>
					<Sidebar />
				</TabsProvider>
			</QueryClientProvider>
		);
	});
});

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	root = null;
	container = null;
});

function totalRenders(): number {
	let total = 0;
	for (const count of rowRenders.values()) {
		total += count;
	}
	return total;
}

test("an unrelated sidebar render re-renders no row", async () => {
	const before = totalRenders();
	expect(before).toBeGreaterThanOrEqual(ROW_COUNT);
	await act(async () => bump());
	await act(async () => bump());
	expect(totalRenders()).toBe(before);
});

test("switching the active chat re-renders only the two rows involved", async () => {
	const before = new Map(rowRenders);
	await act(async () => setActive("c7"));
	const changed = [...rowRenders].filter(
		([id, count]) => count !== before.get(id)
	);
	expect(changed.map(([id]) => id).sort()).toEqual(["c0", "c7"]);
});

test("a row that skipped renders still calls the latest handler", async () => {
	await act(async () => bump());
	await act(async () => bump());
	const row = container?.querySelector<HTMLElement>(
		'[data-testid="sidebar-chat-row-c3"]'
	);
	await act(async () => row?.click());
	expect(selected).toEqual(["c3@2"]);
});
