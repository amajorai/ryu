// Per-tab computer binding through `openTab({ node })`: dedupe is per computer,
// the binding is applied only to a tab this call opened or focused (never the
// active tab handed back at the tab cap), a reused tab drops a stale binding,
// and the binding survives a session save / restore.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let upgradePrompts = 0;
mock.module("@/src/lib/api/billing.ts", () => ({
	// Agent installs reach the server-driven feature flags (Template Rewards),
	// which read the entitlement snapshot; no account is signed in here.
	fetchEntitlementSnapshot: async () => null,
	hasBillingAuth: () => true,
}));
mock.module("@/src/contexts/entitlement-context.tsx", () => ({
	useEntitlementContext: () => ({
		requestUpgrade: () => {
			upgradePrompts += 1;
		},
		requestDesktopLicense: () => {
			upgradePrompts += 1;
		},
		// A RESOLVED free verdict: an unresolved (null) one fails open.
		verdict: { plan: null, proUnlocked: false },
	}),
}));
mock.module("@/src/lib/window-routing.ts", () => ({
	listenForEntityActivation: async () => () => undefined,
	registerWindowTabs: async () => undefined,
	tabEntityKey: () => null,
}));
const { TabsProvider, useTabsContext } = await import("./TabsContext.tsx");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");

const nodes = [
	{ name: "local", url: "http://127.0.0.1:1", token: null },
	{ name: "studio", url: "http://127.0.0.1:2", token: "studio-token" },
];
let root: Root;
let tabs: ReturnType<typeof useTabsContext> | undefined;
function ReadTabs() {
	tabs = useTabsContext();
	return null;
}
const overrides = () => useNodeStore.getState().tabOverrides;

beforeEach(() => {
	localStorage.clear();
	upgradePrompts = 0;
	useNodeStore.setState({
		nodes,
		defaultNode: "local",
		tabOverrides: {},
		autoSelect: false,
		autoSelectedNode: null,
	});
	root = createRoot(document.createElement("div"));
});

afterEach(async () => {
	await act(() => root.unmount());
	localStorage.clear();
});

async function mount(initial?: { conversationId: string }) {
	await act(() =>
		root.render(
			<TabsProvider
				initialTab={
					initial
						? { path: "/chat", conversationId: initial.conversationId }
						: undefined
				}
			>
				<ReadTabs />
			</TabsProvider>
		)
	);
}

test("the same id on another computer opens a new tab, and a second open focuses it", async () => {
	await mount({ conversationId: "shared" });
	const defaultTabId = tabs?.activeTabId;
	let studioTabId = "";
	await act(() => {
		studioTabId =
			tabs?.openTab("/chat", { conversationId: "shared", node: "studio" }) ??
			"";
	});
	expect(studioTabId).not.toBe(defaultTabId);
	expect(tabs?.tabs).toHaveLength(2);
	expect(overrides()[studioTabId]).toBe("studio");
	expect(overrides()[defaultTabId ?? ""]).toBeUndefined();

	await act(() => {
		tabs?.openTab("/chat", { conversationId: "shared" });
	});
	expect(tabs?.activeTabId).toBe(defaultTabId);
	await act(() => {
		tabs?.openTab("/chat", { conversationId: "shared", node: "studio" });
	});
	expect(tabs?.tabs).toHaveLength(2);
	expect(tabs?.activeTabId).toBe(studioTabId);
});

test("a handoff's explicit run mode applies to a new tab and to a focused one", async () => {
	await mount();
	let studioTabId = "";
	await act(() => {
		studioTabId =
			tabs?.openTab("/chat", {
				conversationId: "handed",
				node: "studio",
				worktreeMode: false,
			}) ?? "";
	});
	const studioTab = () => tabs?.tabs.find((tab) => tab.id === studioTabId);
	expect(studioTab()?.worktreeMode).toBe(false);

	await act(() => {
		tabs?.updateTabWorktreeMode(studioTabId, true);
	});
	expect(studioTab()?.worktreeMode).toBe(true);
	// A plain focus keeps the tab's own run mode...
	await act(() => {
		tabs?.openTab("/chat", { conversationId: "handed", node: "studio" });
	});
	expect(studioTab()?.worktreeMode).toBe(true);
	// ...and a second handoff onto the open tab turns isolation off again.
	await act(() => {
		tabs?.openTab("/chat", {
			conversationId: "handed",
			node: "studio",
			worktreeMode: false,
		});
	});
	expect(tabs?.tabs).toHaveLength(1);
	expect(tabs?.activeTabId).toBe(studioTabId);
	expect(studioTab()?.worktreeMode).toBe(false);
});

test("naming the default computer dedupes onto the default tab", async () => {
	await mount({ conversationId: "shared" });
	const defaultTabId = tabs?.activeTabId;
	await act(() => {
		tabs?.openTab("/chat", { conversationId: "shared", node: "local" });
	});
	expect(tabs?.tabs).toHaveLength(1);
	expect(tabs?.activeTabId).toBe(defaultTabId);
	expect(overrides()).toEqual({});
});

test("at the tab cap the active tab is never rebound", async () => {
	await mount({ conversationId: "first" });
	await act(() => {
		tabs?.openTab("/chat", { conversationId: "second" });
	});
	await act(() => {
		tabs?.openTab("/chat", { conversationId: "third" });
	});
	const active = tabs?.activeTabId ?? "";
	let returned = "";
	await act(() => {
		returned =
			tabs?.openTab("/chat", { conversationId: "fourth", node: "studio" }) ??
			"";
	});
	expect(upgradePrompts).toBe(1);
	expect(returned).toBe(active);
	expect(tabs?.tabs).toHaveLength(3);
	expect(overrides()[active]).toBeUndefined();
});

test("open-in-current-tab reuse clears a stale binding", async () => {
	await mount({ conversationId: "first" });
	const tabId = tabs?.activeTabId ?? "";
	await act(() => useNodeStore.getState().setTabOverride(tabId, "studio"));
	localStorage.setItem("ryu_tab_open_behavior", "current");
	await act(() => {
		tabs?.openTab("/chat", { conversationId: "elsewhere" });
	});
	expect(tabs?.activeTabId).toBe(tabId);
	expect(overrides()[tabId]).toBeUndefined();

	await act(() => {
		tabs?.openTab("/chat", { conversationId: "remote", node: "studio" });
	});
	expect(tabs?.activeTabId).toBe(tabId);
	expect(overrides()[tabId]).toBe("studio");
});

test("the binding survives a session save and restore", async () => {
	localStorage.setItem("ryu_startup_behavior", "restore");
	await mount();
	await act(() => {
		tabs?.openTab("/chat", { conversationId: "remote", node: "studio" });
	});
	await act(() => {
		tabs?.openTab("/chat", { conversationId: "here" });
	});
	await act(() => root.unmount());
	const saved = JSON.parse(localStorage.getItem("ryu_session_tabs") ?? "{}");
	expect(
		saved.tabs.map((t: { conversationId: string; node?: string }) => [
			t.conversationId,
			t.node ?? null,
		])
	).toEqual([
		["remote", "studio"],
		["here", null],
	]);

	useNodeStore.setState({ tabOverrides: {} });
	root = createRoot(document.createElement("div"));
	await mount();
	const remote = tabs?.tabs.find((t) => t.conversationId === "remote");
	const here = tabs?.tabs.find((t) => t.conversationId === "here");
	expect(remote).toBeDefined();
	expect(overrides()[remote?.id ?? ""]).toBe("studio");
	expect(overrides()[here?.id ?? ""]).toBeUndefined();
	expect(remote && "restoredNode" in remote).toBe(false);
});

test("a thread forked from a bound tab opens on the same computer", async () => {
	const { useTabBoundNode } = await import("./TabNodeChatHistory.tsx");
	await mount({ conversationId: "first" });
	let sourceTabId = "";
	await act(() => {
		sourceTabId =
			tabs?.openTab("/chat", { conversationId: "remote", node: "studio" }) ??
			"";
	});
	// ChatPage passes the tab's bound computer to the fork / focused-thread open.
	let boundName: string | undefined;
	function ReadBound() {
		boundName = useTabBoundNode(sourceTabId)?.name;
		return null;
	}
	const probe = createRoot(document.createElement("div"));
	await act(() => probe.render(<ReadBound />));
	expect(boundName).toBe("studio");
	let forkTabId = "";
	await act(() => {
		forkTabId =
			tabs?.openTab("/chat", {
				conversationId: "fork",
				forceNew: true,
				node: boundName,
			}) ?? "";
	});
	expect(forkTabId).not.toBe(sourceTabId);
	expect(overrides()[forkTabId]).toBe("studio");
	await act(() => probe.unmount());
});
