// The interface switcher is easy to find: a labelled button in the full-window
// interfaces' top bar, a hotkey from anywhere, and Back to chat at the top.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
// Base UI waits on animations, which happy-dom does not model.
if (typeof Element.prototype.getAnimations !== "function") {
	Element.prototype.getAnimations = () => [];
}
// happy-dom lays nothing out; a mounted switcher counts as on screen.
Element.prototype.getClientRects = function getClientRects() {
	return (this.isConnected
		? [new DOMRect(0, 0, 10, 10)]
		: []) as unknown as DOMRectList;
};

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { findConflicts } = await import("@ryu/hotkeys/registry");
const { builtinInterfaceId } = await import("@ryuhq/protocol/interfaces");
const { DESKTOP_HOTKEYS } = await import("@/src/lib/hotkeys/actions.ts");
const { configureInterfaceEscape } = await import(
	"@/src/interfaces/interface-escape-keys.ts"
);
const { useInterfaceStore } = await import(
	"@/src/interfaces/interface-store.ts"
);
const { openInterfaceSwitcher, useInterfaceSwitcher } = await import(
	"@/src/interfaces/interface-switcher.ts"
);
const { useProductModeStore } = await import("@/src/lib/product-mode.ts");
const { SidebarBrandBadge } = await import("./SidebarBrandBadge.tsx");
const { InterfaceSwitcherDialog } = await import(
	"./InterfaceSwitcherDialog.tsx"
);

type Root = ReturnType<typeof createRoot>;
const roots: Root[] = [];

async function mount(element: React.ReactElement) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	roots.push(root);
	await act(async () => root.render(element));
	return host;
}

async function click(element: Element | null | undefined) {
	if (!(element instanceof HTMLElement)) {
		throw new Error("Expected an element to click");
	}
	await act(async () => element.click());
}

function menuItem(name: string): HTMLElement | undefined {
	return [
		...document.body.querySelectorAll<HTMLElement>('[role^="menuitem"]'),
	].find((item) => item.textContent?.includes(name));
}

const menuOpen = () => document.body.querySelector('[role="menu"]') !== null;

function TopBar() {
	return <SidebarBrandBadge canSwitchToConsole canSwitchToOs labelledTrigger />;
}

beforeEach(() => {
	localStorage.clear();
	useProductModeStore.setState({
		consoleAccess: true,
		osAccess: true,
		requestedMode: "os",
	});
	useInterfaceStore.setState({
		workspaceInterfaceId: builtinInterfaceId("kitchen"),
		workspaceInterfaces: true,
	});
	useInterfaceSwitcher.setState({ fallbackOpen: false });
});

afterEach(async () => {
	for (const root of roots.splice(0)) {
		await act(async () => root.unmount());
	}
	document.body.replaceChildren();
});

describe("interface switcher", () => {
	test("the top bar's labelled button names the interface and opens the menu", async () => {
		const host = await mount(<TopBar />);
		const button = host.querySelector(
			'[data-testid="interface-switcher-button"]'
		);
		expect(button?.textContent).toBe("Kitchen");
		expect(button?.getAttribute("title")).toBe("Switch interface");
		// The lockup stays beside it.
		expect(host.textContent).toContain("Ryu");
		await click(button);
		expect(menuOpen()).toBe(true);
		expect(menuItem("Back to chat")).toBeDefined();
		expect(menuItem("Kitchen")).toBeDefined();
	});

	test("the hotkey opens the switcher on screen", async () => {
		configureInterfaceEscape({
			binding: "Mod+Shift+U",
			enabled: true,
			interfaceShown: true,
			onBackToChat: () => undefined,
		});
		await mount(<TopBar />);
		expect(menuOpen()).toBe(false);
		await act(async () => {
			document.body.dispatchEvent(
				new KeyboardEvent("keydown", {
					bubbles: true,
					ctrlKey: true,
					key: "U",
					metaKey: true,
					shiftKey: true,
				})
			);
		});
		expect(menuOpen()).toBe(true);
		expect(useInterfaceSwitcher.getState().fallbackOpen).toBe(false);
	});

	test("Back to chat leaves the interface for the chat", async () => {
		const host = await mount(<TopBar />);
		await click(
			host.querySelector('[data-testid="interface-switcher-button"]')
		);
		await click(menuItem("Back to chat"));
		expect(useProductModeStore.getState().requestedMode).toBe("console");
	});

	test("in the chat there is no Back to chat", async () => {
		useProductModeStore.setState({ requestedMode: "console" });
		const host = await mount(
			<SidebarBrandBadge canSwitchToConsole canSwitchToOs />
		);
		await click(host.querySelector('[data-testid="product-mode-trigger"]'));
		expect(menuOpen()).toBe(true);
		expect(menuItem("Back to chat")).toBeUndefined();
	});

	test("with no switcher on screen the hotkey opens the fallback dialog", async () => {
		await mount(<InterfaceSwitcherDialog canSwitchToConsole canSwitchToOs />);
		act(() => openInterfaceSwitcher());
		expect(useInterfaceSwitcher.getState().fallbackOpen).toBe(true);
		const dialog = document.body.querySelector(
			'[data-testid="interface-switcher-dialog"]'
		);
		expect(dialog?.textContent).toContain("Kitchen");
		await click(
			document.body.querySelector(
				'[data-testid="interface-switcher-back-to-chat"]'
			)
		);
		expect(useProductModeStore.getState().requestedMode).toBe("console");
		expect(useInterfaceSwitcher.getState().fallbackOpen).toBe(false);
	});

	test("the fallback dialog also offers Interface settings and Hide work details", async () => {
		const { useInterfacePrefs } = await import(
			"@/src/interfaces/use-interface-prefs.ts"
		);
		const { useSettingsDialog } = await import(
			"@/src/store/useSettingsDialog.ts"
		);
		useInterfacePrefs.setState({ hideWorkDetails: false });
		await mount(<InterfaceSwitcherDialog canSwitchToConsole canSwitchToOs />);
		act(() => openInterfaceSwitcher());
		const hide = document.body.querySelector(
			'[data-testid="interface-switcher-hide-work-details"]'
		);
		expect(hide?.getAttribute("role")).toBe("switch");
		await click(hide);
		expect(useInterfacePrefs.getState().hideWorkDetails).toBe(true);
		await click(
			document.body.querySelector('[data-testid="interface-switcher-settings"]')
		);
		expect(useInterfaceSwitcher.getState().fallbackOpen).toBe(false);
		expect(useSettingsDialog.getState().open).toBe(true);
		useInterfacePrefs.setState({ hideWorkDetails: false });
	});

	test("the fallback dialog hides those rows without OS access", async () => {
		await mount(
			<InterfaceSwitcherDialog canSwitchToConsole canSwitchToOs={false} />
		);
		act(() => openInterfaceSwitcher());
		expect(
			document.body.querySelector('[data-testid="interface-switcher-settings"]')
		).toBeNull();
	});

	test("Switch Interface is Mod+Shift+U and clashes with no other shortcut", () => {
		const action = DESKTOP_HOTKEYS.find(
			(candidate) => candidate.id === "interface.switch"
		);
		expect(action?.defaultBinding).toBe("Mod+Shift+U");
		const clashes = [...findConflicts(DESKTOP_HOTKEYS, {}).values()].filter(
			(ids) => ids.includes("interface.switch")
		);
		expect(clashes).toEqual([]);
	});
});
