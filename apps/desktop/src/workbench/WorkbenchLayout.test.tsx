import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	createDefaultWorkbench,
	type WorkbenchItem,
} from "@ryu/workbench/model";
import { serializeWorkbenchSnapshot } from "@ryu/workbench/persistence";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	DesktopWorkbenchProvider,
	type DesktopWorkbenchValue,
	useDesktopWorkbench,
} from "./DesktopWorkbenchContext.tsx";
import { WORKBENCH_STORAGE_KEY } from "./desktop-workbench-persistence.ts";
import type { WorkbenchSlotsValue } from "./workbench-slots.tsx";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

/* SAFETY: React act reads the documented IS_REACT_ACT_ENVIRONMENT boolean global in this DOM test environment; this statement publishes that single native flag and does not claim a replacement global object. */ (
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const {
	CompatibilityWorkbenchFrame,
	WorkbenchLayout,
	workbenchCenterHasRouteItems,
} = await import("./WorkbenchLayout.tsx");
const { WorkbenchSlotProvider, useWorkbenchSlots } = await import(
	"./workbench-slots.tsx"
);
const { WorkbenchTabStrip } = await import("./WorkbenchTabStrip.tsx");
const { WorkbenchChromeProvider } = await import("./workbench-chrome.tsx");

function dragEvent(type: string, clientX = 0) {
	const event = new MouseEvent(type, {
		bubbles: true,
		cancelable: true,
		clientX,
	});
	Object.defineProperty(event, "dataTransfer", {
		value: {
			dropEffect: "none",
			effectAllowed: "all",
			setData: () => undefined,
		},
	});
	return event;
}

const IDS = {
	bottomGroupId: "bottom-main",
	centerGroupId: "center-main",
	leftGroupId: "left-main",
	navigationId: "navigation",
	rightGroupId: "right-main",
};

function item(
	id: string,
	title: string,
	preferredRegion: WorkbenchItem["preferredRegion"]
): WorkbenchItem {
	return {
		closable: true,
		duplicable: false,
		id,
		pinned: false,
		preferredRegion,
		scope: { kind: "window" },
		source: { kind: "shell", panel: id },
		title,
	};
}

function visibleFourRegionState() {
	const state = createDefaultWorkbench(IDS);
	const items = [
		...state.items,
		item("center-item", "Chat", "center"),
		item("right-item", "Files", "right"),
		item("bottom-item", "Terminal", "bottom"),
	];
	return {
		...state,
		items,
		openRegions: { bottom: true, center: true, left: true, right: true },
		groups: state.groups.map((group) => {
			const activeItemId =
				group.region === "center"
					? "center-item"
					: group.region === "right"
						? "right-item"
						: group.region === "bottom"
							? "bottom-item"
							: group.activeItemId;
			return activeItemId
				? { ...group, activeItemId, itemIds: [activeItemId] }
				: group;
		}),
	};
}

describe("WorkbenchLayout", () => {
	let container: HTMLDivElement;
	let root: Root;
	let workbench: DesktopWorkbenchValue | undefined;

	function StateProbe() {
		workbench = useDesktopWorkbench();
		return (
			<output data-testid="sizes">
				{JSON.stringify(workbench.state.sizes)}
			</output>
		);
	}

	beforeEach(() => {
		localStorage.clear();
		localStorage.setItem(
			WORKBENCH_STORAGE_KEY,
			JSON.stringify(serializeWorkbenchSnapshot(visibleFourRegionState()))
		);
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		workbench = undefined;
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
	});

	async function renderLayout({
		centerOverlay,
		onCloseItem,
		suppressLeftRegion = false,
	}: {
		centerOverlay?: ReactNode;
		onCloseItem?: (item: WorkbenchItem) => void;
		suppressLeftRegion?: boolean;
	} = {}) {
		await act(async () => {
			root.render(
				<DesktopWorkbenchProvider
					makeId={(prefix) => prefix}
					persistenceDelayMs={60_000}
					storage={localStorage}
				>
					<WorkbenchSlotProvider>
						<WorkbenchLayout
							centerContent={<div data-testid="route-canvas">Current page</div>}
							centerOverlay={centerOverlay}
							onCloseItem={onCloseItem}
							suppressLeftRegion={suppressLeftRegion}
						/>
						<StateProbe />
					</WorkbenchSlotProvider>
				</DesktopWorkbenchProvider>
			);
		});
	}

	test("renders four labeled regions, semantic group strips, and accessible resize boundaries", async () => {
		await renderLayout();

		for (const label of ["Left", "Center", "Right", "Bottom"]) {
			expect(
				container.querySelector(`section[aria-label="${label}"]`)
			).not.toBeNull();
			expect(
				container.querySelector(`[role="tablist"][aria-label="${label} tabs"]`)
			).not.toBeNull();
		}
		const resizeLeft = container.querySelector(
			'[role="separator"][aria-label="Resize Left"]'
		);
		expect(resizeLeft?.getAttribute("aria-orientation")).toBe("vertical");
		expect(resizeLeft?.getAttribute("aria-valuemin")).toBe("220");
		expect(resizeLeft?.getAttribute("aria-valuemax")).toBe("520");
		const resizeRight = container.querySelector(
			'[role="separator"][aria-label="Resize Right"]'
		);
		expect(resizeRight?.getAttribute("aria-valuemin")).toBe("260");
		expect(resizeRight?.getAttribute("aria-valuemax")).toBe("720");
		const resizeBottom = container.querySelector(
			'[role="separator"][aria-label="Resize Bottom"]'
		);
		expect(resizeBottom?.getAttribute("aria-valuemin")).toBe("160");
		expect(resizeBottom?.getAttribute("aria-valuemax")).toBe("640");
		expect(
			container
				.querySelector('[role="separator"][aria-label="Resize Bottom"]')
				?.getAttribute("aria-orientation")
		).toBe("horizontal");
		expect(
			container
				.querySelector('[data-region="center"]')
				?.getAttribute("data-focused")
		).toBe("true");
		expect(
			container.querySelector('[role="tab"][aria-selected="true"]')
		).not.toBeNull();
	});

	test("hosts the legacy TitleBar inside Center without covering side controls", async () => {
		await renderLayout({
			centerOverlay: <div data-testid="legacy-titlebar">Legacy titlebar</div>,
		});
		const center = container.querySelector('section[aria-label="Center"]');
		const left = container.querySelector('section[aria-label="Left"]');
		const titlebar = container.querySelector('[data-testid="legacy-titlebar"]');

		expect(
			center?.querySelector("[data-workbench-center-overlay]")
		).not.toBeNull();
		expect(center?.contains(titlebar)).toBe(true);
		expect(left?.contains(titlebar)).toBe(false);
	});

	test("keeps the Center-only TitleBar mounted while a Right group has focus", async () => {
		const state = visibleFourRegionState();
		state.focusedGroupId = "right-main";
		localStorage.setItem(
			WORKBENCH_STORAGE_KEY,
			JSON.stringify(serializeWorkbenchSnapshot(state))
		);
		await renderLayout({
			centerOverlay: <div data-testid="center-titlebar">Center tabs</div>,
		});

		const center = container.querySelector('section[aria-label="Center"]');
		expect(
			center?.querySelector('[data-testid="center-titlebar"]')
		).not.toBeNull();
		expect(
			container
				.querySelector('[data-region="right"]')
				?.getAttribute("data-focused")
		).toBe("true");
	});

	test("exposes accessible Center gutters with keyboard resize and blur cleanup", async () => {
		const state = visibleFourRegionState();
		state.groups.push({
			activeItemId: "secondary-item",
			id: "center-secondary",
			itemIds: ["secondary-item"],
			locked: false,
			region: "center",
		});
		state.items.push(item("secondary-item", "Secondary", "center"));
		state.centerTree = {
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
			JSON.stringify(serializeWorkbenchSnapshot(state))
		);
		await renderLayout();
		const gutter =
			/* SAFETY: The authored two-leaf Center branch fixture is rendered before this query; DesktopCenterSplitView in SplitView.tsx publishes this exact aria-label on a native button. */ container.querySelector(
				'[aria-label="Resize Center split"]'
			) as HTMLButtonElement;

		expect(gutter.getAttribute("role")).toBe("separator");
		expect(gutter.getAttribute("aria-orientation")).toBe("vertical");
		expect(gutter.getAttribute("aria-valuemin")).toBe("12");
		expect(gutter.getAttribute("aria-valuemax")).toBe("88");
		expect(gutter.getAttribute("aria-valuenow")).toBe("50");
		document.body.style.cursor = "wait";
		document.body.style.userSelect = "text";
		await act(async () => {
			gutter.dispatchEvent(
				new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })
			);
		});
		const resizedTree = workbench?.state.centerTree;
		if (resizedTree?.type !== "branch") {
			throw new Error("Center split disappeared after keyboard resize");
		}
		expect(resizedTree.sizes[0]).toBeCloseTo(0.55);
		expect(resizedTree.sizes[1]).toBeCloseTo(0.45);

		await act(async () => {
			gutter.dispatchEvent(
				new PointerEvent("pointerdown", {
					pointerId: 7,
					clientX: 100,
					bubbles: true,
				})
			);
		});
		expect(document.body.style.userSelect).toBe("none");
		await act(async () =>
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
		);
		expect(document.body.style.userSelect).toBe("text");
		expect(document.body.style.cursor).toBe("wait");

		document.body.style.cursor = "crosshair";
		document.body.style.userSelect = "all";
		await act(async () => {
			gutter.dispatchEvent(
				new PointerEvent("pointerdown", {
					pointerId: 8,
					clientX: 100,
					bubbles: true,
				})
			);
		});
		await act(async () => window.dispatchEvent(new Event("blur")));
		expect(document.body.style.userSelect).toBe("all");
		expect(document.body.style.cursor).toBe("crosshair");

		document.body.style.cursor = "help";
		document.body.style.userSelect = "auto";
		await act(async () => {
			gutter.dispatchEvent(
				new PointerEvent("pointerdown", {
					pointerId: 9,
					clientX: 100,
					bubbles: true,
				})
			);
			root.unmount();
		});
		expect(document.body.style.userSelect).toBe("auto");
		expect(document.body.style.cursor).toBe("help");
		document.body.style.userSelect = "";
		document.body.style.cursor = "";
	});

	test("suppresses the compatibility Left track without mutating workbench state", async () => {
		await renderLayout({ suppressLeftRegion: true });
		const before = JSON.stringify(workbench?.state);
		const layout =
			/* SAFETY: After renderLayout, CompatibilityWorkbenchFrame publishes its native div with this exact current bottom-alignment attribute; the fixture starts at center alignment. */ container.querySelector(
				'[data-bottom-alignment="center"]'
			) as HTMLElement;

		expect(container.querySelector('section[aria-label="Left"]')).toBeNull();
		expect(container.querySelector('[aria-label="Resize Left"]')).toBeNull();
		// The grid tracks live in the owned stylesheet; the frame feeds them
		// through its custom property.
		expect(
			layout.style.getPropertyValue("--workbench-columns").startsWith("0px 0px")
		).toBe(true);
		expect(
			container.querySelector('section[aria-label="Center"]')
		).not.toBeNull();
		expect(JSON.stringify(workbench?.state)).toBe(before);
	});

	test("real Layout integration scopes TitleBar to Center and suppresses legacy Left", async () => {
		await act(async () => {
			root.render(
				<DesktopWorkbenchProvider
					makeId={(prefix) => prefix}
					persistenceDelayMs={60_000}
					storage={localStorage}
				>
					<CompatibilityWorkbenchFrame
						centerContent={<div data-testid="route-canvas">Current page</div>}
						centerOverlay={<div data-testid="legacy-titlebar">TitleBar</div>}
					/>
					<StateProbe />
				</DesktopWorkbenchProvider>
			);
		});
		const center = container.querySelector('section[aria-label="Center"]');
		const titlebar = container.querySelector('[data-testid="legacy-titlebar"]');
		const routeCanvas = container.querySelector('[data-testid="route-canvas"]');

		expect(center?.contains(titlebar)).toBe(true);
		expect(container.querySelector('section[aria-label="Left"]')).toBeNull();
		expect(
			center?.querySelector('[role="tablist"][aria-label="Center tabs"]')
		).toBeNull();
		expect(workbench?.state.openRegions.left).toBe(true);
		await act(async () => {
			workbench?.dispatch({ type: "bottom/align", alignment: "full" });
		});
		expect(container.querySelector('[data-testid="route-canvas"]')).toBe(
			routeCanvas
		);
	});

	test("draws the shell's glyph before each side tab title", async () => {
		await act(async () => {
			root.render(
				<DesktopWorkbenchProvider
					makeId={(prefix) => prefix}
					persistenceDelayMs={60_000}
					storage={localStorage}
				>
					<CompatibilityWorkbenchFrame
						centerContent={<div>Current page</div>}
						centerOverlay={null}
						renderItemIcon={(item) => (
							<svg data-icon-for={item.id}>
								<title>{item.title}</title>
							</svg>
						)}
					/>
					<StateProbe />
				</DesktopWorkbenchProvider>
			);
		});
		const rightTab = container.querySelector(
			'section[aria-label="Right"] [role="tab"]'
		);
		const icon = rightTab?.querySelector("[data-icon-for]");
		expect(icon).not.toBeNull();
		expect(icon?.parentElement?.getAttribute("aria-hidden")).toBe("true");
		expect(rightTab?.lastElementChild?.textContent).toBe("Files");
	});

	test("changes Bottom grid span without remounting the compatibility canvas", async () => {
		await renderLayout();
		const routeCanvas = container.querySelector('[data-testid="route-canvas"]');
		const bottom =
			/* SAFETY: visibleFourRegionState opens Bottom before renderLayout; WorkbenchRegion publishes the exact bottom data-region on its native section, which is an HTMLElement. */ container.querySelector(
				'[data-region="bottom"]'
			) as HTMLElement;
		// The owned stylesheet places the frame's direct Bottom child on the span
		// the frame publishes as a custom property.
		const layout = bottom.parentElement;
		expect(layout?.hasAttribute("data-bottom-alignment")).toBe(true);
		for (const [alignment, gridColumn] of [
			["center", "3 / 4"],
			["full", "1 / 6"],
			["left", "1 / 4"],
			["right", "3 / 6"],
		] as const) {
			await act(async () => {
				workbench?.dispatch({ type: "bottom/align", alignment });
			});
			expect(layout?.style.getPropertyValue("--workbench-bottom-column")).toBe(
				gridColumn
			);
			expect(container.querySelector('[data-testid="route-canvas"]')).toBe(
				routeCanvas
			);
		}
	});

	test("keeps live resize local until the pointer settles", async () => {
		await renderLayout();
		const layout =
			/* SAFETY: After renderLayout, CompatibilityWorkbenchFrame publishes its native div with this exact current bottom-alignment attribute; the fixture starts at center alignment. */ container.querySelector(
				'[data-bottom-alignment="center"]'
			) as HTMLElement;
		const resizeLeft =
			/* SAFETY: visibleFourRegionState opens this region before renderLayout; ResizeBoundary in WorkbenchLayout.tsx publishes this exact role and aria-label on a native div. */ container.querySelector(
				'[role="separator"][aria-label="Resize Left"]'
			) as HTMLElement;

		await act(async () => {
			resizeLeft.dispatchEvent(
				new PointerEvent("pointerdown", { bubbles: true, clientX: 100 })
			);
			window.dispatchEvent(new PointerEvent("pointermove", { clientX: 200 }));
		});
		expect(workbench?.state.sizes.left).toBe(288);
		expect(layout.style.getPropertyValue("--workbench-left-size")).toBe(
			"388px"
		);

		await act(async () => {
			window.dispatchEvent(new PointerEvent("pointerup", { clientX: 200 }));
		});
		expect(workbench?.state.sizes.left).toBe(388);
	});

	test("settles a captured resize on window blur and resumes state synchronization", async () => {
		await renderLayout();
		const layout =
			/* SAFETY: After renderLayout, CompatibilityWorkbenchFrame publishes its native div with this exact current bottom-alignment attribute; the fixture starts at center alignment. */ container.querySelector(
				'[data-bottom-alignment="center"]'
			) as HTMLElement;
		const resizeLeft =
			/* SAFETY: visibleFourRegionState opens this region before renderLayout; ResizeBoundary in WorkbenchLayout.tsx publishes this exact role and aria-label on a native div. */ container.querySelector(
				'[role="separator"][aria-label="Resize Left"]'
			) as HTMLElement;
		let capturedPointerId: number | undefined;
		Object.defineProperty(resizeLeft, "setPointerCapture", {
			configurable: true,
			value: (pointerId: number) => {
				capturedPointerId = pointerId;
			},
		});

		await act(async () => {
			resizeLeft.dispatchEvent(
				new PointerEvent("pointerdown", {
					bubbles: true,
					clientX: 100,
					pointerId: 7,
				})
			);
			window.dispatchEvent(new PointerEvent("pointermove", { clientX: 200 }));
		});
		expect(capturedPointerId).toBe(7);
		expect(workbench?.state.sizes.left).toBe(288);

		await act(async () => window.dispatchEvent(new Event("blur")));
		expect(workbench?.state.sizes.left).toBe(388);

		await act(async () => {
			workbench?.dispatch({ type: "region/resize", region: "left", size: 300 });
		});
		expect(layout.style.getPropertyValue("--workbench-left-size")).toBe(
			"300px"
		);
	});

	test("moves Bottom's separator in the keyboard arrow direction", async () => {
		await renderLayout();
		const resizeBottom =
			/* SAFETY: visibleFourRegionState opens this region before renderLayout; ResizeBoundary in WorkbenchLayout.tsx publishes this exact role and aria-label on a native div. */ container.querySelector(
				'[role="separator"][aria-label="Resize Bottom"]'
			) as HTMLElement;

		await act(async () => {
			resizeBottom.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" })
			);
		});
		expect(workbench?.state.sizes.bottom).toBe(290);

		await act(async () => {
			resizeBottom.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" })
			);
		});
		expect(workbench?.state.sizes.bottom).toBe(280);
	});

	test("closes an empty surrounding region while Center remains mounted", async () => {
		await renderLayout();
		await act(async () => {
			workbench?.dispatch({ type: "item/close", itemId: "right-item" });
		});

		expect(container.querySelector('section[aria-label="Right"]')).toBeNull();
		expect(
			container.querySelector('section[aria-label="Center"]')
		).not.toBeNull();
		expect(
			container.querySelector('[data-testid="route-canvas"]')
		).not.toBeNull();
	});

	test("keeps a usable empty Center when the last route moves to Right", async () => {
		const state = visibleFourRegionState();
		state.items = state.items.map((candidate) =>
			candidate.id === "center-item"
				? { ...candidate, source: { kind: "route", path: "/settings" } }
				: candidate
		);
		state.groups = state.groups.map((group) => {
			if (group.region === "center") {
				return { ...group, activeItemId: null, itemIds: [] };
			}
			if (group.region === "right") {
				return {
					...group,
					activeItemId: "center-item",
					itemIds: ["right-item", "center-item"],
				};
			}
			return group;
		});
		state.openRegions.right = true;
		localStorage.setItem(
			WORKBENCH_STORAGE_KEY,
			JSON.stringify(serializeWorkbenchSnapshot(state))
		);
		expect(workbenchCenterHasRouteItems(state)).toBe(false);
		await act(async () => {
			root.render(
				<DesktopWorkbenchProvider
					makeId={(prefix) => prefix}
					persistenceDelayMs={60_000}
					storage={localStorage}
				>
					<WorkbenchSlotProvider>
						<WorkbenchLayout
							centerContent={<button type="button">Open a Center view</button>}
						/>
					</WorkbenchSlotProvider>
				</DesktopWorkbenchProvider>
			);
		});

		const center = container.querySelector('section[aria-label="Center"]');
		expect(center?.textContent).toContain("Open a Center view");
		expect(
			container.querySelector('section[aria-label="Right"]')
		).not.toBeNull();
	});

	test("routes local strip close through the supplied lifecycle callback", async () => {
		const closed: string[] = [];
		const state = visibleFourRegionState();
		const group = state.groups.find(
			(candidate) => candidate.region === "center"
		);
		const centerItem = state.items.find(
			(candidate) => candidate.id === "center-item"
		);
		if (!(group && centerItem)) {
			throw new Error("Center fixture is incomplete");
		}
		const routeItem: WorkbenchItem = {
			...centerItem,
			source: { kind: "route", path: "/chat" },
		};
		await act(async () => {
			root.render(
				<DesktopWorkbenchProvider
					makeId={(prefix) => prefix}
					persistenceDelayMs={60_000}
					storage={localStorage}
				>
					<WorkbenchTabStrip
						focused
						group={group}
						items={[routeItem]}
						onCloseItem={(item) => closed.push(item.id)}
					/>
					<StateProbe />
				</DesktopWorkbenchProvider>
			);
		});
		const closeButton =
			/* SAFETY: This fixture renders the named closable item before the query; WorkbenchTabStrip supplies its exact Close label to shared Button with no render override, so the native target is a button. */ container.querySelector(
				'button[aria-label="Close Chat"]'
			) as HTMLButtonElement;
		await act(async () => closeButton.click());

		expect(closed).toEqual(["center-item"]);
		expect(
			workbench?.state.items.some((candidate) => candidate.id === "center-item")
		).toBe(true);
	});

	test("forwards additional Center group close through the route lifecycle seam", async () => {
		const closed: string[] = [];
		const state = visibleFourRegionState();
		state.items.push({
			...item("secondary-route", "Secondary route", "center"),
			source: { kind: "route", path: "/downloads" },
		});
		state.groups.push({
			activeItemId: "secondary-route",
			id: "center-secondary",
			itemIds: ["secondary-route"],
			locked: false,
			region: "center",
		});
		state.centerTree = {
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
			JSON.stringify(serializeWorkbenchSnapshot(state))
		);
		await renderLayout({
			onCloseItem: (closedItem) => closed.push(closedItem.id),
		});
		const closeButton =
			/* SAFETY: This fixture renders the named closable item before the query; WorkbenchTabStrip supplies its exact Close label to shared Button with no render override, so the native target is a button. */ container.querySelector(
				'button[aria-label="Close Secondary route"]'
			) as HTMLButtonElement;
		await act(async () => closeButton.click());

		expect(closed).toEqual(["secondary-route"]);
		expect(
			workbench?.state.items.some(
				(candidate) => candidate.id === "secondary-route"
			)
		).toBe(true);
	});

	test("runs Left and Right beside Bottom unless Bottom's alignment spans them", async () => {
		await renderLayout();
		const layout =
			/* SAFETY: After renderLayout, CompatibilityWorkbenchFrame publishes its native grid div with a data-bottom-alignment attribute. */ container.querySelector(
				"[data-bottom-alignment]"
			) as HTMLElement;
		// The side rows live in the owned stylesheet; the frame feeds them
		// through custom properties that its Left/Right sections read.
		const regionRow = (name: "left" | "right") =>
			layout.style.getPropertyValue(`--workbench-${name}-row`);
		const expectations = [
			["center", "1 / 4", "1 / 4"],
			["full", "1 / 2", "1 / 2"],
			["left", "1 / 2", "1 / 4"],
			["right", "1 / 4", "1 / 2"],
		] as const;
		for (const [alignment, leftRow, rightRow] of expectations) {
			await act(async () => {
				workbench?.dispatch({ type: "bottom/align", alignment });
			});
			expect(container.querySelector('[data-region="left"]')).not.toBeNull();
			expect(container.querySelector('[data-region="right"]')).not.toBeNull();
			expect(regionRow("left")).toBe(leftRow);
			expect(regionRow("right")).toBe(rightRow);
		}
	});

	test("navigates strip tabs with arrow keys and closes a tab with middle click", async () => {
		const state = visibleFourRegionState();
		state.items = [...state.items, item("logs", "Logs", "bottom")];
		state.groups = state.groups.map((group) =>
			group.region === "bottom"
				? { ...group, itemIds: ["bottom-item", "logs"] }
				: group
		);
		localStorage.setItem(
			WORKBENCH_STORAGE_KEY,
			JSON.stringify(serializeWorkbenchSnapshot(state))
		);
		await renderLayout();
		const bottomTabs = () =>
			Array.from(
				container.querySelectorAll<HTMLButtonElement>(
					'[role="tablist"][aria-label="Bottom tabs"] [role="tab"]'
				)
			);
		expect(bottomTabs().map((tab) => tab.tabIndex)).toEqual([0, -1]);

		await act(async () => {
			bottomTabs()[0]?.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })
			);
		});
		const bottomGroup = () =>
			workbench?.state.groups.find((group) => group.region === "bottom");
		expect(bottomGroup()?.activeItemId).toBe("logs");
		expect(bottomTabs().map((tab) => tab.tabIndex)).toEqual([-1, 0]);
		expect(document.activeElement).toBe(bottomTabs()[1]);

		await act(async () => {
			bottomTabs()[1]?.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "Home" })
			);
		});
		expect(bottomGroup()?.activeItemId).toBe("bottom-item");

		await act(async () => {
			bottomTabs()[1]?.dispatchEvent(
				new MouseEvent("auxclick", { bubbles: true, button: 1 })
			);
		});
		expect(bottomGroup()?.itemIds).toEqual(["bottom-item"]);
	});

	test("an emptied Center split pane offers Add a view and Close pane", async () => {
		await renderLayout();
		await act(async () => {
			workbench?.dispatch({
				type: "center/split",
				direction: "right",
				newGroupId: "center-2",
				targetGroupId: "center-main",
			});
		});
		const emptyPane = container.querySelector('[data-group-id="center-2"]');
		const buttons = Array.from(
			emptyPane?.querySelectorAll<HTMLButtonElement>("button") ?? []
		);
		expect(buttons.some((button) => button.textContent === "Add a view")).toBe(
			true
		);
		const closePane = buttons.find(
			(button) => button.textContent === "Close pane"
		);
		await act(async () => closePane?.click());
		expect(
			workbench?.state.groups.some((group) => group.id === "center-2")
		).toBe(false);
		expect(workbench?.state.centerTree).toEqual({
			type: "leaf",
			groupId: "center-main",
		});
	});

	async function renderDraggingLayout(draggingId: string, ended: string[]) {
		await act(async () => {
			root.render(
				<DesktopWorkbenchProvider
					makeId={(prefix) => prefix}
					persistenceDelayMs={60_000}
					storage={localStorage}
				>
					<WorkbenchChromeProvider
						drag={{
							draggingId,
							end: () => ended.push(draggingId),
							start: () => undefined,
						}}
					>
						<WorkbenchSlotProvider>
							<WorkbenchLayout centerContent={<div>Current page</div>} />
							<StateProbe />
						</WorkbenchSlotProvider>
					</WorkbenchChromeProvider>
				</DesktopWorkbenchProvider>
			);
		});
	}

	test("drops a dragged tab onto another region's strip at the hovered position", async () => {
		const ended: string[] = [];
		await renderDraggingLayout("right-item", ended);
		const bottomTab =
			/* SAFETY: visibleFourRegionState opens Bottom with bottom-item; WorkbenchTabStrip publishes this data attribute on each tab's native element. */ container.querySelector(
				'[data-workbench-tab="bottom-item"]'
			) as HTMLElement;
		await act(async () => {
			bottomTab.dispatchEvent(dragEvent("dragover", -1));
			bottomTab.dispatchEvent(dragEvent("drop", -1));
		});
		const bottom = workbench?.state.groups.find(
			(group) => group.region === "bottom"
		);
		expect(bottom?.itemIds).toEqual(["right-item", "bottom-item"]);
		expect(bottom?.activeItemId).toBe("right-item");
		expect(ended).toEqual(["right-item"]);
	});

	test("offers an edge target for a hidden region and moves the dragged tab there", async () => {
		const state = visibleFourRegionState();
		state.openRegions.right = false;
		localStorage.setItem(
			WORKBENCH_STORAGE_KEY,
			JSON.stringify(serializeWorkbenchSnapshot(state))
		);
		const ended: string[] = [];
		await renderDraggingLayout("bottom-item", ended);
		const edge = container.querySelector('[data-workbench-edge-drop="right"]');
		expect(
			container.querySelector('[data-workbench-edge-drop="bottom"]')
		).toBeNull();
		await act(async () => {
			edge?.dispatchEvent(dragEvent("dragover"));
			edge?.dispatchEvent(dragEvent("drop"));
		});
		expect(workbench?.state.openRegions.right).toBe(true);
		expect(
			workbench?.state.groups.find((group) => group.region === "right")?.itemIds
		).toEqual(["right-item", "bottom-item"]);
	});

	test("drops onto a side region's body to append the tab", async () => {
		const ended: string[] = [];
		await renderDraggingLayout("center-item", ended);
		const body = container.querySelector(
			'[data-workbench-drop-target="right"]'
		);
		await act(async () => {
			body?.dispatchEvent(dragEvent("dragover"));
			body?.dispatchEvent(dragEvent("drop"));
		});
		expect(
			workbench?.state.groups.find((group) => group.region === "right")?.itemIds
		).toEqual(["right-item", "center-item"]);
	});

	test("closes other tabs from a tab's context menu", async () => {
		const state = visibleFourRegionState();
		state.items = [
			...state.items,
			item("logs", "Logs", "bottom"),
			item("problems", "Problems", "bottom"),
		];
		state.groups = state.groups.map((group) =>
			group.region === "bottom"
				? { ...group, itemIds: ["bottom-item", "logs", "problems"] }
				: group
		);
		localStorage.setItem(
			WORKBENCH_STORAGE_KEY,
			JSON.stringify(serializeWorkbenchSnapshot(state))
		);
		await renderLayout();
		const logsTab = container.querySelector('[data-workbench-tab="logs"]');
		await act(async () => {
			logsTab?.dispatchEvent(
				new MouseEvent("contextmenu", { bubbles: true, cancelable: true })
			);
		});
		const closeOthers = Array.from(
			document.querySelectorAll<HTMLElement>('[role="menuitem"]')
		).find((element) => element.textContent === "Close Others");
		expect(closeOthers).toBeDefined();
		await act(async () => closeOthers?.click());
		expect(
			workbench?.state.groups.find((group) => group.region === "bottom")
				?.itemIds
		).toEqual(["logs"]);
	});

	test("shows side regions as one overlay at a time in a narrow window without changing the saved layout", async () => {
		const originalResizeObserver = globalThis.ResizeObserver;
		// happy-dom has no layout: report a 600px-wide workbench, too narrow to
		// dock Left (288) and Right (360) beside a usable Center.
		globalThis.ResizeObserver = class {
			private readonly callback: ResizeObserverCallback;
			constructor(callback: ResizeObserverCallback) {
				this.callback = callback;
			}
			observe() {
				/* SAFETY: the layout reads only contentRect.width from the first entry; this fixture supplies exactly that field. */
				this.callback(
					[{ contentRect: { width: 600 } } as ResizeObserverEntry],
					this as unknown as ResizeObserver
				);
			}
			unobserve() {
				return undefined;
			}
			disconnect() {
				return undefined;
			}
		} as unknown as typeof ResizeObserver;
		try {
			await renderLayout();
			const layout = container.querySelector("[data-bottom-alignment]");
			expect(layout?.getAttribute("data-narrow")).toBe("true");
			expect(container.querySelector('section[aria-label="Right"]')).toBeNull();
			expect(
				container.querySelector('[role="separator"][aria-label="Resize Right"]')
			).toBeNull();

			await act(async () => {
				workbench?.dispatch({ type: "item/activate", itemId: "right-item" });
			});
			const right =
				/* SAFETY: activating right-item focuses Right, which the narrow layout renders as its one overlay section. */ container.querySelector(
					'section[aria-label="Right"]'
				) as HTMLElement;
			// The overlay sheet follows its scrim; its absolute geometry lives in
			// the owned stylesheet rather than an inline style.
			expect(
				right.previousElementSibling?.hasAttribute(
					"data-workbench-overlay-scrim"
				)
			).toBe(true);
			expect(
				container.querySelector('section[aria-label="Bottom"]')
			).toBeNull();

			const scrim =
				/* SAFETY: the overlay always renders this native scrim button beside its sheet. */ container.querySelector(
					"[data-workbench-overlay-scrim]"
				) as HTMLButtonElement;
			await act(async () => scrim.click());
			expect(container.querySelector('section[aria-label="Right"]')).toBeNull();
			expect(workbench?.state.focusedGroupId).toBe("center-main");
			expect(workbench?.state.openRegions).toMatchObject({
				bottom: true,
				right: true,
			});
			expect(workbench?.state.sizes).toEqual({
				bottom: 280,
				left: 288,
				right: 360,
			});

			await act(async () => {
				workbench?.dispatch({
					type: "center/split",
					direction: "right",
					newGroupId: "center-2",
					targetGroupId: "center-main",
				});
			});
			const centerPanes = container.querySelectorAll(
				'section[aria-label="Center"] > [data-group-id]'
			);
			expect(centerPanes).toHaveLength(1);
			expect(workbench?.state.centerTree.type).toBe("branch");
		} finally {
			globalThis.ResizeObserver = originalResizeObserver;
		}
	});

	test("offers Move to Left only for Navigation while Left holds navigation", async () => {
		const state = visibleFourRegionState();
		state.groups = state.groups.map((group) => {
			if (group.region === "left") {
				return { ...group, activeItemId: null, itemIds: [] };
			}
			if (group.region === "right") {
				return {
					...group,
					activeItemId: "navigation",
					itemIds: ["navigation", "right-item"],
				};
			}
			return group;
		});
		localStorage.setItem(
			WORKBENCH_STORAGE_KEY,
			JSON.stringify(serializeWorkbenchSnapshot(state))
		);
		await act(async () => {
			root.render(
				<DesktopWorkbenchProvider
					makeId={(prefix) => prefix}
					persistenceDelayMs={60_000}
					storage={localStorage}
				>
					<WorkbenchChromeProvider leftAvailable={false}>
						<WorkbenchSlotProvider>
							<WorkbenchLayout
								centerContent={<div>Current page</div>}
								suppressLeftRegion
							/>
							<StateProbe />
						</WorkbenchSlotProvider>
					</WorkbenchChromeProvider>
				</DesktopWorkbenchProvider>
			);
		});
		const menuLabels = async (itemId: string) => {
			await act(async () => {
				container
					.querySelector(`[data-workbench-tab="${itemId}"]`)
					?.dispatchEvent(
						new MouseEvent("contextmenu", { bubbles: true, cancelable: true })
					);
			});
			const labels = Array.from(
				document.querySelectorAll<HTMLElement>('[role="menuitem"]')
			).map((element) => element.textContent ?? "");
			await act(async () => {
				document.dispatchEvent(
					new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
				);
			});
			return labels;
		};
		expect(await menuLabels("right-item")).not.toContain("Move to Left");
		const navigationLabels = await menuLabels("navigation");
		expect(navigationLabels).toContain("Move to Left");
		expect(navigationLabels).toContain("Move to Center");
	});

	test("restores the specified region defaults on separator double click", async () => {
		await renderLayout();
		await act(async () => {
			workbench?.dispatch({ type: "region/resize", region: "left", size: 420 });
		});

		const resizeLeft =
			/* SAFETY: visibleFourRegionState opens this region before renderLayout; ResizeBoundary in WorkbenchLayout.tsx publishes this exact role and aria-label on a native div. */ container.querySelector(
				'[role="separator"][aria-label="Resize Left"]'
			) as HTMLElement;
		await act(async () =>
			resizeLeft.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
		);

		expect(workbench?.state.sizes.left).toBe(288);
	});
});

describe("WorkbenchSlotProvider", () => {
	let container: HTMLDivElement;
	let root: Root;
	let slots: WorkbenchSlotsValue | undefined;

	function SlotsProbe() {
		slots = useWorkbenchSlots();
		return null;
	}

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		slots = undefined;
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
	});

	test("keeps the latest slot and ignores stale unregistration", async () => {
		await act(async () => {
			root.render(
				<WorkbenchSlotProvider>
					<SlotsProbe />
				</WorkbenchSlotProvider>
			);
		});
		const first = document.createElement("div");
		const latest = document.createElement("div");

		await act(async () => {
			slots?.registerSlot("center-main", "chat", first);
			slots?.registerSlot("center-main", "chat", latest);
		});
		expect(slots?.getSlot("center-main", "chat")).toBe(latest);

		await act(async () => slots?.unregisterSlot("center-main", "chat", first));
		expect(slots?.getSlot("center-main", "chat")).toBe(latest);

		await act(async () => slots?.unregisterSlot("center-main", "chat", latest));
		expect(slots?.getSlot("center-main", "chat")).toBeNull();
	});
});
