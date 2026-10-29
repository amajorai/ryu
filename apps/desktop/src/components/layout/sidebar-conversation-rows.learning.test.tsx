// The chat row's "Exclude from learning" privacy toggle: it reads the stored
// flag from Core, flips its label optimistically, persists through
// POST /api/learn/exclude, and rolls the label back with a toast when Core
// refuses the write. A local Core stand-in records every request.
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import type { Root } from "react-dom/client";

const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
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

const { createRoot } = await import("react-dom/client");
const { TabsProvider } = await import("@/src/contexts/TabsContext.tsx");
const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
const { sileo } = await import("sileo");
const { ChatRow } = await import("./sidebar-conversation-rows.tsx");
type Handlers = import("./sidebar-conversation-rows.tsx").ChatRowHandlers;

let storedExcluded = false;
let failWrites = false;
const writes: unknown[] = [];
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const { pathname } = new URL(request.url);
		if (pathname === "/api/learn/exclude" && request.method === "POST") {
			const body = (await request.json()) as {
				conversation_id: string;
				excluded: boolean;
			};
			writes.push(body);
			if (failWrites) {
				return NativeResponse.json({ error: "unavailable" }, { status: 500 });
			}
			storedExcluded = body.excluded;
			return NativeResponse.json({ ...body, rows_updated: 1 });
		}
		if (pathname === "/api/learn/exclude/chat-1") {
			return NativeResponse.json({
				conversation_id: "chat-1",
				excluded: storedExcluded,
			});
		}
		return NativeResponse.json({});
	},
});

const noop = () => undefined;
const handlers: Handlers = {
	activeConversationId: null,
	agents: [],
	archivedIds: new Set(),
	canMakePrivate: true,
	loadMessages: () => Promise.resolve([]),
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
	pinnedIds: new Set(),
	projectNameForFolder: (path) => path,
	projectTargets: [],
	target: { url: server.url.origin, token: "fixture-node" },
	unreadIds: new Set(),
};

let root: Root | undefined;
let client: QueryClient;

async function mount() {
	root = createRoot(document.body.appendChild(document.createElement("div")));
	await act(async () =>
		root?.render(
			<QueryClientProvider client={client}>
				<TabsProvider>
					<Toaster />
					<ChatRow
						conv={{
							createdAt: 1,
							id: "chat-1",
							messages: [],
							title: "Quarterly plan",
							updatedAt: 1,
						}}
						handlers={handlers}
					/>
				</TabsProvider>
			</QueryClientProvider>
		)
	);
}

async function until(check: () => boolean) {
	for (let i = 0; i < 250; i++) {
		if (check()) {
			return;
		}
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 8));
		});
	}
	throw new Error("Timed out waiting for the condition");
}

const menuItems = () =>
	[...document.querySelectorAll('[role="menuitem"]')] as HTMLElement[];
const learningItem = () =>
	menuItems().find((item) =>
		/(Exclude from|Include in) learning/.test(item.textContent ?? "")
	);

async function openRowMenu() {
	const row = document.querySelector('[data-testid="sidebar-chat-row-chat-1"]');
	if (!row) {
		throw new Error("Missing chat row");
	}
	await act(async () => {
		row.dispatchEvent(
			new MouseEvent("contextmenu", {
				bubbles: true,
				cancelable: true,
				clientX: 4,
				clientY: 4,
			})
		);
	});
	await until(() => learningItem() !== undefined);
}

async function toggleFromMenu() {
	await openRowMenu();
	await act(async () => learningItem()?.click());
}

beforeEach(() => {
	storedExcluded = false;
	failWrites = false;
	writes.length = 0;
	client = new QueryClient();
	localStorage.clear();
});
afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
	client.clear();
	sileo.clear();
});
afterAll(() => server.stop(true));

test("the row reflects Core's stored exclusion and persists the flip", async () => {
	storedExcluded = true;
	await mount();
	await openRowMenu();
	await until(
		() => learningItem()?.textContent?.trim() === "Include in learning"
	);
	await act(async () => learningItem()?.click());
	await until(() => writes.length === 1);
	expect(writes).toEqual([{ conversation_id: "chat-1", excluded: false }]);
	expect(storedExcluded).toBe(false);
	await openRowMenu();
	expect(learningItem()?.textContent?.trim()).toBe("Exclude from learning");
});

test("a refused write rolls the label back and explains it in a toast", async () => {
	failWrites = true;
	await mount();
	await toggleFromMenu();
	await until(() => writes.length === 1);
	expect(writes).toEqual([{ conversation_id: "chat-1", excluded: true }]);
	await until(() =>
		(document.body.textContent ?? "").includes(
			"Couldn't update this chat's learning privacy"
		)
	);
	expect(storedExcluded).toBe(false);
	await openRowMenu();
	expect(learningItem()?.textContent?.trim()).toBe("Exclude from learning");
});
