import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DesktopWorkbenchProvider } from "@/src/workbench/DesktopWorkbenchContext.tsx";

mock.module("@/src/contexts/entitlement-context.tsx", () => ({
	useEntitlementContext: () => ({
		canUse: () => true,
		ready: true,
		refresh: async () => undefined,
		requestUpgrade: () => undefined,
		verdict: null,
	}),
}));

const { TabsProvider, useTabsContext } = await import(
	"@/src/contexts/TabsContext.tsx"
);
const { TabDndProvider, useTabDragProps } = await import("./tabDnd.tsx");
type TabsValue = ReturnType<typeof useTabsContext>;

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const TAB_WIDTH = 100;

function Chip({ id }: { id: string }) {
	const { dragHandlers } = useTabDragProps(id, "x");
	return <div data-chip={id} {...dragHandlers} />;
}

let tabs: TabsValue | undefined;

function Strip() {
	tabs = useTabsContext();
	return (
		<div style={{ direction: "rtl" }}>
			{tabs.tabs.map((tab) => (
				<Chip id={tab.id} key={tab.id} />
			))}
		</div>
	);
}

function currentTabs(): TabsValue {
	if (!tabs) {
		throw new Error("Tabs probe did not mount");
	}
	return tabs;
}

/** Lays the chips out right to left: the first tab is drawn rightmost. */
function layOutRightToLeft(ids: readonly string[]) {
	const right = ids.length * TAB_WIDTH;
	for (const [index, id] of ids.entries()) {
		const chip = document.querySelector<HTMLElement>(`[data-chip="${id}"]`);
		if (!chip) {
			throw new Error(`chip ${id} did not render`);
		}
		const left = right - (index + 1) * TAB_WIDTH;
		chip.getBoundingClientRect = () =>
			new DOMRect(left, 0, TAB_WIDTH, 30) as DOMRect;
	}
}

function dragEvent(type: string, clientX: number): Event {
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

async function dispatch(id: string, type: string, clientX = 0) {
	const chip = document.querySelector<HTMLElement>(`[data-chip="${id}"]`);
	await act(async () => {
		chip?.dispatchEvent(dragEvent(type, clientX));
	});
}

describe("title-bar tab drag under RTL", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		localStorage.clear();
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		tabs = undefined;
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
	});

	async function openThreeTabs(): Promise<string[]> {
		await act(async () => {
			root.render(
				<DesktopWorkbenchProvider
					makeId={(prefix) => prefix}
					persistenceDelayMs={60_000}
					storage={localStorage}
				>
					<TabsProvider>
						<TabDndProvider>
							<Strip />
						</TabDndProvider>
					</TabsProvider>
				</DesktopWorkbenchProvider>
			);
		});
		const ids: string[] = [];
		for (const path of ["/settings", "/downloads", "/calendar"]) {
			await act(async () => ids.push(currentTabs().openTab(path)));
		}
		const order = currentTabs().tabs.map((tab) => tab.id);
		layOutRightToLeft(order);
		return order;
	}

	async function dropOn(dragged: string, target: string, clientX: number) {
		await dispatch(dragged, "dragstart");
		await dispatch(target, "dragover", clientX);
		await dispatch(target, "drop", clientX);
		await dispatch(dragged, "dragend");
	}

	test("dropping on a tab's left half lands the tab to its left", async () => {
		const order = await openThreeTabs();
		const [first, , last] = order.slice(-3);
		if (!(first && last)) {
			throw new Error("three tabs did not open");
		}
		const lastIndex = order.indexOf(last);
		// The last tab is drawn leftmost; its left half is logically after it.
		const leftHalf = (order.length - 1 - lastIndex) * TAB_WIDTH + 10;
		await dropOn(first, last, leftHalf);
		const after = currentTabs().tabs.map((tab) => tab.id);
		expect(after.indexOf(first)).toBe(after.indexOf(last) + 1);
	});

	test("dropping on a tab's right half lands the tab to its right", async () => {
		const order = await openThreeTabs();
		const [first, , last] = order.slice(-3);
		if (!(first && last)) {
			throw new Error("three tabs did not open");
		}
		const lastIndex = order.indexOf(last);
		const rightHalf = (order.length - 1 - lastIndex) * TAB_WIDTH + 90;
		await dropOn(first, last, rightHalf);
		const after = currentTabs().tabs.map((tab) => tab.id);
		expect(after.indexOf(first)).toBe(after.indexOf(last) - 1);
	});
});
