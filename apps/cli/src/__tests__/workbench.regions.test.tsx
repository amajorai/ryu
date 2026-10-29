/* @jsxImportSource @opentui/react */
// The TUI shares Desktop's workbench reducer: tabs move among Center, Right,
// and Bottom; focus follows direction keys; hidden regions keep their tabs; and
// a provider with persistence restores the saved layout. Rendering asserts the
// regions appear beside and below Center with the focused region named.

import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { RegionView } from "../workspace/RegionView.tsx";
import { SplitView } from "../workspace/SplitView.tsx";
import {
	initialWorkbench,
	useWorkspace,
	WorkspaceProvider,
} from "../workspace/WorkspaceContext.tsx";
import type { WorkbenchPersistence } from "../workspace/workbenchPersistence.ts";
import { testRender } from "./cli-test-render.ts";

type WorkspaceValue = ReturnType<typeof useWorkspace>;

let ws: WorkspaceValue | null = null;
let setup: Awaited<ReturnType<typeof testRender>> | null = null;

function Capture() {
	ws = useWorkspace();
	return null;
}

function current(): WorkspaceValue {
	if (!ws) {
		throw new Error("workspace not captured");
	}
	return ws;
}

afterEach(async () => {
	await act(async () => {
		setup?.renderer.destroy();
		await Promise.resolve();
	});
	setup = null;
	ws = null;
});

async function boot(persistence?: WorkbenchPersistence, withViews = false) {
	setup = await testRender(
		<WorkspaceProvider persistence={persistence}>
			<Capture />
			{withViews ? (
				<box flexDirection="column" flexGrow={1}>
					<box flexDirection="row" flexGrow={1}>
						<SplitView />
						<RegionView region="right" />
					</box>
					<RegionView region="bottom" />
				</box>
			) : null}
		</WorkspaceProvider>,
		{ height: 30, width: 120 }
	);
	await act(async () => {
		await setup?.renderOnce();
	});
	return current();
}

async function commit(mutate: () => void): Promise<WorkspaceValue> {
	await act(async () => {
		mutate();
		await setup?.flush();
	});
	return current();
}

test("moves the focused tab to Right and Bottom and back to Center", async () => {
	const initial = await boot();
	const agentsId = await commit(() => {
		initial.openTab("/agents");
	}).then((w) => w.panes[0]?.activeTabId ?? "");

	let w = await commit(() => current().moveActiveTo("right"));
	expect(w.regionGroups.right?.tabIds).toEqual([agentsId]);
	expect(w.focusedRegion).toBe("right");
	expect(w.panes[0]?.tabIds).not.toContain(agentsId);

	w = await commit(() => current().moveActiveTo("bottom"));
	expect(w.regionGroups.right).toBeNull();
	expect(w.regionGroups.bottom?.tabIds).toEqual([agentsId]);

	w = await commit(() => current().moveActiveTo("center"));
	expect(w.regionGroups.bottom).toBeNull();
	expect(w.panes[0]?.tabIds).toContain(agentsId);
	expect(w.focusedRegion).toBe("center");
});

test("moving the only Center tab away seeds a chat so Center is never blank", async () => {
	await boot();
	const w = await commit(() => current().moveActiveTo("right"));
	expect(w.regionGroups.right?.tabIds).toHaveLength(1);
	expect(w.panes[0]?.tabIds).toHaveLength(1);
	expect(w.tabs.find((tab) => tab.id === w.panes[0]?.activeTabId)?.path).toBe(
		"/chat"
	);
});

test("focuses panes by direction and keeps hidden regions' tabs", async () => {
	await boot();
	await commit(() => current().openTab("/agents"));
	await commit(() => current().moveActiveTo("bottom"));
	await commit(() => current().openTab("/tasks"));
	let w = await commit(() => current().moveActiveTo("right"));
	const centerId = w.panes[0]?.id ?? "missing-center";
	const rightId = w.regionGroups.right?.id ?? "missing-right";
	const bottomId = w.regionGroups.bottom?.id ?? "missing-bottom";

	w = await commit(() => current().focusDirection("left"));
	expect(w.focusedPaneId).toBe(centerId);
	w = await commit(() => current().focusDirection("right"));
	expect(w.focusedPaneId).toBe(rightId);
	w = await commit(() => current().focusDirection("down"));
	expect(w.focusedPaneId).toBe(bottomId);
	w = await commit(() => current().focusDirection("up"));
	expect(w.focusedPaneId).toBe(centerId);

	w = await commit(() => current().hideRegion("bottom"));
	expect(w.regionGroups.bottom).toBeNull();
	expect(
		w.state.groups.find((group) => group.region === "bottom")?.itemIds
	).toHaveLength(1);
	w = await commit(() => current().focusDirection("down"));
	expect(w.focusedPaneId).toBe(centerId);
	w = await commit(() => current().showRegion("bottom"));
	expect(w.regionGroups.bottom?.id).toBe(bottomId);
});

test("restores a closed side-region tab to its region", async () => {
	await boot();
	await commit(() => current().openTab("/agents"));
	let w = await commit(() => current().moveActiveTo("right"));
	const agentsId = w.regionGroups.right?.activeTabId ?? "";
	w = await commit(() => current().closeActiveTab());
	expect(w.regionGroups.right).toBeNull();
	w = await commit(() => current().restoreTab());
	expect(w.regionGroups.right?.tabIds).toEqual([agentsId]);
});

test("loads a saved layout and saves changes through the persistence adapter", async () => {
	const saved = initialWorkbench();
	saved.openRegions.bottom = false;
	const writes: number[] = [];
	const persistence: WorkbenchPersistence = {
		load: () => saved,
		save: (state) => {
			writes.push(state.items.length);
			return { ok: true };
		},
	};
	const w = await boot(persistence);
	expect(w.tabs.map((tab) => tab.id)).toEqual(
		saved.items.flatMap((item) =>
			item.source.kind === "route" ? [item.id] : []
		)
	);
	await commit(() => current().openTab("/agents"));
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 250));
	});
	expect(writes.at(-1)).toBe(saved.items.length + 1);
});

test("renders Right beside Center and Bottom below it, naming the focused region", async () => {
	// Start from a saved layout whose Center page is unregistered (the seeded
	// chat surface needs a Core connection), so each region renders its own
	// placeholder line and nothing else.
	const saved = initialWorkbench();
	saved.items = saved.items.map((item) =>
		item.source.kind === "route"
			? { ...item, source: { kind: "route", path: "/tool-proof-center" } }
			: item
	);
	await boot({ load: () => saved, save: () => ({ ok: true }) }, true);
	await commit(() => current().openTab("/tool-proof-right"));
	await commit(() => current().moveActiveTo("right"));
	await commit(() => current().openTab("/tool-proof-bottom"));
	await commit(() => current().moveActiveTo("bottom"));
	await act(async () => {
		await setup?.renderOnce();
	});
	const frame = setup?.captureCharFrame() ?? "";
	const lines = frame.split("\n");
	const rightLine = lines.findIndex((line) => line.includes("Right"));
	const bottomLine = lines.findIndex((line) => line.includes("Bottom"));
	expect(rightLine).toBeGreaterThanOrEqual(0);
	expect(bottomLine).toBeGreaterThan(rightLine);
	expect(lines[rightLine]?.indexOf("Right")).toBeGreaterThan(40);
	// The narrow Right region wraps its placeholder line.
	expect(frame).toContain("No surface registered for /tool-proof-");
	expect(frame).toContain("No surface registered for /tool-proof-bottom");
	expect(frame).not.toContain("┌");
});
