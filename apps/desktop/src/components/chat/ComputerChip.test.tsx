// The composer's computer chip: editable on an empty draft (where it writes the
// tab's computer binding, or the launchpad's own pick), locked once the chat has
// started, and absent with only one computer.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
mock.module("@/src/contexts/entitlement-context.tsx", () => ({
	useEntitlementContext: () => ({
		requestUpgrade: () => undefined,
		verdict: null,
	}),
}));
mock.module("@/src/lib/window-routing.ts", () => ({
	listenForEntityActivation: async () => () => undefined,
	registerWindowTabs: async () => undefined,
	tabEntityKey: () => null,
}));
const { createRoot } = await import("react-dom/client");
const { TabsProvider, useTabsContext } = await import(
	"@/src/contexts/TabsContext.tsx"
);
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { ComputerChip, TabComputerChip } = await import("./ComputerChip.tsx");

const initialStore = useNodeStore.getState();
const nodes = [
	{ name: "local", url: "http://127.0.0.1:9", token: null },
	{ name: "studio", url: "http://127.0.0.1:8", token: "t-studio" },
];
let root: Root | undefined;
let client: QueryClient;
let tabs: ReturnType<typeof useTabsContext> | undefined;
function ReadTabs() {
	tabs = useTabsContext();
	return null;
}
async function render(node: ReactNode) {
	root ??= createRoot(document.body.appendChild(document.createElement("div")));
	await act(async () =>
		root?.render(
			<QueryClientProvider client={client}>{node}</QueryClientProvider>
		)
	);
}
const chip = () =>
	document.querySelector('[data-testid="composer-computer-chip"]');
async function pick(label: string) {
	const trigger = chip();
	if (!(trigger instanceof HTMLElement)) {
		throw new Error("The computer chip is not rendered");
	}
	await act(async () => {
		trigger.click();
		await new Promise((resolve) => setTimeout(resolve, 10));
	});
	const item = [...document.querySelectorAll('[role="menuitem"]')].find(
		(candidate) => candidate.textContent?.includes(label)
	);
	if (!(item instanceof HTMLElement)) {
		throw new Error(`No "${label}" option in the computer menu`);
	}
	await act(async () => item.click());
}

beforeEach(() => {
	localStorage.clear();
	client = new QueryClient();
	Reflect.set(window, "__TAURI_INTERNALS__", {
		invoke: async (command: string) =>
			command === "test_node" ? { online: true } : null,
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
});

test("on an empty draft the chip is editable and sets the tab's computer", async () => {
	await render(
		<TabsProvider initialTab={{ path: "/chat" }}>
			<ReadTabs />
		</TabsProvider>
	);
	const tabId = tabs?.activeTabId ?? "";
	await render(
		<TabsProvider initialTab={{ path: "/chat" }}>
			<ReadTabs />
			<TabComputerChip tabId={tabId} />
		</TabsProvider>
	);
	expect(chip()?.getAttribute("data-locked")).toBeNull();
	expect(chip()?.textContent).toContain("Local");
	await pick("Studio");
	expect(useNodeStore.getState().tabOverrides[tabId]).toBe("studio");
	expect(chip()?.textContent).toContain("Studio");
	await pick("Local");
	expect(useNodeStore.getState().tabOverrides[tabId]).toBeUndefined();
});

test("once the chat has started the chip is locked", async () => {
	await render(
		<TabsProvider initialTab={{ path: "/chat", conversationId: "started" }}>
			<ReadTabs />
		</TabsProvider>
	);
	const tabId = tabs?.activeTabId ?? "";
	await act(async () =>
		useNodeStore.getState().setTabOverride(tabId, "studio")
	);
	await render(
		<TabsProvider initialTab={{ path: "/chat", conversationId: "started" }}>
			<ReadTabs />
			<TabComputerChip conversationId="started" tabId={tabId} />
		</TabsProvider>
	);
	expect(chip()?.getAttribute("data-locked")).toBe("true");
	expect(chip()?.getAttribute("aria-label")).toContain(
		"Start a new chat to use another computer"
	);
	expect(chip()?.textContent).toContain("Studio");
});

test("the launchpad's controlled chip reports the pick it will open the tab on", async () => {
	const picks: string[] = [];
	await render(
		<ComputerChip onChange={(name) => picks.push(name)} value={null} />
	);
	await pick("Studio");
	expect(picks).toEqual(["studio"]);
});

test("with one computer there is nothing to choose", async () => {
	useNodeStore.setState({ nodes: [nodes[0]] });
	await render(<ComputerChip onChange={() => undefined} value={null} />);
	expect(chip()).toBeNull();
});

test("with per-tab computers off the chip is hidden, so it never claims a pick", async () => {
	localStorage.setItem("ryu_node_tab_override_enabled", "false");
	await render(<ComputerChip onChange={() => undefined} value="studio" />);
	expect(chip()).toBeNull();
});
