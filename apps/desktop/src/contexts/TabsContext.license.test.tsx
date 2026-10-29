import { expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let licensePrompts = 0;
let generalPrompts = 0;
let licensed = false;
mock.module("@/src/lib/api/billing.ts", () => ({
	// Agent installs reach the server-driven feature flags (Template Rewards),
	// which read the entitlement snapshot; no account is signed in here.
	fetchEntitlementSnapshot: async () => null,
	hasBillingAuth: () => true,
}));
mock.module("@/src/contexts/entitlement-context.tsx", () => ({
	useEntitlementContext: () => ({
		requestUpgrade: () => {
			generalPrompts += 1;
		},
		requestDesktopLicense: () => {
			licensePrompts += 1;
		},
		// A RESOLVED free verdict: an unresolved (null) one fails open.
		verdict: licensed
			? { plan: "desktop-license", proUnlocked: true }
			: { plan: null, proUnlocked: false },
	}),
}));
mock.module("@/src/lib/window-routing.ts", () => ({
	listenForEntityActivation: async () => () => undefined,
	registerWindowTabs: async () => undefined,
	tabEntityKey: () => null,
}));
const { TabsProvider, useTabsContext } = await import("./TabsContext.tsx");

test("fourth tab offers the desktop license, keeps existing tabs, and unlocks after licensing", async () => {
	localStorage.clear();
	const root = createRoot(document.createElement("div"));
	let tabs: ReturnType<typeof useTabsContext> | undefined;
	function ReadTabs() {
		tabs = useTabsContext();
		return null;
	}
	const render = () =>
		root.render(
			<TabsProvider
				initialTab={{ path: "/chat", conversationId: "first", title: "First" }}
			>
				<ReadTabs />
			</TabsProvider>
		);
	try {
		await act(render);
		await act(() => {
			tabs?.openTab("/chat", { conversationId: "second" });
		});
		await act(() => {
			tabs?.openTab("/chat", { conversationId: "third" });
		});
		const active = tabs?.activeTabId;
		expect(tabs?.tabs).toHaveLength(3);
		await act(() => {
			tabs?.openTab("/chat", { conversationId: "fourth" });
		});
		expect(tabs?.tabs).toHaveLength(3);
		expect(tabs?.activeTabId).toBe(active);
		expect(licensePrompts).toBe(1);
		expect(generalPrompts).toBe(0);
		await act(() => {
			tabs?.openTab("/chat", { conversationId: "first" });
		});
		expect(tabs?.tabs).toHaveLength(3);
		expect(licensePrompts).toBe(1);
		licensed = true;
		await act(render);
		await act(() => {
			tabs?.openTab("/chat", { conversationId: "fourth" });
		});
		expect(tabs?.tabs).toHaveLength(4);
		expect(licensePrompts).toBe(1);
	} finally {
		await act(() => root.unmount());
		localStorage.clear();
	}
});
