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
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	DesktopWorkbenchProvider,
	type DesktopWorkbenchValue,
	useDesktopWorkbench,
} from "./DesktopWorkbenchContext.tsx";
import { WORKBENCH_STORAGE_KEY } from "./desktop-workbench-persistence.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

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
const MAIN_CENTER = "workbench-center";
const SECOND_CENTER = "center-second";

describe("DesktopWorkbenchProvider stable actions", () => {
	let container: HTMLDivElement;
	let root: Root;
	let latest: DesktopWorkbenchValue | undefined;

	function Probe() {
		latest = useDesktopWorkbench();
		return null;
	}

	function value(): DesktopWorkbenchValue {
		if (!latest) {
			throw new Error("DesktopWorkbenchProvider has not rendered");
		}
		return latest;
	}

	function groupOf(itemId: string): string | undefined {
		return value().state.groups.find((group) => group.itemIds.includes(itemId))
			?.id;
	}

	async function mount(strict = false) {
		const tree = (
			<DesktopWorkbenchProvider
				makeId={(prefix) => prefix}
				persistenceDelayMs={60_000}
				storage={localStorage}
			>
				<Probe />
			</DesktopWorkbenchProvider>
		);
		await act(async () =>
			root.render(strict ? <StrictMode>{tree}</StrictMode> : tree)
		);
	}

	async function splitCenter() {
		await act(async () =>
			value().dispatch({
				type: "center/split",
				direction: "right",
				newGroupId: SECOND_CENTER,
				targetGroupId: MAIN_CENTER,
			})
		);
		// Splitting must not move focus, or the focus-change cases prove nothing.
		if (value().state.focusedGroupId !== MAIN_CENTER) {
			throw new Error("center/split moved focus away from the main group");
		}
	}

	beforeEach(() => {
		localStorage.clear();
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		latest = undefined;
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
	});

	test("openItem and moveItem keep their identity across state changes", async () => {
		await mount();
		const { moveItem, openItem } = value();

		await splitCenter();
		await act(async () => {
			value().openItem(ROUTE_ITEM, { region: "center" });
		});
		await act(async () =>
			value().dispatch({ type: "group/focus", groupId: SECOND_CENTER })
		);
		await act(async () => value().moveItem(ROUTE_ITEM.id, { region: "right" }));

		expect(value().openItem).toBe(openItem);
		expect(value().moveItem).toBe(moveItem);
	});

	test("a captured openItem targets the Center group focused after it was captured", async () => {
		await mount();
		const captured = value().openItem;

		await splitCenter();
		await act(async () =>
			value().dispatch({ type: "group/focus", groupId: SECOND_CENTER })
		);
		await act(async () => {
			captured(ROUTE_ITEM, { region: "center" });
		});

		expect(groupOf(ROUTE_ITEM.id)).toBe(SECOND_CENTER);
	});

	test("openItem in the same handler as a focus change targets the newly focused group", async () => {
		await mount();
		await splitCenter();

		await act(async () => {
			const current = value();
			current.dispatch({ type: "group/focus", groupId: SECOND_CENTER });
			current.openItem(ROUTE_ITEM, { region: "center" });
		});

		expect(groupOf(ROUTE_ITEM.id)).toBe(SECOND_CENTER);
		expect(value().state.focusedGroupId).toBe(SECOND_CENTER);
	});

	test("a captured moveItem moves an item that was opened after it was captured", async () => {
		await mount();
		const captured = value().moveItem;

		await act(async () => {
			value().openItem(ROUTE_ITEM, { region: "center" });
		});
		await act(async () => captured(ROUTE_ITEM.id, { region: "right" }));

		expect(
			value().state.groups.find((group) => group.region === "right")?.itemIds
		).toEqual([ROUTE_ITEM.id]);
	});

	test("moveItem activate:false keeps the target group's active item", async () => {
		await mount();
		const other: WorkbenchItem = {
			...ROUTE_ITEM,
			id: "other-item",
			source: { kind: "route", path: "/other" },
		};
		await act(async () => {
			value().openItem(ROUTE_ITEM, { region: "right" });
			value().openItem(other, { region: "center" });
		});
		await act(async () =>
			value().moveItem(other.id, { activate: false, index: 0, region: "right" })
		);

		const right = value().state.groups.find(
			(group) => group.region === "right"
		);
		expect(right?.itemIds).toEqual([other.id, ROUTE_ITEM.id]);
		expect(right?.activeItemId).toBe(ROUTE_ITEM.id);
	});

	test("an action without a target leaves the Workbench state untouched", async () => {
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
		localStorage.setItem(
			WORKBENCH_STORAGE_KEY,
			JSON.stringify(serializeWorkbenchSnapshot(persisted))
		);
		await mount();
		const before = value().state;

		let returnedId = "";
		await act(async () => {
			returnedId = value().openItem(ROUTE_ITEM, { region: "center" });
			value().moveItem("missing-item", { region: "right" });
		});

		expect(returnedId).toBe(ROUTE_ITEM.id);
		expect(value().state).toBe(before);
		expect(value().state.items.some((item) => item.id === ROUTE_ITEM.id)).toBe(
			false
		);
	});

	test("StrictMode opens an item once and persists the same snapshot shape", async () => {
		await mount(true);
		await act(async () => {
			value().openItem(ROUTE_ITEM, { region: "center" });
		});

		const center = value().state.groups.find(
			(group) => group.id === MAIN_CENTER
		);
		expect(center?.itemIds).toEqual([ROUTE_ITEM.id]);
		expect(center?.activeItemId).toBe(ROUTE_ITEM.id);
		expect(
			value().state.items.filter((item) => item.id === ROUTE_ITEM.id)
		).toHaveLength(1);

		await act(async () => {
			window.dispatchEvent(new Event("pagehide"));
		});
		const parsed = parseWorkbenchSnapshot(
			JSON.parse(localStorage.getItem(WORKBENCH_STORAGE_KEY) ?? "null"),
			{
				bottomGroupId: "workbench-bottom",
				centerGroupId: MAIN_CENTER,
				leftGroupId: "workbench-left",
				navigationId: "workbench-navigation",
				rightGroupId: "workbench-right",
				makeItemId: () => "workbench-item",
			}
		);
		expect(
			parsed?.groups.find((group) => group.id === MAIN_CENTER)?.itemIds
		).toEqual([ROUTE_ITEM.id]);
		expect(parsed?.items.find((item) => item.id === ROUTE_ITEM.id)).toEqual(
			ROUTE_ITEM
		);
	});
});
