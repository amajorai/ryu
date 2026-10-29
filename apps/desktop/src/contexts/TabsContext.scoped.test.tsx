import { expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useMemo } from "react";
import { createRoot } from "react-dom/client";

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
const { TabsProvider, TabsStateProvider, useTabSelector, useTabsContext } =
	await import("./TabsContext.tsx");

test("embedded selector mutations respect the scoped provider and preserve the companion tab", async () => {
	const root = createRoot(document.createElement("div"));
	let parentTitle: string | undefined;
	let parentConversation: string | undefined;
	let mutate: (() => void) | undefined;
	function Embedded() {
		const updateTitle = useTabSelector((state) => state.updateTabTitle);
		const bindConversation = useTabSelector(
			(state) => state.bindTabConversation
		);
		const id = useTabSelector((state) => state.activeTabId);
		mutate = () => {
			updateTitle(id, "Changed chat title");
			bindConversation(id, "app-conversation");
		};
		return null;
	}
	function Scoped() {
		const parent = useTabsContext();
		parentTitle = parent.tabs.find(
			(tab) => tab.id === parent.activeTabId
		)?.title;
		parentConversation = parent.tabs.find(
			(tab) => tab.id === parent.activeTabId
		)?.conversationId;
		const value = useMemo(
			() => ({
				...parent,
				updateTabTitle: () => undefined,
				bindTabConversation: () => undefined,
			}),
			[parent]
		);
		return (
			<TabsStateProvider value={value}>
				<Embedded />
			</TabsStateProvider>
		);
	}
	try {
		await act(() =>
			root.render(
				<TabsProvider
					initialTab={{ path: "/plugin/parts", title: "Parts app" }}
				>
					<Scoped />
				</TabsProvider>
			)
		);
		expect(mutate).toBeDefined();
		await act(() => mutate?.());
		expect(parentTitle).toBe("Parts app");
		expect(parentConversation).toBeUndefined();
	} finally {
		await act(() => root.unmount());
	}
});
