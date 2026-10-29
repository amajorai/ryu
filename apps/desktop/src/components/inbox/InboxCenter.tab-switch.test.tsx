import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ContextType } from "react";
import { createRoot, type Root } from "react-dom/client";

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

// InboxCenter's data hooks talk to Core. Each returns one stable, empty result
// so the only thing that can re-render InboxCenter here is the Tabs context.
// The body counter counts executions of InboxCenter's own function body: it
// calls `useApprovals` once per render. (A React `Profiler` is not used: it
// does not report a descendant that re-renders only through context.)
let inboxBodyRenders = 0;
const noop = async () => undefined;
const APPROVALS = {
	approvals: [],
	approve: noop,
	deciding: null,
	error: null,
	loading: false,
	reject: noop,
};
const QUESTS = {
	acceptSuggestion: noop,
	dismissSuggestion: noop,
	loading: false,
	quests: [],
};
const NOTIFICATIONS = {
	ack: async () => true,
	acking: null,
	archive: noop,
	error: null,
	loading: false,
	markRead: noop,
	meId: null,
	notifications: [],
	unarchive: noop,
};
const ANNOUNCEMENTS = {
	announcements: [],
	authed: false,
	dismiss: noop,
	loading: false,
	markRead: noop,
	refresh: noop,
	unreadCount: 0,
};
const NO_SYSTEM_ANNOUNCEMENTS: never[] = [];
mock.module("@/src/hooks/useApprovals.ts", () => ({
	useApprovals: () => {
		inboxBodyRenders += 1;
		return APPROVALS;
	},
}));
mock.module("@/src/hooks/useQuests.ts", () => ({ useQuests: () => QUESTS }));
mock.module("@/src/hooks/useNotifications.ts", () => ({
	useNotifications: () => NOTIFICATIONS,
}));
mock.module("@/src/hooks/useAnnouncements.ts", () => ({
	useAnnouncements: () => ANNOUNCEMENTS,
}));
mock.module("@/src/hooks/useSystemAnnouncements.ts", () => ({
	useSystemAnnouncements: () => NO_SYSTEM_ANNOUNCEMENTS,
}));

const { TabsContext, TabsProvider, useTabsContext } = await import(
	"@/src/contexts/TabsContext.tsx"
);
const { InboxCenter } = await import("./InboxCenter.tsx");
const { DesktopWorkbenchProvider } = await import(
	"@/src/workbench/DesktopWorkbenchContext.tsx"
);
const { installedAppsQuery } = await import("@/src/hooks/useAppsCatalog.ts");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");

type TabsValue = ReturnType<typeof useTabsContext>;

const SWITCHES = 10;

let controlRenders = 0;
let latest: TabsValue | undefined;

/** A deliberate whole-context reader: proves each switch really reaches
    `useTabsContext` subscribers, so "0 re-renders" below is not vacuous. */
function WholeContextControl() {
	latest = useTabsContext();
	controlRenders += 1;
	return null;
}

function tabs(): TabsValue {
	if (!latest) {
		throw new Error("TabsProvider has not rendered");
	}
	return latest;
}

// Built once so the host never re-renders its children: only the Tabs context
// can reach InboxCenter after mount.
function App({ client }: { client: QueryClient }) {
	return (
		<QueryClientProvider client={client}>
			<DesktopWorkbenchProvider
				persistenceDelayMs={60_000}
				storage={localStorage}
			>
				<TabsProvider>
					<WholeContextControl />
					<InboxCenter layout="split" showAnnouncements />
				</TabsProvider>
			</DesktopWorkbenchProvider>
		</QueryClientProvider>
	);
}

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

beforeEach(() => {
	localStorage.clear();
	localStorage.setItem("ryu:product-mode", "os");
	localStorage.setItem("ryu_startup_behavior", "restore");
	localStorage.setItem(
		"ryu_session_tabs",
		JSON.stringify({
			activeIndex: 0,
			tabs: [{ path: "/chat", title: "First" }],
		})
	);
	inboxBodyRenders = 0;
	controlRenders = 0;
	latest = undefined;
	client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Number.MAX_VALUE } },
	});
	// InboxCenter shares the installed-app catalog query with the Store; seed it
	// so no network fetch can resolve mid-test and re-render the tray.
	const node = useNodeStore.getState().getActiveNode();
	client.setQueryData(
		installedAppsQuery({
			url: node.url,
			token: node.token,
			userJwt: node.userJwt ?? null,
		}).queryKey,
		[]
	);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	client.clear();
});

async function mountWithTwoTabs() {
	await act(async () => root.render(<App client={client} />));
	await act(async () => undefined);
	await act(async () => {
		tabs().openTab("/files");
	});
	await act(async () => undefined);
	const ids = tabs().tabs.map((tab) => tab.id);
	if (ids.length !== 2 || new Set(ids).size !== 2) {
		throw new Error(`Expected two distinct tabs, got ${ids.length}`);
	}
	return ids as [string, string];
}

async function clickOpenInbox() {
	const bell = container.querySelector<HTMLButtonElement>(
		'button[aria-controls][aria-expanded="false"]'
	);
	if (!bell) {
		throw new Error("Inbox bell button not found");
	}
	await act(async () => bell.click());
	const openInbox = [...document.querySelectorAll("button")].find((button) =>
		button.textContent?.includes("Open inbox")
	);
	if (!openInbox) {
		throw new Error("Open inbox button not found");
	}
	await act(async () => openInbox.click());
}

describe("openTab-only consumers on tab switch", () => {
	test("InboxCenter does not re-render when the active tab changes", async () => {
		const [first, second] = await mountWithTwoTabs();
		inboxBodyRenders = 0;
		controlRenders = 0;

		const activeAfterEachSwitch: string[] = [];
		const expectedActive: string[] = [];
		for (let index = 0; index < SWITCHES; index++) {
			const target = index % 2 === 0 ? first : second;
			await act(async () => tabs().activateTab(target));
			activeAfterEachSwitch.push(tabs().activeTabId);
			expectedActive.push(target);
		}

		// The switches were real: the active tab alternated and the whole-context
		// control re-rendered for them.
		expect(activeAfterEachSwitch).toEqual(expectedActive);
		expect(controlRenders).toBeGreaterThanOrEqual(SWITCHES / 2);
		// openTab is a stable action, so selecting it must not subscribe
		// InboxCenter to the navigation state it never reads.
		expect(inboxBodyRenders).toBe(0);
	});

	test("the selected openTab still opens tabs from InboxCenter", async () => {
		await mountWithTwoTabs();

		await clickOpenInbox();
		expect(tabs().tabs.map((tab) => tab.path)).toContain("/inbox");
		expect(tabs().tabs.find((tab) => tab.id === tabs().activeTabId)?.path).toBe(
			"/inbox"
		);

		const tabCount = tabs().tabs.length;
		await act(async () => tabs().activateTab(tabs().tabs[0]?.id ?? ""));
		await clickOpenInbox();
		// The inbox tab already exists, so the action focuses it rather than
		// opening a duplicate.
		expect(tabs().tabs).toHaveLength(tabCount);
		expect(tabs().tabs.find((tab) => tab.id === tabs().activeTabId)?.path).toBe(
			"/inbox"
		);
	});

	test("openTab is still read from a direct TabsContext provider (embedded hosts, stories)", async () => {
		const opened: string[] = [];
		const direct = {
			openTab: (path: string) => {
				opened.push(path);
			},
		} as unknown as NonNullable<ContextType<typeof TabsContext>>;
		await act(async () =>
			root.render(
				<QueryClientProvider client={client}>
					<DesktopWorkbenchProvider
						persistenceDelayMs={60_000}
						storage={localStorage}
					>
						<TabsContext.Provider value={direct}>
							<InboxCenter layout="split" showAnnouncements />
						</TabsContext.Provider>
					</DesktopWorkbenchProvider>
				</QueryClientProvider>
			)
		);

		await clickOpenInbox();
		expect(opened).toEqual(["/inbox"]);
	});
});
