import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

// The real TabsProvider, DesktopWorkbenchProvider and TitleBarProvider, with a
// page that calls `useTitleBar` the way ChatPage does. A new chat opened by a
// caller that named it (Start on a suggested task) must keep that name until the
// page has a thread of its own; the page asks the hook to leave the tab's label
// alone for that long. The page's title still reaches the title-bar context,
// which the shell does not render (it reads only the context's actions).
if (globalThis.document === undefined) {
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

const {
	CurrentTabIdProvider,
	IsActiveTabProvider,
	TabsProvider,
	useTabsContext,
} = await import("./TabsContext.tsx");
const { TitleBarProvider, useTitleBar, useTitleBarContext } = await import(
	"./TitleBarContext.tsx"
);
const { DesktopWorkbenchProvider } = await import(
	"@/src/workbench/DesktopWorkbenchContext.tsx"
);

type TabsValue = ReturnType<typeof useTabsContext>;
interface PageProps {
	syncTabLabel?: boolean;
	title: string;
}

const CALLER_TITLE = "Answer step-up email cooldown with 429";
let latestTabs: TabsValue | undefined;
let contextTitle: ReactNode = null;

function Probe() {
	latestTabs = useTabsContext();
	contextTitle = useTitleBarContext().title;
	return null;
}

function Page({ syncTabLabel, title }: PageProps) {
	useTitleBar(
		title,
		null,
		syncTabLabel === undefined ? undefined : { syncTabLabel }
	);
	return null;
}

function Shell(props: PageProps) {
	const value = useTabsContext();
	const tab = value.tabs[0];
	if (!tab) {
		return null;
	}
	return (
		<IsActiveTabProvider isActive={tab.id === value.activeTabId}>
			<CurrentTabIdProvider tabId={tab.id}>
				<Page {...props} />
			</CurrentTabIdProvider>
		</IsActiveTabProvider>
	);
}

function App(props: PageProps) {
	return (
		<DesktopWorkbenchProvider
			persistenceDelayMs={60_000}
			storage={localStorage}
		>
			<TabsProvider>
				<TitleBarProvider>
					<Probe />
					<Shell {...props} />
				</TitleBarProvider>
			</TabsProvider>
		</DesktopWorkbenchProvider>
	);
}

function tabLabel(): string | undefined {
	return latestTabs?.tabs[0]?.title;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	localStorage.clear();
	localStorage.setItem("ryu_startup_behavior", "restore");
	localStorage.setItem(
		"ryu_session_tabs",
		JSON.stringify({
			activeIndex: 0,
			tabs: [{ path: "/chat", title: CALLER_TITLE }],
		})
	);
	latestTabs = undefined;
	contextTitle = null;
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

async function render(props: PageProps) {
	await act(async () => root.render(<App {...props} />));
	// Let the startup Workbench sync and the page's title-bar writes settle.
	await act(async () => undefined);
}

test("a page that opts out leaves the tab's label alone while the title-bar context still carries its title", async () => {
	await render({ syncTabLabel: false, title: "New chat" });
	expect(tabLabel()).toBe(CALLER_TITLE);
	expect(contextTitle).toBe("New chat");
});

test("by default the page's title becomes the tab's label", async () => {
	await render({ title: "New chat" });
	expect(tabLabel()).toBe("New chat");
	expect(contextTitle).toBe("New chat");
});

test("the label is written once the page asks for it, and left alone again when it stops asking", async () => {
	await render({ syncTabLabel: false, title: "New chat" });
	expect(tabLabel()).toBe(CALLER_TITLE);

	await render({ syncTabLabel: true, title: "Map the step-up email cooldown" });
	expect(tabLabel()).toBe("Map the step-up email cooldown");

	await render({ syncTabLabel: false, title: "A later title" });
	expect(tabLabel()).toBe("Map the step-up email cooldown");
	expect(contextTitle).toBe("A later title");
});
