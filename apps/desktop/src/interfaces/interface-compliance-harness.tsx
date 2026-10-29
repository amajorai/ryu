// Test harness for the interface compliance suites: the real InterfaceSurface
// (top bar, switcher, renderer box, error boundary) and the real renderers,
// over a fixture snapshot. Only the data hooks are stubbed. Import this before
// anything that loads InterfaceSurface: it registers the DOM and the mocks.

import { mock } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { usefulStateFixture } from "@ryuhq/protocol/interfaces-fixture";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
// Base UI waits on animations, which happy-dom does not model.
if (typeof Element.prototype.getAnimations !== "function") {
	Element.prototype.getAnimations = () => [];
}
// happy-dom lays nothing out; a connected element counts as on screen.
Element.prototype.getClientRects = function getClientRects() {
	return (this.isConnected
		? [new DOMRect(0, 0, 10, 10)]
		: []) as unknown as DOMRectList;
};

const SNAPSHOT = usefulStateFixture();

mock.module("./use-interface-snapshot.ts", () => ({
	useInterfaceSnapshot: () => ({
		loading: false,
		retry: () => undefined,
		snapshot: SNAPSHOT,
		unavailable: false,
	}),
}));
mock.module("@/src/hooks/useApprovals.ts", () => ({
	useApprovals: () => ({
		approve: async () => undefined,
		reject: async () => undefined,
	}),
}));
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => ({
		name: "Local",
		token: null,
		url: "http://node.fixture",
		userJwt: null,
	}),
}));
mock.module("@/src/contributions/RouteOutlet.tsx", () => ({
	RouteOutlet: () => null,
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TabsContext } = await import("@/src/contexts/TabsContext.tsx");
const { InterfaceSurface } = await import("./InterfaceSurface.tsx");
const { useInterfaceStore } = await import("./interface-store.ts");
const { useProductModeStore } = await import("@/src/lib/product-mode.ts");

import type { InterfaceDescriptor } from "@ryuhq/protocol/interfaces";

const TABS = {
	activeTabId: null,
	closeTab: () => undefined,
	openTab: () => undefined,
	tabs: [],
} as unknown as NonNullable<
	Parameters<typeof TabsContext.Provider>[0]["value"]
>;

export interface MountedSurface {
	bar: HTMLElement;
	box: HTMLElement;
	container: HTMLElement;
	dispose: () => Promise<void>;
	switcher: HTMLElement;
}

/** Make `descriptor` the active interface, as the shell would. */
export function activate(descriptor: InterfaceDescriptor): void {
	useProductModeStore.setState({
		consoleAccess: true,
		osAccess: true,
		requestedMode: "os",
	});
	useInterfaceStore.setState({
		contributed:
			descriptor.origin === "marketplace"
				? [descriptor]
				: useInterfaceStore.getState().contributed,
		workspaceInterfaceId: descriptor.id,
		workspaceInterfaces: true,
	});
}

/** Let lazy renderers load and effects settle. */
export async function settle(rounds = 6): Promise<void> {
	for (let round = 0; round < rounds; round += 1) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 15));
		});
	}
}

function required(scope: ParentNode, selector: string): HTMLElement {
	const element = scope.querySelector<HTMLElement>(selector);
	if (!element) {
		throw new Error(`Missing ${selector}`);
	}
	return element;
}

/** Mount the real InterfaceSurface for `descriptor` and wait for it to load. */
export async function mountSurface(
	descriptor: InterfaceDescriptor
): Promise<MountedSurface> {
	activate(descriptor);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () =>
		root.render(
			<TabsContext.Provider value={TABS}>
				<InterfaceSurface canSwitchToConsole descriptor={descriptor} />
			</TabsContext.Provider>
		)
	);
	await settle();
	return {
		bar: required(container, '[data-testid="ryu-interface-topbar"]'),
		box: required(container, '[data-testid="ryu-interface-box"]'),
		container,
		async dispose() {
			await act(async () => root.unmount());
			container.remove();
		},
		switcher: required(container, '[data-testid="interface-switcher-button"]'),
	};
}

/** The open switcher menu, if any. */
export function openMenu(): HTMLElement | null {
	return document.body.querySelector<HTMLElement>('[role="menu"]');
}

export function menuItem(name: string): HTMLElement | undefined {
	return [
		...document.body.querySelectorAll<HTMLElement>('[role^="menuitem"]'),
	].find((item) => item.textContent?.includes(name));
}

/** Close any open menu (Escape on it), so the next case starts clean. */
export async function closeMenu(): Promise<void> {
	const menu = openMenu();
	if (!menu) {
		return;
	}
	await act(async () => {
		menu.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
		);
	});
	await settle(2);
}

/** Press the Switch Interface chord, as a keydown on `target`. */
export async function pressSwitchChord(target: EventTarget): Promise<void> {
	await act(async () => {
		target.dispatchEvent(
			new KeyboardEvent("keydown", {
				bubbles: true,
				cancelable: true,
				ctrlKey: true,
				key: "U",
				metaKey: true,
				shiftKey: true,
			})
		);
	});
	await settle(2);
}

export { act, SNAPSHOT };
