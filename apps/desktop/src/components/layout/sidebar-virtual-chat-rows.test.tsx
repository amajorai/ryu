// Long sidebar chat lists render windowed: 1,000 chats mount a few dozen rows,
// scrolling swaps the window, and the open chat, keyboard focus, the nearest
// unread rows and shift-click ranges keep working across unmounted rows.
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
// Counts row body renders (the progress glyph renders exactly when its row does).
const rowRenders = new Map<string, number>();
mock.module("./SidebarTodoProgress.tsx", () => ({
	SidebarTodoProgress: ({ conversation }: { conversation: Conversation }) => {
		rowRenders.set(conversation.id, (rowRenders.get(conversation.id) ?? 0) + 1);
		return null;
	},
}));

const { createRoot } = await import("react-dom/client");
const { TabsProvider } = await import("@/src/contexts/TabsContext.tsx");
const { ChatRowList } = await import("./sidebar-conversation-list.tsx");
const { useSidebarChatSelection } = await import(
	"./sidebar-chat-selection.tsx"
);
const { CHAT_ROW_VIRTUALIZE_THRESHOLD } = await import(
	"./sidebar-virtual-chat-rows.tsx"
);
const { useStableChatRowHandlers } = await import(
	"./use-stable-chat-row-handlers.ts"
);
type Handlers = Parameters<typeof ChatRowList>[0]["handlers"];

const VIEWPORT_PX = 600;
const ROW_PITCH_PX = 34;

function makeConversations(count: number): Conversation[] {
	return Array.from(
		{ length: count },
		(_, index) =>
			({
				id: `c${index}`,
				messages: [],
				title: `Chat ${index}`,
				updatedAt: new Date(0),
				createdAt: new Date(0),
			}) as unknown as Conversation
	);
}

const NO_IDS: Set<string> = new Set();
const NO_AGENTS: Handlers["agents"] = [];
const noop = () => undefined;
const BULK: NonNullable<Handlers["bulk"]> = {
	deleteMany: noop,
	dropTarget: () => ({ accepts: () => false, onDrop: noop }),
	moveToProject: noop,
	openInNewTabs: noop,
	projects: [],
	setArchived: noop,
	setPinned: noop,
	setRead: noop,
};

function buildHandlers(activeId: string, unreadIds: Set<string>): Handlers {
	return {
		activeConversationId: activeId,
		agents: NO_AGENTS,
		archivedIds: NO_IDS,
		bulk: BULK,
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
		onSelectConversation: noop,
		onSetConversationIcon: noop,
		onToggleArchive: noop,
		onTogglePin: noop,
		pinnedIds: NO_IDS,
		projectNameForFolder: (folder: string) => folder,
		projectTargets: [],
		target: { token: null, url: "http://127.0.0.1:7980" },
		unreadIds,
	};
}

let bump: () => void = noop;
let setActive: (id: string) => void = noop;

function Sidebar({
	conversations,
	unreadIds,
}: {
	conversations: Conversation[];
	unreadIds: Set<string>;
}) {
	const [activeId, setActiveId] = useState("c0");
	const [, setTick] = useState(0);
	bump = () => setTick((value) => value + 1);
	setActive = setActiveId;
	const handlers = useStableChatRowHandlers(buildHandlers(activeId, unreadIds));
	return <ChatRowList conversations={conversations} handlers={handlers} />;
}

let root: Root | null = null;
let scroller: HTMLDivElement | null = null;

// Layout-free DOM reports every rect at 0; the list starts at the scroller's
// top, so it moves up as the scroller scrolls.
const nativeRect = HTMLElement.prototype.getBoundingClientRect;
HTMLElement.prototype.getBoundingClientRect = function rect(this: HTMLElement) {
	const base = nativeRect.call(this);
	if (this.dataset.testid !== "sidebar-virtual-chat-rows") {
		return base;
	}
	const top = -(scroller?.scrollTop ?? 0);
	return { ...base.toJSON(), bottom: top, top, y: top } as DOMRect;
};

async function mount(count: number, unreadIds: Set<string> = NO_IDS) {
	scroller = document.createElement("div");
	scroller.style.overflowY = "auto";
	scroller.style.height = `${VIEWPORT_PX}px`;
	Object.defineProperty(scroller, "offsetHeight", { value: VIEWPORT_PX });
	Object.defineProperty(scroller, "offsetWidth", { value: 240 });
	Object.defineProperty(scroller, "clientHeight", { value: VIEWPORT_PX });
	Object.defineProperty(scroller, "scrollHeight", {
		value: count * ROW_PITCH_PX,
	});
	// Layout-free DOM clamps scrollTop to a zero scroll height; keep the value.
	let scrollTop = 0;
	Object.defineProperty(scroller, "scrollTop", {
		get: () => scrollTop,
		set: (value: number) => {
			scrollTop = value;
		},
	});
	// Layout-free DOM: a scrollTo lands where it was asked to.
	scroller.scrollTo = ((options: ScrollToOptions) => {
		if (scroller && typeof options.top === "number") {
			scroller.scrollTop = options.top;
			scroller.dispatchEvent(new Event("scroll"));
		}
	}) as typeof scroller.scrollTo;
	document.body.append(scroller);
	root = createRoot(scroller);
	await act(async () => {
		root?.render(
			<QueryClientProvider client={new QueryClient()}>
				<TabsProvider>
					<Sidebar
						conversations={makeConversations(count)}
						unreadIds={unreadIds}
					/>
				</TabsProvider>
			</QueryClientProvider>
		);
	});
}

async function scrollTo(top: number) {
	await act(async () => {
		if (scroller) {
			scroller.scrollTop = top;
			scroller.dispatchEvent(new Event("scroll"));
		}
	});
}

function mountedRowIds(): string[] {
	return Array.from(
		scroller?.querySelectorAll("[data-sidebar-chat-id]") ?? [],
		(row) => row.getAttribute("data-sidebar-chat-id") ?? ""
	);
}

function row(id: string): HTMLElement | null {
	return (
		scroller?.querySelector<HTMLElement>(`[data-sidebar-chat-id="${id}"]`) ??
		null
	);
}

function totalRenders(): number {
	let total = 0;
	for (const count of rowRenders.values()) {
		total += count;
	}
	return total;
}

beforeEach(() => {
	rowRenders.clear();
	useSidebarChatSelection.setState({
		anchorId: null,
		selectedIds: new Set(),
	});
});

afterEach(async () => {
	await act(async () => root?.unmount());
	scroller?.remove();
	root = null;
	scroller = null;
});

test("a list at the threshold still renders every row", async () => {
	await mount(CHAT_ROW_VIRTUALIZE_THRESHOLD);
	expect(mountedRowIds()).toHaveLength(CHAT_ROW_VIRTUALIZE_THRESHOLD);
	expect(
		scroller?.querySelector('[data-testid="sidebar-virtual-chat-rows"]')
	).toBeNull();
});

test("1,000 chats mount and render only the rows near the viewport", async () => {
	await mount(1000);
	const mounted = mountedRowIds();
	// One viewport of h-8 rows plus overscan, not 1,000 rows.
	expect(mounted.length).toBeGreaterThanOrEqual(VIEWPORT_PX / ROW_PITCH_PX);
	expect(mounted.length).toBeLessThan(60);
	expect(mounted[0]).toBe("c0");
	// The first paint guesses the viewport, so a few more rows render once.
	expect(rowRenders.size).toBeLessThan(60);
	expect(totalRenders()).toBeLessThan(120);
	// The list keeps the full scroll height so the scrollbar stays honest.
	const list = scroller?.querySelector<HTMLElement>(
		'[data-testid="sidebar-virtual-chat-rows"]'
	);
	expect(Number.parseInt(list?.style.height ?? "0", 10)).toBe(
		1000 * ROW_PITCH_PX - 2
	);
});

test("an unrelated sidebar render re-renders no mounted row", async () => {
	await mount(1000);
	const before = totalRenders();
	await act(async () => bump());
	await act(async () => bump());
	expect(totalRenders()).toBe(before);
});

test("scrolling swaps the window and keeps the open chat mounted", async () => {
	await mount(1000);
	await scrollTo(500 * ROW_PITCH_PX);
	const mounted = mountedRowIds();
	expect(mounted).toContain("c500");
	expect(mounted).not.toContain("c100");
	// The open chat (c0) stays mounted far above the window.
	expect(mounted).toContain("c0");
	expect(mounted.length).toBeLessThan(60);
});

test("opening an offscreen chat scrolls its row into view", async () => {
	await mount(1000);
	await act(async () => setActive("c700"));
	expect(scroller?.scrollTop ?? 0).toBeGreaterThan(600 * ROW_PITCH_PX);
	expect(mountedRowIds()).toContain("c700");
});

test("the nearest unread rows outside the window stay mounted", async () => {
	await mount(1000, new Set(["c300", "c900"]));
	expect(row("c300")?.getAttribute("data-sidebar-unread")).toBe("true");
	expect(row("c900")).toBeNull();
	await scrollTo(500 * ROW_PITCH_PX);
	expect(row("c300")).not.toBeNull();
	expect(row("c900")).not.toBeNull();
});

test("shift-click selects a range across unmounted rows", async () => {
	await mount(1000);
	await act(async () => row("c2")?.click());
	await scrollTo(800 * ROW_PITCH_PX);
	await act(async () => {
		row("c805")?.dispatchEvent(
			new MouseEvent("click", { bubbles: true, shiftKey: true })
		);
	});
	const { selectedIds } = useSidebarChatSelection.getState();
	expect(selectedIds.size).toBe(804);
	expect(selectedIds.has("c400")).toBe(true);
});

test("arrow keys reach a neighbour that is not mounted", async () => {
	await mount(1000);
	await act(async () => row("c0")?.focus());
	await scrollTo(800 * ROW_PITCH_PX);
	// The focused row stays mounted while the window moves away from it.
	expect(row("c0")).not.toBeNull();
	expect(row("c1")).toBeNull();
	await act(async () => {
		row("c0")?.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" })
		);
	});
	await act(async () => undefined);
	expect(document.activeElement).toBe(row("c1"));
});
