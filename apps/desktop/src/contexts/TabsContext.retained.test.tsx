import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
// RouteOutlet reads the product mode when its module loads, and the OS surface
// also needs its rollout flag; with both, every route renders instead of the
// Ryu Bot surface notice.
localStorage.setItem("ryu:product-mode", "os");
const { useProductModeStore } = await import("@/src/lib/product-mode.ts");
useProductModeStore.getState().setOsAccess(true);
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

const {
	CurrentTabIdProvider,
	IsActiveTabProvider,
	subscribeTabOpenRequests,
	TabsProvider,
	useCurrentTabId,
	useIsActiveTab,
	useTabSelector,
	useTabsContext,
} = await import("./TabsContext.tsx");
const { TitleBarProvider, useTitleBar } = await import("./TitleBarContext.tsx");
const { RouteOutlet } = await import("@/src/contributions/RouteOutlet.tsx");
const { contributionRegistry } = await import(
	"@/src/contributions/registry.ts"
);
const { DesktopWorkbenchProvider, useDesktopWorkbench } = await import(
	"@/src/workbench/DesktopWorkbenchContext.tsx"
);
const { WORKBENCH_STORAGE_KEY } = await import(
	"@/src/workbench/desktop-workbench-persistence.ts"
);

type Tab = import("./TabsContext.tsx").Tab;
type TabsValue = ReturnType<typeof useTabsContext>;
type WorkbenchValue = ReturnType<typeof useDesktopWorkbench>;
type RouteTab = Parameters<
	Parameters<typeof contributionRegistry.registerRoute>[0]["render"]
>[0];

const TAB_NAMES = ["a", "b", "c", "d"] as const;
// Tab ids come from the Workbench migration of the seeded session; `mount`
// records them in seeded order.
const ids: Record<(typeof TAB_NAMES)[number], string> = {
	a: "",
	b: "",
	c: "",
	d: "",
};
const renders = new Map<string, number>();
const routeTabs = new Map<string, RouteTab>();
const openTabIdentities = new Set<TabsValue["openTab"]>();
// Every distinct Workbench state a consumer rendered, and how often one
// rendered: each dispatch that changes the layout adds a state and a render.
const workbenchStates = new Set<WorkbenchValue["state"]>();
let workbenchRenders = 0;
let latest: TabsValue | undefined;
let workbench: WorkbenchValue | undefined;

function RetainedPage({ routeTab }: { routeTab: RouteTab }) {
	const id = useCurrentTabId() ?? "";
	const active = useIsActiveTab();
	// The same hooks a retained ChatPage uses: a title-bar title and the
	// tab-open action.
	useTitleBar(`Page ${id}`);
	const openTab = useTabSelector((state) => state.openTab);
	openTabIdentities.add(openTab);
	renders.set(id, (renders.get(id) ?? 0) + 1);
	routeTabs.set(id, routeTab);
	return (
		<article data-active={active} data-page={id}>
			<h1>{routeTab.path}</h1>
		</article>
	);
}

contributionRegistry.registerRoute({
	kind: "pattern",
	test: { startsWith: "/retained/" },
	render: (routeTab) => <RetainedPage routeTab={routeTab} />,
});

function Shell() {
	const value = useTabsContext();
	latest = value;
	return value.tabs.map((tab) => (
		<IsActiveTabProvider
			isActive={tab.id === value.activeTabId}
			key={`${tab.id}:${tab.navToken ?? 0}`}
		>
			<CurrentTabIdProvider tabId={tab.id}>
				{tab.unloaded ? null : (
					<RouteOutlet onClose={() => value.closeTab(tab.id)} tab={tab} />
				)}
			</CurrentTabIdProvider>
		</IsActiveTabProvider>
	));
}

function WorkbenchProbe() {
	workbench = useDesktopWorkbench();
	workbenchStates.add(workbench.state);
	workbenchRenders += 1;
	return null;
}

function App({ strict = false }: { strict?: boolean }) {
	const tree: ReactNode = (
		<DesktopWorkbenchProvider
			persistenceDelayMs={60_000}
			storage={localStorage}
		>
			<TabsProvider>
				<TitleBarProvider>
					<WorkbenchProbe />
					<Shell />
				</TitleBarProvider>
			</TabsProvider>
		</DesktopWorkbenchProvider>
	);
	return strict ? <StrictMode>{tree}</StrictMode> : tree;
}

function tabs(): TabsValue {
	if (!latest) {
		throw new Error("TabsProvider has not rendered");
	}
	return latest;
}

function groupOf(itemId: string): string | undefined {
	return workbench?.state.groups.find((group) => group.itemIds.includes(itemId))
		?.id;
}

function rendersOf(names: readonly (typeof TAB_NAMES)[number][]) {
	return Object.fromEntries(
		names.map((name) => [name, renders.get(ids[name]) ?? 0])
	);
}

function rendersFor(name: (typeof TAB_NAMES)[number]): number {
	return renders.get(ids[name]) ?? 0;
}

function routeTabFor(name: (typeof TAB_NAMES)[number]): RouteTab | undefined {
	return routeTabs.get(ids[name]);
}

/** The projected `Tab` a name maps to. RouteOutlet hands this exact object to
    the route render, so `routeTabFor(name)` is expected to be identical to it. */
function projectedTab(name: (typeof TAB_NAMES)[number]): Tab | undefined {
	return tabs().tabs.find((tab) => tab.id === ids[name]);
}

function pageActive(name: (typeof TAB_NAMES)[number]): string | null {
	for (const page of container.querySelectorAll("[data-page]")) {
		if (page.getAttribute("data-page") === ids[name]) {
			return page.getAttribute("data-active");
		}
	}
	return null;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	localStorage.clear();
	localStorage.setItem("ryu:product-mode", "os");
	localStorage.setItem("ryu_startup_behavior", "restore");
	localStorage.setItem(
		"ryu_session_tabs",
		JSON.stringify({
			activeIndex: 0,
			tabs: TAB_NAMES.map((name) => ({
				path: `/retained/${name}`,
				title: `Title ${name}`,
			})),
		})
	);
	renders.clear();
	routeTabs.clear();
	openTabIdentities.clear();
	workbenchStates.clear();
	workbenchRenders = 0;
	latest = undefined;
	workbench = undefined;
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

async function mount(strict = false) {
	await act(async () => root.render(<App strict={strict} />));
	// Let startup Workbench sync and the active page's title-bar write settle.
	await act(async () => undefined);
	const mounted = tabs().tabs;
	const paths = mounted.map((tab) => tab.path).join(",");
	const expectedPaths = TAB_NAMES.map((name) => `/retained/${name}`).join(",");
	if (paths !== expectedPaths) {
		throw new Error(`Restored tabs ${paths}, expected ${expectedPaths}`);
	}
	for (const [index, name] of TAB_NAMES.entries()) {
		ids[name] = mounted[index]?.id ?? "";
	}
	if (new Set(Object.values(ids)).size !== TAB_NAMES.length) {
		throw new Error("Restored tabs do not have distinct ids");
	}
}

describe("retained route pages on tab switch", () => {
	test("switching between two tabs renders neither unrelated retained page", async () => {
		await mount();
		const before = rendersOf(["c", "d"]);
		const activeBefore = rendersFor("b");

		for (let index = 0; index < 10; index++) {
			const target = index % 2 === 0 ? ids.b : ids.a;
			await act(async () => tabs().activateTab(target));
		}

		expect(rendersOf(["c", "d"])).toEqual(before);
		// The tab being activated still renders, and its page knows it is active.
		expect(rendersFor("b")).toBeGreaterThan(activeBefore);
		expect(tabs().activeTabId).toBe(ids.a);
		expect(pageActive("a")).toBe("true");
		expect(pageActive("b")).toBe("false");
	});

	test("activation keeps every unrelated projected tab object identical", async () => {
		await mount();
		const before = tabs().tabs;

		await act(async () => tabs().activateTab(ids.b));

		const after = tabs().tabs;
		expect(after[0]).toBe(before[0]);
		expect(after[2]).toBe(before[2]);
		expect(after[3]).toBe(before[3]);
		// The activated page's title-bar write is a real change to that tab only.
		expect(after[1]).not.toBe(before[1]);
		expect(after[1]?.title).toBe(`Page ${ids.b}`);

		await act(async () => tabs().activateTab(ids.a));
		await act(async () => tabs().activateTab(ids.b));
		// With every title already written, a round trip changes nothing.
		expect(tabs().tabs).toBe(after);
	});

	test("a real change to one tab re-renders that tab and nothing unrelated", async () => {
		await mount();
		let before = rendersOf(TAB_NAMES);

		await act(async () => tabs().updateTabTitle(ids.c, "Renamed"));
		expect(routeTabFor("c")).toMatchObject({ title: "Renamed" });
		expect(rendersFor("c")).toBeGreaterThan(before.c ?? 0);
		expect(rendersOf(["a", "b", "d"])).toEqual({
			a: before.a,
			b: before.b,
			d: before.d,
		});

		before = rendersOf(TAB_NAMES);
		await act(async () => tabs().updateTabBusy(ids.d, true, "fast"));
		expect(routeTabFor("d")).toMatchObject({ busy: true, busySpeed: "fast" });
		expect(rendersFor("d")).toBeGreaterThan(before.d ?? 0);
		expect(rendersFor("c")).toBe(before.c ?? 0);

		before = rendersOf(TAB_NAMES);
		await act(async () => tabs().bindTabConversation(ids.d, "thread-d"));
		expect(routeTabFor("d")?.conversationId).toBe("thread-d");
		expect(rendersFor("d")).toBeGreaterThan(before.d ?? 0);
		expect(rendersFor("c")).toBe(before.c ?? 0);

		before = rendersOf(TAB_NAMES);
		await act(async () => tabs().togglePin(ids.c));
		expect(routeTabFor("c")).toMatchObject({ pinned: true });
		expect(rendersFor("c")).toBeGreaterThan(before.c ?? 0);
		expect(rendersFor("d")).toBe(before.d ?? 0);

		before = rendersOf(TAB_NAMES);
		await act(async () =>
			tabs().updateTabIcon(ids.d, { kind: "emoji", emoji: "x" })
		);
		expect(routeTabFor("d")).toMatchObject({
			icon: { kind: "emoji", emoji: "x" },
		});
		expect(rendersFor("d")).toBeGreaterThan(before.d ?? 0);
		expect(rendersFor("c")).toBe(before.c ?? 0);
	});

	test("joining and leaving a split re-renders the members with their split id", async () => {
		await mount();
		let before = rendersOf(TAB_NAMES);

		await act(async () => tabs().splitTabs([ids.c, ids.d]));
		// Each member page received the projected tab carrying its split id.
		for (const name of ["c", "d"] as const) {
			expect(projectedTab(name)?.splitId).toBe("workbench:center");
			expect(routeTabFor(name)).toBe(projectedTab(name));
		}
		expect(rendersFor("d")).toBeGreaterThan(before.d ?? 0);
		expect(rendersFor("b")).toBe(before.b ?? 0);

		before = rendersOf(TAB_NAMES);
		await act(async () => tabs().unsplit(ids.c));
		// Leaving the split hands both pages a projected tab without a split id.
		for (const name of ["c", "d"] as const) {
			expect(projectedTab(name)).toBeDefined();
			expect(projectedTab(name)?.splitId).toBeUndefined();
			expect(routeTabFor(name)).toBe(projectedTab(name));
		}
		expect(rendersFor("c")).toBeGreaterThan(before.c ?? 0);
		expect(rendersFor("d")).toBeGreaterThan(before.d ?? 0);
		expect(rendersFor("b")).toBe(before.b ?? 0);
	});

	test("StrictMode double effects keep one Workbench item per tab and no unrelated renders", async () => {
		await mount(true);
		for (const name of TAB_NAMES) {
			const owners = workbench?.state.groups.filter((group) =>
				group.itemIds.includes(ids[name])
			);
			expect(owners).toHaveLength(1);
			expect(
				owners?.[0]?.itemIds.filter((itemId) => itemId === ids[name])
			).toEqual([ids[name]]);
		}
		expect(
			workbench?.state.items.filter((item) => item.source.kind === "route")
		).toHaveLength(TAB_NAMES.length);
		const before = rendersOf(["c", "d"]);
		const activeBefore = rendersFor("b");

		await act(async () => tabs().activateTab(ids.b));
		await act(async () => tabs().activateTab(ids.a));

		expect(rendersOf(["c", "d"])).toEqual(before);
		expect(rendersFor("b")).toBeGreaterThan(activeBefore);
		expect(pageActive("a")).toBe("true");
	});
});

describe("updateTabTitle", () => {
	test("a title the tab already has dispatches nothing and renders nothing", async () => {
		await mount();
		await act(async () => tabs().updateTabTitle(ids.c, "Renamed"));
		expect(projectedTab("c")?.title).toBe("Renamed");

		const state = workbench?.state;
		const projected = tabs().tabs;
		const states = workbenchStates.size;
		const probeRenders = workbenchRenders;
		const pageRenders = rendersOf(TAB_NAMES);

		await act(async () => tabs().updateTabTitle(ids.c, "Renamed"));
		await act(async () => tabs().updateTabTitle(ids.c, "Renamed"));

		// Not one Workbench commit: the layout state is the same object, no
		// consumer of it rendered, and no tab page rendered either.
		expect(workbench?.state).toBe(state);
		expect(workbenchStates.size).toBe(states);
		expect(workbenchRenders).toBe(probeRenders);
		expect(tabs().tabs).toBe(projected);
		expect(rendersOf(TAB_NAMES)).toEqual(pageRenders);
	});

	test("a different title still commits once and renders only that tab", async () => {
		await mount();
		await act(async () => tabs().updateTabTitle(ids.c, "Renamed"));
		const states = workbenchStates.size;
		const pageRenders = rendersOf(TAB_NAMES);

		await act(async () => tabs().updateTabTitle(ids.c, "Renamed again"));

		expect(workbenchStates.size).toBe(states + 1);
		expect(projectedTab("c")?.title).toBe("Renamed again");
		expect(rendersFor("c")).toBeGreaterThan(pageRenders.c ?? 0);
		expect(rendersOf(["a", "b", "d"])).toEqual({
			a: pageRenders.a,
			b: pageRenders.b,
			d: pageRenders.d,
		});
	});

	test("a title the runtime tab already has still reaches a Workbench item that holds another one", async () => {
		await mount();
		// Unmounting flushes the layout; give tab c's stored item a title that
		// disagrees with the session tab ("Title c") the restore takes the
		// runtime title from.
		await act(async () => root.unmount());
		const stored = JSON.parse(
			localStorage.getItem(WORKBENCH_STORAGE_KEY) ?? "null"
		) as { items: Array<{ source: { path?: string }; title: string }> };
		const staleItem = stored.items.find(
			(item) => item.source.path === "/retained/c"
		);
		expect(staleItem?.title).toBe("Title c");
		if (staleItem) {
			staleItem.title = "Stale c";
		}
		localStorage.setItem(WORKBENCH_STORAGE_KEY, JSON.stringify(stored));
		root = createRoot(container);
		await mount();
		// The strip shows the item's title while the runtime tab says "Title c".
		expect(projectedTab("c")?.title).toBe("Stale c");

		await act(async () => tabs().updateTabTitle(ids.c, "Title c"));

		expect(projectedTab("c")?.title).toBe("Title c");
		expect(
			workbench?.state.items.find((item) => item.id === ids.c)?.title
		).toBe("Title c");
	});

	test("a title for a tab that does not exist dispatches nothing", async () => {
		await mount();
		const state = workbench?.state;
		const probeRenders = workbenchRenders;

		await act(async () => tabs().updateTabTitle("no-such-tab", "Ghost"));

		expect(workbench?.state).toBe(state);
		expect(workbenchRenders).toBe(probeRenders);
	});
});

describe("openTab identity", () => {
	test("keeps one identity across activations, focus moves, and title writes", async () => {
		await mount();
		const initial = tabs().openTab;
		openTabIdentities.clear();

		for (const name of ["b", "c", "a", "d", "a"] as const) {
			await act(async () => tabs().activateTab(ids[name]));
		}
		await act(async () => tabs().focusTab(ids.b));
		await act(async () => tabs().updateTabTitle(ids.b, "Fresh title"));

		expect(tabs().openTab).toBe(initial);
		expect([...openTabIdentities]).toEqual([initial]);
	});

	test("reopening the already-active tab still reports the open request", async () => {
		await mount();
		const requested: string[] = [];
		const unsubscribe = subscribeTabOpenRequests((id) => requested.push(id));
		try {
			await act(async () => tabs().openTab("/retained/b"));
			const before = tabs().tabs.find((tab) => tab.id === ids.b);
			await act(async () => tabs().openTab("/retained/b"));
			// Nothing about the tab changes, so only the signal shows the request.
			expect(tabs().tabs.find((tab) => tab.id === ids.b)).toEqual(before);
			expect(requested).toEqual([ids.b, ids.b]);
		} finally {
			unsubscribe();
		}
	});

	test("a captured openTab sees split membership created after it was captured", async () => {
		localStorage.setItem("ryu_tab_open_behavior", "current");
		await mount();
		const captured = tabs().openTab;

		await act(async () => tabs().splitTabs([ids.a, ids.b]));
		expect(tabs().activeTabId).toBe(ids.a);

		let openedId = "";
		await act(async () => {
			openedId = captured("/retained/opened", { title: "Opened" });
		});

		// "Open in current tab" must not rewrite a split member in place.
		expect(openedId).not.toBe(ids.a);
		expect(tabs().tabs.find((tab) => tab.id === ids.a)?.path).toBe(
			"/retained/a"
		);
		expect(tabs().tabs.find((tab) => tab.id === openedId)?.path).toBe(
			"/retained/opened"
		);
		expect(tabs().activeTabId).toBe(openedId);
	});

	test("a captured openTab never re-points a tiled split member onto another shell route", async () => {
		await mount();
		const captured = tabs().openTab;

		// No tab is in the Library family yet, so this opens a fresh one.
		let libraryId = "";
		await act(async () => {
			libraryId = captured("/library/agent");
		});
		expect(tabs().tabs.find((tab) => tab.id === libraryId)?.path).toBe(
			"/library/agent"
		);

		await act(async () => tabs().splitTabs([libraryId, ids.a]));
		expect(tabs().tabs.find((tab) => tab.id === libraryId)?.splitId).toBe(
			"workbench:center"
		);

		// Another Library route: the family tier must skip the tiled pane the
		// user deliberately placed, not rewrite it in place.
		let navigatedId = "";
		await act(async () => {
			navigatedId = captured("/library/skill");
		});

		expect(navigatedId).not.toBe(libraryId);
		expect(tabs().tabs.find((tab) => tab.id === libraryId)?.path).toBe(
			"/library/agent"
		);
		expect(tabs().tabs.find((tab) => tab.id === navigatedId)?.path).toBe(
			"/library/skill"
		);
		expect(tabs().activeTabId).toBe(navigatedId);
	});

	test("a captured openTab lands in the Center group focused after it was captured", async () => {
		await mount();
		const captured = tabs().openTab;

		await act(async () => tabs().splitTabs([ids.a, ids.b]));
		await act(async () => tabs().activateTab(ids.b));
		expect(groupOf(ids.b)).not.toBe(groupOf(ids.a));

		let openedId = "";
		await act(async () => {
			openedId = captured("/retained/after-focus", { forceNew: true });
		});

		expect(groupOf(openedId)).toBe(groupOf(ids.b));
		expect(tabs().activeTabId).toBe(openedId);
	});

	test("openTab right after an activation in the same handler targets the newly focused group", async () => {
		await mount();
		await act(async () => tabs().splitTabs([ids.a, ids.b]));
		expect(tabs().activeTabId).toBe(ids.a);

		let openedId = "";
		await act(async () => {
			const value = tabs();
			value.activateTab(ids.b);
			openedId = value.openTab("/retained/same-tick", { forceNew: true });
		});

		expect(groupOf(openedId)).toBe(groupOf(ids.b));
		expect(groupOf(openedId)).not.toBe(groupOf(ids.a));
	});
});
