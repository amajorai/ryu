// The #686 interface host, mounted whole: the real `InterfaceSurface` over the
// real tab system, the real conversation-history provider, the real agents and
// teams hooks, and the real Feed renderer. Only the Core HTTP boundary (`fetch`)
// and the two host seams a browser cannot provide (the entitlement dialog and
// cross-window routing) are replaced.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
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

// What Core answers. `conversationsUp` is the outage switch the Retry test
// flips; `conversationRequests` counts the reads that reached the wire.
let conversationsUp = true;
let agentsUp = true;
let conversationRequests = 0;
let agentRequests = 0;
const THREAD_TITLE = "Quarterly planning thread";

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

function coreAnswer(input: Request | string | URL): Response {
	const path = new URL(
		typeof input === "string" || input instanceof URL ? input : input.url
	).pathname;
	if (path === "/api/conversations") {
		conversationRequests += 1;
		if (!conversationsUp) {
			return json({ error: "core is down" }, 503);
		}
		return json({
			conversations: [
				{
					agent_id: null,
					branch: null,
					created_at: 1_700_000_000_000,
					folder_path: null,
					id: "conv-1",
					last_message: "Let us pick the dates.",
					last_message_at: 1_700_000_100_000,
					last_message_role: "user",
					message_count: 2,
					run_status: null,
					title: THREAD_TITLE,
					updated_at: 1_700_000_100_000,
					worktree_path: null,
				},
			],
		});
	}
	if (path === "/api/agents") {
		agentRequests += 1;
		return agentsUp
			? json({ agents: [] })
			: json({ error: "agents down" }, 503);
	}
	if (path === "/api/teams") {
		return json({ teams: [] });
	}
	return json({}, 404);
}

globalThis.fetch = ((input: Request | string | URL) =>
	Promise.resolve(coreAnswer(input))) as typeof fetch;

const { InterfaceSurface } = await import("./InterfaceSurface.tsx");
const { BUILTIN_INTERFACES } = await import("./registry.ts");
const { TabsProvider, useTabsContext } = await import(
	"@/src/contexts/TabsContext.tsx"
);
const { ChatHistoryProvider } = await import(
	"@/src/contexts/ChatHistoryContext.tsx"
);
const { DesktopWorkbenchProvider } = await import(
	"@/src/workbench/DesktopWorkbenchContext.tsx"
);
const { queryClient } = await import("@/src/lib/query-client.ts");
const { useProductModeStore } = await import("@/src/lib/product-mode.ts");

type TabsValue = ReturnType<typeof useTabsContext>;

function builtinFeed() {
	const found = BUILTIN_INTERFACES.find((entry) => entry.renderer === "feed");
	if (!found) {
		throw new Error("the Feed interface is no longer built in");
	}
	return found;
}
const FEED = builtinFeed();

let latestTabs: TabsValue | undefined;
function TabsProbe() {
	latestTabs = useTabsContext();
	return null;
}
function tabs(): TabsValue {
	if (!latestTabs) {
		throw new Error("TabsProvider has not rendered");
	}
	return latestTabs;
}

let container: HTMLDivElement;
let root: Root;

/** Lets pending fetches, query settles, and lazy renderer imports finish. */
async function settle(check: () => boolean) {
	for (let attempt = 0; attempt < 400; attempt++) {
		if (check()) {
			return;
		}
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
	}
	throw new Error("Timed out waiting for the interface to settle");
}

async function mountSurface() {
	await act(async () =>
		root.render(
			<QueryClientProvider client={queryClient}>
				<DesktopWorkbenchProvider
					persistenceDelayMs={60_000}
					storage={localStorage}
				>
					<TabsProvider>
						<ChatHistoryProvider>
							<TabsProbe />
							<InterfaceSurface canSwitchToConsole={false} descriptor={FEED} />
						</ChatHistoryProvider>
					</TabsProvider>
				</DesktopWorkbenchProvider>
			</QueryClientProvider>
		)
	);
}

const byTestId = (id: string) =>
	container.querySelector(`[data-testid="${id}"]`);
const bodyText = () => container.textContent ?? "";
// Asserted as plain values: a failed `expect(element)` makes Bun print the
// whole happy-dom tree, which can abort the process instead of failing cleanly.
const unavailableShown = () => byTestId("interface-unavailable") !== null;
const shownPage = () =>
	byTestId("ryu-interface-page")?.getAttribute("aria-label") ?? null;

function seedSession(paths: Array<{ path: string; title: string }>) {
	localStorage.setItem("ryu_startup_behavior", "restore");
	localStorage.setItem(
		"ryu_session_tabs",
		JSON.stringify({ activeIndex: paths.length - 1, tabs: paths })
	);
}

beforeEach(() => {
	localStorage.clear();
	// Feed is a workspace interface; the surface itself only mounts for one.
	useProductModeStore.getState().setOsAccess(true);
	conversationsUp = true;
	agentsUp = true;
	conversationRequests = 0;
	agentRequests = 0;
	latestTabs = undefined;
	queryClient.clear();
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	queryClient.clear();
});

describe("InterfaceSurface conversation load", () => {
	test("a failed conversation load shows Retry, and Retry recovers the real list", async () => {
		conversationsUp = false;
		await mountSurface();
		await settle(unavailableShown);

		// A failed load never reads as an empty workspace.
		expect(bodyText()).toContain("Couldn't load conversations");
		expect(bodyText()).not.toContain(THREAD_TITLE);
		const requestsAtFailure = conversationRequests;
		expect(requestsAtFailure).toBeGreaterThan(0);

		// Core comes back; the user presses Retry.
		conversationsUp = true;
		const retry = [...container.querySelectorAll("button")].find(
			(button) => button.textContent === "Retry"
		);
		expect(retry).toBeDefined();
		await act(async () => retry?.click());

		await settle(() => bodyText().includes(THREAD_TITLE));
		expect(conversationRequests).toBeGreaterThan(requestsAtFailure);
		expect(unavailableShown()).toBe(false);
		expect(bodyText()).not.toContain("Couldn't load conversations");
	});
});

describe("InterfaceSurface conversation load, agent side", () => {
	test("a failed agent load shows the same Retry, and Retry reloads the agents", async () => {
		agentsUp = false;
		await mountSurface();
		await settle(unavailableShown);
		// The conversations loaded, yet the host still refuses to pass off an
		// empty roster as a workspace with nothing in it.
		expect(bodyText()).toContain("Couldn't load conversations");
		expect(bodyText()).not.toContain(THREAD_TITLE);
		const agentRequestsAtFailure = agentRequests;

		agentsUp = true;
		const retry = [...container.querySelectorAll("button")].find(
			(button) => button.textContent === "Retry"
		);
		await act(async () => retry?.click());

		await settle(() => bodyText().includes(THREAD_TITLE));
		expect(agentRequests).toBeGreaterThan(agentRequestsAtFailure);
		expect(unavailableShown()).toBe(false);
	});
});

describe("InterfaceSurface overview", () => {
	function headerButton(label: string): HTMLButtonElement {
		const found = [...container.querySelectorAll("nav button")].find((button) =>
			button.textContent?.includes(label)
		);
		if (!(found instanceof HTMLButtonElement)) {
			throw new Error(`header button ${label} missing`);
		}
		return found;
	}

	function backButton(): HTMLButtonElement {
		const found = [...container.querySelectorAll("button")].find((button) =>
			button.textContent?.startsWith("Back to")
		);
		if (!(found instanceof HTMLButtonElement)) {
			throw new Error("Back button missing");
		}
		return found;
	}

	test("a page that was active when the interface mounted starts as the overview, and a deep link to it ends the overview", async () => {
		seedSession([{ path: "/settings", title: "Settings" }]);
		await mountSurface();
		await settle(() => latestTabs !== undefined);
		await settle(() => bodyText().includes(THREAD_TITLE));

		// Settings is the active tab, yet the interface's overview is showing.
		expect(tabs().tabs.map((tab) => tab.path)).toEqual(["/settings"]);
		expect(tabs().tabs.find((tab) => tab.id === tabs().activeTabId)?.path).toBe(
			"/settings"
		);
		expect(shownPage()).toBeNull();

		// A deep link re-opens that very tab. No tab state changes, so only the
		// open request itself can tell the host the user navigated.
		const before = tabs().tabs.map((tab) => tab.id);
		await act(async () => {
			tabs().openTab("/settings");
		});
		expect(tabs().tabs.map((tab) => tab.id)).toEqual(before);
		expect(shownPage()).toBe("Settings");
	});

	test("leaving a page reveals the tab behind it hidden, and re-opening that revealed tab shows it", async () => {
		seedSession([
			{ path: "/settings", title: "Settings" },
			{ path: "/marketplace", title: "Marketplace" },
		]);
		await mountSurface();
		await settle(() => bodyText().includes(THREAD_TITLE));
		expect(shownPage()).toBeNull();

		// The header opens Settings as a page over the interface.
		await act(async () => headerButton("Settings").click());
		expect(shownPage()).toBe("Settings");

		// Back closes it; closing reveals the Marketplace tab, which stays hidden.
		await act(async () => backButton().click());
		expect(tabs().tabs.map((tab) => tab.path)).toEqual(["/marketplace"]);
		expect(tabs().tabs.find((tab) => tab.id === tabs().activeTabId)?.path).toBe(
			"/marketplace"
		);
		expect(shownPage()).toBeNull();

		// A deep link to the revealed tab is the user navigating there.
		await act(async () => {
			tabs().openTab("/marketplace");
		});
		expect(shownPage()).toBe("Marketplace");
	});

	test("switching to another tab ends the overview for good, so coming back to the hidden tab shows it", async () => {
		seedSession([
			{ path: "/settings", title: "Settings" },
			{ path: "/marketplace", title: "Marketplace" },
		]);
		await mountSurface();
		await settle(() => bodyText().includes(THREAD_TITLE));
		const [settings, marketplace] = tabs().tabs;
		if (!(settings && marketplace)) {
			throw new Error("the seeded session did not restore both tabs");
		}
		// Marketplace was active at mount, so the overview hides it.
		expect(tabs().activeTabId).toBe(marketplace.id);
		expect(shownPage()).toBeNull();

		// Picking the other tab opens nothing: it is plain tab navigation.
		await act(async () => tabs().activateTab(settings.id));
		expect(shownPage()).toBe("Settings");

		// The overview is over, so the once-hidden tab now shows.
		await act(async () => tabs().activateTab(marketplace.id));
		expect(shownPage()).toBe("Marketplace");
	});
});
