// The "All computers" sidebar: one group per configured computer (default first,
// with the regular sections), read-only remote rows that open a tab bound to
// their computer, offline computers kept and greyed, a context menu with no
// mutating actions, a per-computer "+", and disabled rows when per-tab
// computers are switched off.
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
const { TabsProvider, useTabsContext } = await import(
	"@/src/contexts/TabsContext.tsx"
);
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { nodeConversationsQueryKey } = await import(
	"@/src/hooks/useNodeConversations.ts"
);
const { AllComputersSidebar, groupRemoteThreads } = await import(
	"./AllComputersSidebar.tsx"
);

const initialStore = useNodeStore.getState();
// The studio copy's "Continued on" marker; DELETE .../continued clears it.
let studioContinuedOn: { nodeLabel: string; at: number } | null = null;
const clearedContinued: string[] = [];
const server: Bun.Server<undefined> = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: (request): Response => {
		const { pathname } = new URL(request.url);
		if (request.method === "DELETE" && pathname.endsWith("/continued")) {
			clearedContinued.push(pathname);
			studioContinuedOn = null;
			return NativeResponse.json({ continuedOn: null });
		}
		return NativeResponse.json({
			conversations: [
				{
					id: "remote-1",
					title: "Studio thread",
					folder_path: "/srv/app",
					created_at: 1,
					updated_at: Date.now(),
					message_count: 2,
					agent_id: null,
					branch: null,
					worktree_path: null,
					run_status: null,
					continued_on: studioContinuedOn,
				},
			],
		});
	},
});
const nodes = [
	{ name: "local", url: "http://127.0.0.1:9", token: null },
	{ name: "studio", url: `${server.url.origin}/studio`, token: "t-studio" },
	{
		name: "laptop",
		url: "http://127.0.0.1:8",
		token: "t-laptop",
		managed: true,
	},
];
const onlineByName: Record<string, boolean> = { studio: true, laptop: false };

let root: Root | undefined;
let client: QueryClient;
let tabs: ReturnType<typeof useTabsContext> | undefined;
const newChatOn: string[] = [];
function ReadTabs() {
	tabs = useTabsContext();
	return null;
}
async function mount() {
	root = createRoot(document.body.appendChild(document.createElement("div")));
	await act(async () =>
		root?.render(
			<QueryClientProvider client={client}>
				<TabsProvider>
					<ReadTabs />
					<AllComputersSidebar
						onNewChatOn={(node) => newChatOn.push(node.name)}
						renderLocalSections={() => <div data-testid="local-sections" />}
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
	if (!check()) {
		throw new Error("Timed out waiting for the condition");
	}
}
const query = (selector: string) => document.querySelector(selector);
function click(element: Element | null | undefined) {
	if (element instanceof HTMLElement) {
		element.click();
	}
}
const studioRow = () =>
	query('[data-testid="computers-thread-studio-remote-1"]');

beforeEach(() => {
	localStorage.clear();
	newChatOn.length = 0;
	studioContinuedOn = null;
	clearedContinued.length = 0;
	client = new QueryClient();
	Reflect.set(window, "__TAURI_INTERNALS__", {
		invoke: async (command: string, args?: { name?: string }) =>
			command === "test_node"
				? { online: onlineByName[args?.name ?? ""] ?? true }
				: null,
		transformCallback: () => 0,
	});
	useNodeStore.setState({
		nodes,
		defaultNode: "local",
		tabOverrides: {},
		autoSelect: false,
		autoSelectedNode: null,
	});
});
afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
	client.clear();
	Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
	useNodeStore.setState(initialStore, true);
	localStorage.clear();
});
afterAll(() => {
	server.stop(true);
	globalThis.fetch = nativeFetch;
});

test("one group per computer, default first with the regular sections", async () => {
	await mount();
	const groups = [
		...document.querySelectorAll('[data-testid^="computers-group-"]'),
	].map((group) => group.getAttribute("data-computer"));
	expect(groups).toEqual(["local", "studio", "laptop"]);
	expect(
		query(
			'[data-testid="computers-group-local"] [data-testid="local-sections"]'
		)
	).not.toBeNull();
	expect(
		query('[data-testid="computers-group-laptop"]')?.textContent
	).toContain("Cloud");
});

test("an offline computer stays listed; its last-known rows are greyed and disabled", async () => {
	await mount();
	await until(() =>
		Boolean(
			query('[data-testid="computers-group-laptop"]')?.textContent?.includes(
				"Offline. Threads appear when it reconnects."
			)
		)
	);
	await act(async () => {
		client.setQueryData(nodeConversationsQueryKey(nodes[2]), [
			{
				id: "seen",
				title: "Seen before",
				messages: [],
				createdAt: 1,
				updatedAt: Date.now(),
			},
		]);
	});
	await until(
		() => query('[data-testid="computers-thread-laptop-seen"]') !== null
	);
	const row = query('[data-testid="computers-thread-laptop-seen"]');
	expect(row?.getAttribute("aria-disabled")).toBe("true");
	expect(row?.className).toContain("opacity-60");
	expect(row?.getAttribute("title")).toContain("Offline");
	await act(async () => click(row));
	expect(tabs?.tabs).toHaveLength(0);
});

test("a remote row opens a tab bound to its computer", async () => {
	await mount();
	await until(() => studioRow() !== null);
	await act(async () => click(studioRow()));
	expect(tabs?.tabs).toHaveLength(1);
	const opened = tabs?.tabs[0];
	expect(opened?.conversationId).toBe("remote-1");
	expect(useNodeStore.getState().tabOverrides[opened?.id ?? ""]).toBe("studio");
});

test("the remote row menu offers only open actions", async () => {
	await mount();
	await until(() => studioRow() !== null);
	await act(async () => {
		studioRow()?.dispatchEvent(
			new MouseEvent("contextmenu", {
				bubbles: true,
				cancelable: true,
				clientX: 4,
				clientY: 4,
			})
		);
	});
	await until(() => document.querySelectorAll('[role="menuitem"]').length > 0);
	const items = [...document.querySelectorAll('[role="menuitem"]')].map(
		(item) => item.textContent?.trim()
	);
	expect(items).toContain("Open");
	expect(items).toContain("Open in new tab");
	for (const label of items) {
		expect(label).not.toMatch(/rename|delete|pin|move|archive|fork/i);
	}
});

async function openStudioMenu(): Promise<string[]> {
	await act(async () => {
		studioRow()?.dispatchEvent(
			new MouseEvent("contextmenu", {
				bubbles: true,
				cancelable: true,
				clientX: 4,
				clientY: 4,
			})
		);
	});
	await until(() => document.querySelectorAll('[role="menuitem"]').length > 0);
	return [...document.querySelectorAll('[role="menuitem"]')].map(
		(item) => item.textContent?.trim() ?? ""
	);
}

test("a remote row continued elsewhere shows the badge and takes it back on its computer", async () => {
	studioContinuedOn = { nodeLabel: "Laptop", at: 1 };
	await mount();
	await until(() => studioRow()?.textContent?.includes("on Laptop") === true);
	const items = await openStudioMenu();
	expect(items).toContain("Take back here");
	const takeBack = [...document.querySelectorAll('[role="menuitem"]')].find(
		(item) => item.textContent?.trim() === "Take back here"
	);
	await act(async () => click(takeBack));
	await until(() => clearedContinued.length === 1);
	expect(clearedContinued[0]).toBe(
		"/studio/api/rnp/v0/conversations/remote-1/continued"
	);
	await until(() => studioRow()?.textContent?.includes("on Laptop") === false);
});

test("a remote row not continued elsewhere offers no take back", async () => {
	await mount();
	await until(() => studioRow() !== null);
	expect(studioRow()?.textContent).not.toContain("on Laptop");
	expect(await openStudioMenu()).not.toContain("Take back here");
});

test("+ starts a new chat on that computer", async () => {
	await mount();
	const plus = query('[aria-label="New chat on Studio"]');
	await act(async () => click(plus));
	expect(newChatOn).toEqual(["studio"]);
});

test("with per-tab computers off, remote rows are disabled and can be turned back on", async () => {
	localStorage.setItem("ryu_node_tab_override_enabled", "false");
	await mount();
	await until(() => studioRow() !== null);
	expect(studioRow()?.getAttribute("aria-disabled")).toBe("true");
	await act(async () => click(studioRow()));
	expect(tabs?.tabs).toHaveLength(0);
	// "+" on another computer would bind a tab the app then ignores.
	const plus = query('[aria-label="New chat on Studio"]');
	expect(plus?.getAttribute("aria-disabled")).toBe("true");
	await act(async () => click(plus));
	expect(newChatOn).toEqual([]);
	await act(async () => click(query('[aria-label="New chat on Local"]')));
	expect(newChatOn).toEqual(["local"]);
	newChatOn.length = 0;
	const turnOn = [...document.querySelectorAll("button")].find(
		(button) => button.textContent === "Turn on per-tab computers"
	);
	await act(async () => click(turnOn));
	expect(localStorage.getItem("ryu_node_tab_override_enabled")).toBe("true");
	expect(studioRow()?.getAttribute("aria-disabled")).toBeNull();
	expect(
		query('[aria-label="New chat on Studio"]')?.getAttribute("aria-disabled")
	).toBeNull();
});

test("remote threads group by folder leaf, newest first, sessions hidden", () => {
	const base = { messages: [], createdAt: 1 };
	const grouped = groupRemoteThreads([
		{
			...base,
			id: "a",
			title: "A",
			updatedAt: 1,
			folderPath: "C:\\src\\api\\",
		},
		{ ...base, id: "b", title: "B", updatedAt: 3, folderPath: "C:\\src\\api" },
		{ ...base, id: "c", title: "C", updatedAt: 2 },
		{
			...base,
			id: "s",
			title: "Session",
			updatedAt: 9,
			hierarchy: { role: "session", spawnedByConversationId: "b" },
		},
	]);
	expect(
		grouped.folders.map((f) => [f.name, f.conversations.map((c) => c.id)])
	).toEqual([["api", ["b", "a"]]]);
	expect(grouped.loose.map((c) => c.id)).toEqual(["c"]);
});
