import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	createDefaultWorkbench,
	type WorkbenchItem,
} from "@ryu/workbench/model";
import {
	parseWorkbenchSnapshot,
	serializeWorkbenchSnapshot,
} from "@ryu/workbench/persistence";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	DesktopWorkbenchProvider,
	type DesktopWorkbenchValue,
	useDesktopWorkbench,
	useWorkbenchItem,
} from "./DesktopWorkbenchContext.tsx";
import { WORKBENCH_STORAGE_KEY } from "./desktop-workbench-persistence.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

// SAFETY: The actual installed ReactDOM act environment reads this optional
// global flag. This test writes the authored boolean true to that native hook;
// the declaration gap concerns only this flag, without asserting other globals
// or replacing the registered DOM/native React test environment.
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ROUTE_ITEM: WorkbenchItem = {
	closable: true,
	duplicable: true,
	id: "route-item",
	pinned: false,
	preferredRegion: "center",
	scope: { kind: "window" },
	source: { kind: "route", path: "/library" },
	title: "Library",
};

describe("DesktopWorkbenchProvider", () => {
	let container: HTMLDivElement;
	let root: Root;
	let latest: DesktopWorkbenchValue | undefined;
	let selectedItem: WorkbenchItem | undefined;

	function Probe({ children }: { children?: ReactNode }) {
		latest = useDesktopWorkbench();
		selectedItem = useWorkbenchItem(ROUTE_ITEM.id);
		return children ?? null;
	}

	beforeEach(() => {
		localStorage.clear();
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		latest = undefined;
		selectedItem = undefined;
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
	});

	test("applies workbench transitions and flushes one persisted snapshot", async () => {
		await act(async () => {
			root.render(
				<DesktopWorkbenchProvider
					makeId={(prefix) => prefix}
					persistenceDelayMs={60_000}
					storage={localStorage}
				>
					<Probe />
				</DesktopWorkbenchProvider>
			);
		});

		const centerGroupId = latest?.state.groups.find(
			(group) => group.region === "center"
		)?.id;
		const rightGroupId = latest?.state.groups.find(
			(group) => group.region === "right"
		)?.id;
		expect(centerGroupId).toBeDefined();
		expect(rightGroupId).toBeDefined();

		await act(async () => {
			latest?.dispatch({
				type: "item/open",
				groupId: centerGroupId ?? "",
				item: ROUTE_ITEM,
			});
		});
		expect(selectedItem).toEqual(ROUTE_ITEM);

		await act(async () => {
			latest?.moveItem(ROUTE_ITEM.id, { region: "right" });
			latest?.dispatch({ type: "region/hide", region: "right" });
			latest?.dispatch({ type: "bottom/align", alignment: "full" });
			latest?.dispatch({
				type: "region/resize",
				region: "bottom",
				size: 333,
			});
		});

		expect(
			latest?.state.groups.find((group) => group.id === rightGroupId)?.itemIds
		).toContain(ROUTE_ITEM.id);
		expect(latest?.state.openRegions.right).toBe(false);
		expect(latest?.state.bottomAlignment).toBe("full");
		expect(latest?.state.sizes.bottom).toBe(333);

		await act(async () => {
			window.dispatchEvent(new Event("pagehide"));
		});
		const raw = localStorage.getItem(WORKBENCH_STORAGE_KEY);
		expect(raw).not.toBeNull();
		const parsed = parseWorkbenchSnapshot(JSON.parse(raw ?? "null"), {
			bottomGroupId: "workbench-bottom",
			centerGroupId: "workbench-center",
			leftGroupId: "workbench-left",
			navigationId: "workbench-navigation",
			rightGroupId: "workbench-right",
			makeItemId: () => "workbench-item",
		});
		expect(parsed?.sizes.bottom).toBe(333);
		expect(parsed?.bottomAlignment).toBe("full");
	});

	test("openItem and moveItem resolve region targets", async () => {
		await act(async () => {
			root.render(
				<DesktopWorkbenchProvider
					makeId={(prefix) => prefix}
					persistenceDelayMs={60_000}
					storage={localStorage}
				>
					<Probe />
				</DesktopWorkbenchProvider>
			);
		});

		let openedId = "";
		await act(async () => {
			openedId = latest?.openItem(ROUTE_ITEM, { region: "bottom" }) ?? "";
		});
		expect(openedId).toBe(ROUTE_ITEM.id);
		expect(
			latest?.state.groups.find((group) => group.region === "bottom")?.itemIds
		).toContain(ROUTE_ITEM.id);

		await act(async () => {
			latest?.moveItem(ROUTE_ITEM.id, { region: "center" });
		});
		expect(
			latest?.state.groups.find((group) => group.region === "center")?.itemIds
		).toContain(ROUTE_ITEM.id);
	});

	test("explicit group targets may place items in a locked Center group", async () => {
		const persisted = createDefaultWorkbench({
			bottomGroupId: "bottom-main",
			centerGroupId: "center-main",
			leftGroupId: "left-main",
			navigationId: "navigation",
			rightGroupId: "right-main",
		});
		persisted.groups = persisted.groups.map((group) =>
			group.id === "center-main" ? { ...group, locked: true } : group
		);
		persisted.groups.push({
			activeItemId: null,
			id: "center-secondary",
			itemIds: [],
			locked: false,
			region: "center",
		});
		persisted.centerTree = {
			type: "branch",
			children: [
				{ type: "leaf", groupId: "center-main" },
				{ type: "leaf", groupId: "center-secondary" },
			],
			orientation: "columns",
			sizes: [0.5, 0.5],
		};
		localStorage.setItem(
			WORKBENCH_STORAGE_KEY,
			JSON.stringify(serializeWorkbenchSnapshot(persisted))
		);
		await act(async () => {
			root.render(
				<DesktopWorkbenchProvider
					makeId={(prefix) => prefix}
					persistenceDelayMs={60_000}
					storage={localStorage}
				>
					<Probe />
				</DesktopWorkbenchProvider>
			);
		});

		const implicitItem: WorkbenchItem = {
			...ROUTE_ITEM,
			id: "implicit-route",
			source: { kind: "route", path: "/implicit" },
		};
		await act(async () => {
			latest?.openItem(ROUTE_ITEM, { groupId: "center-main" });
		});
		await act(async () => {
			latest?.openItem(implicitItem, { region: "center" });
		});

		expect(
			latest?.state.groups.find((group) => group.id === "center-main")?.itemIds
		).toContain(ROUTE_ITEM.id);
		expect(
			latest?.state.groups.find((group) => group.id === "center-secondary")
				?.itemIds
		).toContain(implicitItem.id);
	});
});
