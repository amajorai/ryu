import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
// The product-mode store reads this when its module loads, and the OS surface
// also needs its rollout flag; with both, every route renders instead of the
// Ryu Bot surface notice.
localStorage.setItem("ryu:product-mode", "os");
const { useProductModeStore } = await import("@/src/lib/product-mode.ts");
useProductModeStore.getState().setOsAccess(true);

const { RouteOutlet } = await import("./RouteOutlet.tsx");
const { contributionRegistry } = await import("./registry.ts");
type Tab = import("@/src/contexts/TabsContext.tsx").Tab;

let pageRenders = 0;
let renderedTitle: string | undefined;
let closePage: (() => void) | undefined;

function OutletPage({ path, title }: { path: string; title?: string }) {
	pageRenders += 1;
	renderedTitle = title;
	return <p data-path={path}>{title}</p>;
}

contributionRegistry.registerRoute({
	kind: "exact",
	path: "/outlet-proof",
	render: (tab, { onClose }) => {
		closePage = onClose;
		return (
			<OutletPage
				path={tab.path}
				title={"title" in tab ? String(tab.title) : undefined}
			/>
		);
	},
});

describe("RouteOutlet", () => {
	let container: HTMLDivElement;
	let root: Root;
	let setTab: ((tab: Tab) => void) | undefined;
	let rerenderHost: (() => void) | undefined;
	const closes: string[] = [];

	function Host({ initial }: { initial: Tab }) {
		const [tab, updateTab] = useState(initial);
		const [tick, setTick] = useState(0);
		setTab = updateTab;
		rerenderHost = () => setTick((value) => value + 1);
		// A fresh onClose every render, like the inline arrow Layout passes.
		return (
			<RouteOutlet onClose={() => closes.push(`close-${tick}`)} tab={tab} />
		);
	}

	beforeEach(() => {
		pageRenders = 0;
		renderedTitle = undefined;
		closePage = undefined;
		closes.length = 0;
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
	});

	test("an outlet re-render with the same tab object does not render the page again", async () => {
		const tab: Tab = { id: "tab-1", path: "/outlet-proof", title: "First" };
		await act(async () => root.render(<Host initial={tab} />));
		expect(pageRenders).toBe(1);

		for (let index = 0; index < 5; index++) {
			await act(async () => rerenderHost?.());
		}

		expect(pageRenders).toBe(1);
		expect(container.textContent).toBe("First");
	});

	test("a new tab object renders the page with the changed field", async () => {
		const tab: Tab = { id: "tab-1", path: "/outlet-proof", title: "First" };
		await act(async () => root.render(<Host initial={tab} />));

		await act(async () => setTab?.({ ...tab, title: "Second" }));

		expect(pageRenders).toBe(2);
		expect(renderedTitle).toBe("Second");
		expect(container.textContent).toBe("Second");
	});

	test("the page's onClose calls the latest host callback without a page render", async () => {
		const tab: Tab = { id: "tab-1", path: "/outlet-proof", title: "First" };
		await act(async () => root.render(<Host initial={tab} />));
		await act(async () => rerenderHost?.());
		await act(async () => rerenderHost?.());

		closePage?.();

		expect(pageRenders).toBe(1);
		expect(closes).toEqual(["close-2"]);
	});

	test("an unknown path renders nothing", async () => {
		await act(async () =>
			root.render(
				<RouteOutlet
					onClose={() => undefined}
					tab={{ id: "tab-x", path: "/outlet-proof-missing", title: "Gone" }}
				/>
			)
		);
		expect(container.innerHTML).toBe("");
		expect(pageRenders).toBe(0);
	});
});
