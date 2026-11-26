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
		// A RESOLVED free verdict (signed in, no plan, no license). An unresolved
		// (null) one fails open, so it would not prove the cap is gone.
		verdict: {
			managedInference: false,
			marketplaceApps: false,
			plan: null,
			proUnlocked: true,
			reason: "free",
		},
	}),
}));
mock.module("@/src/lib/window-routing.ts", () => ({
	listenForEntityActivation: async () => () => undefined,
	registerWindowTabs: async () => undefined,
	tabEntityKey: () => null,
}));
const { TabsProvider, useTabsContext } = await import("./TabsContext.tsx");

test("a signed-in free desktop opens ten tabs with no license or upgrade prompt", async () => {
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
				initialTab={{ path: "/chat", conversationId: "tab-1", title: "First" }}
			>
				<ReadTabs />
			</TabsProvider>
		);
	try {
		await act(render);
		for (let index = 2; index <= 10; index += 1) {
			await act(() => {
				tabs?.openTab("/chat", { conversationId: `tab-${index}` });
			});
			// Each open adds a tab and focuses it: nothing is refused at three.
			expect(tabs?.tabs).toHaveLength(index);
		}
		expect(tabs?.tabs).toHaveLength(10);
		expect(licensePrompts).toBe(0);
		expect(generalPrompts).toBe(0);
		// Reopening an existing conversation focuses its tab instead of adding one.
		await act(() => {
			tabs?.openTab("/chat", { conversationId: "tab-1" });
		});
		expect(tabs?.tabs).toHaveLength(10);
		expect(licensePrompts).toBe(0);
		expect(generalPrompts).toBe(0);
	} finally {
		await act(() => root.unmount());
		localStorage.clear();
	}
});
