/* @jsxImportSource @opentui/react */
// Unit tests for the WorkspaceContext state store — the tab/pane reducer that
// backs every workspace keybinding (Ctrl+T open, Ctrl+W close, Ctrl+Shift+T
// restore, Ctrl+Tab cycle, Ctrl+Alt+S split). The provider owns all mutation, so
// the tests drive the real hook through a Capture probe (the same pattern as
// desktop-shell.smoke.test.tsx) and assert on the exposed `tabs`/`panes` state
// after each action. Actions that call setState are wrapped so the update commits
// before the next assertion. No renderer keys, no Core — pure state machine.

import { afterEach, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import {
	useWorkspace,
	WorkspaceProvider,
} from "../workspace/WorkspaceContext.tsx";

// The context value type is not exported; derive it from the hook (same idiom as
// desktop-shell.smoke.test.tsx) so the tests never need a production type export.
type WorkspaceContextValue = ReturnType<typeof useWorkspace>;

// Captured live workspace handle; refreshed on every render so reads see the
// latest committed state.
let ws: WorkspaceContextValue | null = null;

function Capture() {
	ws = useWorkspace();
	return null;
}

function Harness() {
	return (
		<WorkspaceProvider>
			<Capture />
		</WorkspaceProvider>
	);
}

let testSetup: Awaited<ReturnType<typeof testRender>> | null = null;

afterEach(() => {
	testSetup?.renderer.destroy();
	testSetup = null;
	ws = null;
});

// Boot the provider and return the live handle. Callers `act()` mutations via
// `commit` so a setState result is visible on the returned `ws` before asserting.
async function boot(): Promise<WorkspaceContextValue> {
	testSetup = await testRender(<Harness />, { width: 80, height: 24 });
	await testSetup.renderOnce();
	if (!ws) {
		throw new Error("workspace not captured");
	}
	return ws;
}

// Run a mutation, then flush the microtask + one render so the committed state is
// readable on the (refreshed) global `ws` handle.
async function commit(mutate: () => void): Promise<WorkspaceContextValue> {
	mutate();
	await new Promise((resolve) => setTimeout(resolve, 0));
	await testSetup?.renderOnce();
	if (!ws) {
		throw new Error("workspace not captured");
	}
	return ws;
}

function activePaneTabIds(w: WorkspaceContextValue): string[] {
	const pane = w.panes.find((p) => p.id === w.focusedPaneId);
	return pane?.tabIds ?? [];
}

// ── initial state ─────────────────────────────────────────────────────────────

test("boots with one home /chat tab in a single focused pane", async () => {
	const w = await boot();
	expect(w.tabs).toHaveLength(1);
	expect(w.tabs[0].path).toBe("/chat");
	expect(w.tabs[0].title).toBe("New chat");
	expect(w.panes).toHaveLength(1);
	expect(w.focusedPaneId).toBe(w.panes[0].id);
	expect(w.panes[0].activeTabId).toBe(w.tabs[0].id);
});

// ── openTab ───────────────────────────────────────────────────────────────────

test("openTab adds a tab and makes it active", async () => {
	await boot();
	let openedId = "";
	const w = await commit(() => {
		openedId = (ws as WorkspaceContextValue).openTab("/agents");
	});
	expect(w.tabs).toHaveLength(2);
	expect(w.tabs.some((t) => t.id === openedId && t.path === "/agents")).toBe(
		true
	);
	const pane = w.panes.find((p) => p.id === w.focusedPaneId);
	expect(pane?.activeTabId).toBe(openedId);
});

test("openTab reuses an existing singleton tab in the same pane", async () => {
	await boot();
	let first = "";
	await commit(() => {
		first = (ws as WorkspaceContextValue).openTab("/agents");
	});
	let second = "";
	const w = await commit(() => {
		second = (ws as WorkspaceContextValue).openTab("/agents");
	});
	// Same id returned, no duplicate tab created.
	expect(second).toBe(first);
	expect(w.tabs.filter((t) => t.path === "/agents")).toHaveLength(1);
});

test("openTab with forceNew opens a second tab for a singleton path", async () => {
	await boot();
	let first = "";
	await commit(() => {
		first = (ws as WorkspaceContextValue).openTab("/agents");
	});
	let second = "";
	const w = await commit(() => {
		second = (ws as WorkspaceContextValue).openTab("/agents", {
			forceNew: true,
		});
	});
	expect(second).not.toBe(first);
	expect(w.tabs.filter((t) => t.path === "/agents")).toHaveLength(2);
});

test("openTab never dedupes /chat — each open is a distinct tab", async () => {
	await boot();
	let a = "";
	let b = "";
	await commit(() => {
		a = (ws as WorkspaceContextValue).openTab("/chat");
	});
	const w = await commit(() => {
		b = (ws as WorkspaceContextValue).openTab("/chat");
	});
	expect(a).not.toBe(b);
	// initial home chat + two more.
	expect(w.tabs.filter((t) => t.path === "/chat")).toHaveLength(3);
});

test("openTab honours a title override", async () => {
	await boot();
	let id = "";
	const w = await commit(() => {
		id = (ws as WorkspaceContextValue).openTab("/chat", { title: "Draft" });
	});
	expect(w.tabs.find((t) => t.id === id)?.title).toBe("Draft");
});

// ── closeTab + restoreTab ─────────────────────────────────────────────────────

test("closeTab removes the tab and restoreTab reopens it at its index", async () => {
	await boot();
	let mid = "";
	await commit(() => {
		(ws as WorkspaceContextValue).openTab("/agents");
	});
	await commit(() => {
		mid = (ws as WorkspaceContextValue).openTab("/tools");
	});
	await commit(() => {
		(ws as WorkspaceContextValue).openTab("/spaces");
	});
	// Order in the pane: [chat, agents, tools, spaces]; close the middle "tools".
	const beforeIds = activePaneTabIds(ws as WorkspaceContextValue);
	const midIndex = beforeIds.indexOf(mid);
	expect(midIndex).toBe(2);

	const closed = await commit(() => {
		(ws as WorkspaceContextValue).closeTab(mid);
	});
	expect(closed.tabs.some((t) => t.id === mid)).toBe(false);

	const restored = await commit(() => {
		(ws as WorkspaceContextValue).restoreTab();
	});
	const afterIds = activePaneTabIds(restored);
	// Reopened tab carries the original path and lands back at its old index.
	const reopened = restored.tabs.find((t) => t.path === "/tools");
	expect(reopened).toBeDefined();
	expect(reopened?.id).toBe(afterIds[midIndex]);
});

test("closeTab refuses to close a pinned tab", async () => {
	await boot();
	let id = "";
	await commit(() => {
		id = (ws as WorkspaceContextValue).openTab("/agents");
	});
	await commit(() => {
		(ws as WorkspaceContextValue).pinTab(id);
	});
	const w = await commit(() => {
		(ws as WorkspaceContextValue).closeTab(id);
	});
	expect(w.tabs.some((t) => t.id === id)).toBe(true);
});

test("closing the last tab seeds a fresh home chat (workspace never blank)", async () => {
	const w0 = await boot();
	const onlyId = w0.tabs[0].id;
	const w = await commit(() => {
		(ws as WorkspaceContextValue).closeTab(onlyId);
	});
	// The original tab is gone but a fresh /chat replaces it.
	expect(w.tabs).toHaveLength(1);
	expect(w.tabs[0].id).not.toBe(onlyId);
	expect(w.tabs[0].path).toBe("/chat");
	expect(w.panes[0].activeTabId).toBe(w.tabs[0].id);
});

test("restoreTab is a no-op when nothing was closed", async () => {
	const w0 = await boot();
	const before = w0.tabs.length;
	const w = await commit(() => {
		(ws as WorkspaceContextValue).restoreTab();
	});
	expect(w.tabs).toHaveLength(before);
});

test("closing the active middle tab activates a surviving neighbour", async () => {
	await boot();
	let mid = "";
	await commit(() => {
		(ws as WorkspaceContextValue).openTab("/agents");
	});
	await commit(() => {
		mid = (ws as WorkspaceContextValue).openTab("/tools");
	});
	// /tools is the active (last-opened) tab. Close it.
	const w = await commit(() => {
		(ws as WorkspaceContextValue).closeTab(mid);
	});
	const pane = w.panes.find((p) => p.id === w.focusedPaneId);
	expect(pane?.activeTabId).not.toBe(mid);
	expect(pane?.tabIds.includes(pane.activeTabId ?? "")).toBe(true);
});

// ── cycleTab ──────────────────────────────────────────────────────────────────

test("cycleTab is a no-op with a single tab", async () => {
	const w0 = await boot();
	const activeBefore = w0.panes[0].activeTabId;
	const w = await commit(() => {
		(ws as WorkspaceContextValue).cycleTab(1);
	});
	expect(w.panes[0].activeTabId).toBe(activeBefore);
});

test("cycleTab advances and wraps around the focused pane's tabs", async () => {
	await boot();
	await commit(() => {
		(ws as WorkspaceContextValue).openTab("/agents");
	});
	await commit(() => {
		(ws as WorkspaceContextValue).openTab("/tools");
	});
	const ids = activePaneTabIds(ws as WorkspaceContextValue);
	expect(ids).toHaveLength(3);
	// Active is the last (/tools, index 2). +1 wraps to index 0.
	const wrapped = await commit(() => {
		(ws as WorkspaceContextValue).cycleTab(1);
	});
	expect(wrapped.panes[0].activeTabId).toBe(ids[0]);
	// -1 from index 0 wraps back to the last tab.
	const back = await commit(() => {
		(ws as WorkspaceContextValue).cycleTab(-1);
	});
	expect(back.panes[0].activeTabId).toBe(ids[2]);
});

// ── splitActive + focusPane ───────────────────────────────────────────────────

test("splitActive opens a second pane duplicating the active path, then merges back", async () => {
	await boot();
	await commit(() => {
		(ws as WorkspaceContextValue).openTab("/agents");
	});
	const split = await commit(() => {
		(ws as WorkspaceContextValue).splitActive();
	});
	expect(split.panes).toHaveLength(2);
	// New pane is focused and seeded with a copy of the active /agents path.
	const focused = split.panes.find((p) => p.id === split.focusedPaneId);
	const seedTabId = focused?.activeTabId ?? "";
	expect(split.tabs.find((t) => t.id === seedTabId)?.path).toBe("/agents");

	const merged = await commit(() => {
		(ws as WorkspaceContextValue).splitActive();
	});
	expect(merged.panes).toHaveLength(1);
	// Both panes' tabs fold into the survivor.
	expect(merged.panes[0].tabIds).toContain(seedTabId);
});

test("focusPane moves keyboard focus without changing active tabs", async () => {
	await boot();
	const split = await commit(() => {
		(ws as WorkspaceContextValue).splitActive();
	});
	expect(split.panes).toHaveLength(2);
	const first = split.panes[0].id;
	const second = split.panes[1].id;
	// Split focuses the new (second) pane; move focus back to the first.
	expect(split.focusedPaneId).toBe(second);
	const w = await commit(() => {
		(ws as WorkspaceContextValue).focusPane(first);
	});
	expect(w.focusedPaneId).toBe(first);
});

test("focusPane ignores an unknown pane id", async () => {
	const w0 = await boot();
	const before = w0.focusedPaneId;
	const w = await commit(() => {
		(ws as WorkspaceContextValue).focusPane("pane-does-not-exist");
	});
	expect(w.focusedPaneId).toBe(before);
});

// ── pinTab + activateTab ──────────────────────────────────────────────────────

test("pinTab toggles the pinned flag on and off", async () => {
	await boot();
	let id = "";
	await commit(() => {
		id = (ws as WorkspaceContextValue).openTab("/agents");
	});
	const pinned = await commit(() => {
		(ws as WorkspaceContextValue).pinTab(id);
	});
	expect(pinned.tabs.find((t) => t.id === id)?.pinned).toBe(true);
	const unpinned = await commit(() => {
		(ws as WorkspaceContextValue).pinTab(id);
	});
	expect(unpinned.tabs.find((t) => t.id === id)?.pinned).toBe(false);
});

test("activateTab makes a tab active and focuses its pane", async () => {
	await boot();
	const homeId = (ws as WorkspaceContextValue).tabs[0].id;
	const homePane = (ws as WorkspaceContextValue).panes[0].id;
	await commit(() => {
		(ws as WorkspaceContextValue).openTab("/agents");
	});
	// /agents is now active; re-activate the original home tab.
	const w = await commit(() => {
		(ws as WorkspaceContextValue).activateTab(homePane, homeId);
	});
	const pane = w.panes.find((p) => p.id === homePane);
	expect(pane?.activeTabId).toBe(homeId);
	expect(w.focusedPaneId).toBe(homePane);
});
