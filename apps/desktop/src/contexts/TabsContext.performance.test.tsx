import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useMemo, useState } from "react";
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
	tabEntityKey: (tab: { conversationId?: string }) =>
		tab.conversationId ? `conversation:${tab.conversationId}` : null,
}));

const { TabsProvider, useTabSelector, useTabsContext } = await import(
	"./TabsContext.tsx"
);

const root = createRoot(document.createElement("div"));
let rerenderParent: (() => void) | undefined;
let contextRenders = 0;
let selectorRenders = 0;

function ContextConsumer() {
	useTabsContext();
	contextRenders += 1;
	return null;
}

function SelectorConsumer() {
	useTabSelector((state) => state.openTab);
	selectorRenders += 1;
	return null;
}

function Harness() {
	const [, setTick] = useState(0);
	rerenderParent = () => setTick((value) => value + 1);
	const children = useMemo(
		() => (
			<>
				<ContextConsumer />
				<SelectorConsumer />
			</>
		),
		[]
	);
	return <TabsProvider initialTab={{ path: "/chat" }}>{children}</TabsProvider>;
}

afterEach(async () => {
	await act(() => root.unmount());
	rerenderParent = undefined;
	contextRenders = 0;
	selectorRenders = 0;
});

test("tab context consumers skip parent renders when tab state is unchanged", async () => {
	await act(() => root.render(<Harness />));
	const mountedContextRenders = contextRenders;
	const mountedSelectorRenders = selectorRenders;
	expect(mountedContextRenders).toBeGreaterThan(0);
	expect(mountedSelectorRenders).toBeGreaterThan(0);

	await act(() => rerenderParent?.());
	expect(contextRenders).toBe(mountedContextRenders);
	expect(selectorRenders).toBe(mountedSelectorRenders);
});
