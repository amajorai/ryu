import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { TabViewPane } = await import("./TabViewPane.tsx");
const { contributionRegistry } = await import(
	"@/src/contributions/registry.ts"
);
const { useCurrentTabId, useIsActiveTab } = await import(
	"@/src/contexts/TabsContext.tsx"
);
type Tab = import("@/src/contexts/TabsContext.tsx").Tab;

// Chat tabs live at `/chat`, the one route every product mode admits
// (including the default Bot mode). This process never imports the built-in
// routes, so the fixture page below is the only `/chat` renderer.
const ROUTE_PATH = "/chat";
if (contributionRegistry.resolve(ROUTE_PATH) !== null) {
	throw new Error("A /chat route is already registered in this process");
}

interface PageEvent {
	conversation: string | undefined;
	kind: "mount" | "unmount";
}
const events: PageEvent[] = [];
const order: string[] = [];

// The ChatPage contract that made the remount necessary: the page seeds its
// conversation from props once, on mount, and keeps local state afterwards.
function SeededPage({
	initialConversation,
	onClose,
}: {
	initialConversation: string | undefined;
	onClose: () => void;
}) {
	const [conversation] = useState(initialConversation);
	const [count, setCount] = useState(0);
	const active = useIsActiveTab();
	const tabId = useCurrentTabId();
	useEffect(() => {
		events.push({ conversation, kind: "mount" });
		return () => {
			events.push({ conversation, kind: "unmount" });
		};
	}, [conversation]);
	return (
		<div>
			<p data-testid="conversation">{`Showing ${conversation}`}</p>
			<p data-testid="tab-context">{`${tabId}:${active ? "active" : "idle"}`}</p>
			<button
				onClick={() => setCount((value) => value + 1)}
				onMouseDown={() => order.push("route-mousedown")}
				type="button"
			>
				{`Count ${count}`}
			</button>
			<button onClick={onClose} type="button">
				Close from route
			</button>
		</div>
	);
}

const unregister = contributionRegistry.registerRoute({
	kind: "exact",
	path: ROUTE_PATH,
	render: (tab, context) => (
		<SeededPage
			initialConversation={tab.conversationId}
			onClose={context.onClose}
		/>
	),
});

afterAll(async () => {
	unregister();
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	events.length = 0;
	order.length = 0;
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
});

function tab(overrides: Partial<Tab> = {}): Tab {
	return {
		id: "tab-1",
		path: ROUTE_PATH,
		title: "Launch plan",
		conversationId: "conversation-a",
		...overrides,
	};
}

interface PaneProps {
	focused?: boolean;
	onClose?: () => void;
	onFocus?: () => void;
	tab: Tab;
}

async function renderPane({
	focused = true,
	onClose = () => undefined,
	onFocus = () => undefined,
	tab: paneTab,
}: PaneProps) {
	await act(async () =>
		root.render(
			<TabViewPane
				focused={focused}
				onClose={onClose}
				onFocus={onFocus}
				tab={paneTab}
			/>
		)
	);
}

function text(testId: string) {
	return host.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null;
}

function button(name: string): HTMLButtonElement {
	for (const element of host.querySelectorAll("button")) {
		if (element.textContent === name) {
			return element;
		}
	}
	throw new Error(`No button named ${name}`);
}

async function click(element: HTMLElement) {
	await act(async () => element.click());
}

async function mouseDown(element: HTMLElement, buttonIndex: number) {
	await act(async () => {
		element.dispatchEvent(
			new MouseEvent("mousedown", { bubbles: true, button: buttonIndex })
		);
	});
}

test("in-place navigation that bumps navToken remounts the route, so a seed-once page shows the new conversation and drops the old one's state", async () => {
	await renderPane({ tab: tab() });
	expect(text("conversation")).toBe("Showing conversation-a");
	await click(button("Count 0"));
	await click(button("Count 1"));
	expect(button("Count 2")).toBeDefined();

	// A re-render with the same token (a rename) reuses the mounted page.
	await renderPane({ tab: tab({ title: "Renamed plan" }) });
	expect(host.querySelector("section")?.getAttribute("aria-label")).toBe(
		"Renamed plan tab"
	);
	expect(text("conversation")).toBe("Showing conversation-a");
	expect(button("Count 2")).toBeDefined();
	expect(events).toEqual([{ conversation: "conversation-a", kind: "mount" }]);

	// The same pane navigates to another conversation: the tab keeps its id and
	// the page seeds again from the new props.
	await renderPane({
		tab: tab({ conversationId: "conversation-b", navToken: 1 }),
	});
	expect(text("conversation")).toBe("Showing conversation-b");
	expect(button("Count 0")).toBeDefined();
	expect(
		host
			.querySelector("[data-tab-view-pane]")
			?.getAttribute("data-tab-view-pane")
	).toBe("tab-1");
	expect(events).toEqual([
		{ conversation: "conversation-a", kind: "mount" },
		{ conversation: "conversation-a", kind: "unmount" },
		{ conversation: "conversation-b", kind: "mount" },
	]);

	// Navigating back is a new token too, not a return to the stale instance.
	await renderPane({
		tab: tab({ conversationId: "conversation-a", navToken: 2 }),
	});
	expect(text("conversation")).toBe("Showing conversation-a");
	expect(button("Count 0")).toBeDefined();
	expect(events.slice(3)).toEqual([
		{ conversation: "conversation-b", kind: "unmount" },
		{ conversation: "conversation-a", kind: "mount" },
	]);
});

test("an unfocused pane focuses on a primary mouse down before its route handles it, and focus changes do not remount the route", async () => {
	const focusCalls: string[] = [];
	const onFocus = () => {
		focusCalls.push("focus");
		order.push("pane-focus");
	};
	await renderPane({ focused: false, onFocus, tab: tab() });
	expect(text("tab-context")).toBe("tab-1:idle");
	expect(host.querySelector("section")?.dataset.focused).toBe("false");

	await mouseDown(button("Count 0"), 2);
	expect(focusCalls).toEqual([]);
	expect(order).toEqual(["route-mousedown"]);

	await mouseDown(button("Count 0"), 0);
	expect(focusCalls).toEqual(["focus"]);
	expect(order).toEqual(["route-mousedown", "pane-focus", "route-mousedown"]);

	await renderPane({ focused: true, onFocus, tab: tab() });
	expect(text("tab-context")).toBe("tab-1:active");
	await mouseDown(button("Count 0"), 0);
	expect(focusCalls).toEqual(["focus"]);
	expect(events).toEqual([{ conversation: "conversation-a", kind: "mount" }]);
});

test("the route's close action reaches the pane's current onClose after a re-render", async () => {
	const closed: string[] = [];
	await renderPane({ onClose: () => closed.push("first"), tab: tab() });
	await renderPane({ onClose: () => closed.push("second"), tab: tab() });
	await click(button("Close from route"));
	expect(closed).toEqual(["second"]);
	expect(events).toEqual([{ conversation: "conversation-a", kind: "mount" }]);
});

test("an unloaded tab unmounts its route and offers a reload; reloading mounts the route fresh", async () => {
	const focusCalls: string[] = [];
	const onFocus = () => focusCalls.push("focus");
	await renderPane({ onFocus, tab: tab() });
	await click(button("Count 0"));

	await renderPane({ onFocus, tab: tab({ unloaded: true }) });
	expect(text("conversation")).toBeNull();
	expect(host.textContent).toContain("This tab is unloaded to save memory.");
	expect(events).toEqual([
		{ conversation: "conversation-a", kind: "mount" },
		{ conversation: "conversation-a", kind: "unmount" },
	]);
	await click(button("Reload tab"));
	expect(focusCalls).toEqual(["focus"]);

	await renderPane({ onFocus, tab: tab({ unloaded: false }) });
	expect(text("conversation")).toBe("Showing conversation-a");
	expect(button("Count 0")).toBeDefined();
	expect(events.slice(2)).toEqual([
		{ conversation: "conversation-a", kind: "mount" },
	]);
});
