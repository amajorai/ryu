import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { HotkeyRegistry } from "@ryu/hotkeys/registry";
import type {
	OsApp,
	OsDesktopSurfaceProps,
	OsWindow,
} from "./OsDesktopSurface.tsx";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const nativeMatchMedia = window.matchMedia.bind(window);
Reflect.set(window, "matchMedia", (query: string) => {
	const result = nativeMatchMedia(query);
	if (query.includes("prefers-reduced-motion")) {
		Reflect.set(result, "matches", true);
	}
	return result;
});

const originalFetch = globalThis.fetch;
const originalWindowFetch = window.fetch;
const offlineFetch = async () => new Response("[]", { status: 200 });
Reflect.set(globalThis, "fetch", offlineFetch);
Reflect.set(window, "fetch", offlineFetch);

const React = await import("react");
const { act, createElement, Fragment, useState } = React;
const { createRoot } = await import("react-dom/client");
const { HotkeysProvider, useHotkey, useHotkeysAdmin } = await import(
	"@ryu/hotkeys/react"
);
const { DESKTOP_HOTKEYS } = await import("../../lib/hotkeys/actions.ts");
const { OsDesktopSurface } = await import("./OsDesktopSurface.tsx");

/** The desktop binds Mod+K to its search-everything palette through @ryu/hotkeys. */
const APP_PALETTE_HOTKEYS: HotkeyRegistry = [
	{
		category: "General",
		defaultBinding: "Mod+K",
		id: "command-palette.toggle",
		label: "Toggle Command Palette",
	},
];

/** Mounts children under a HotkeysProvider, as the desktop Layout does. */
function withHotkeys(
	registry: HotkeyRegistry,
	...children: ReturnType<typeof createElement>[]
) {
	return createElement(HotkeysProvider, {
		children: createElement(Fragment, null, ...children),
		registry,
	});
}

/** Stands in for the desktop's command palette: counts each Mod+K it receives. */
function AppPaletteProbe({ onToggle }: { onToggle: () => void }) {
	useHotkey("command-palette.toggle", onToggle);
	return null;
}

async function pressModK(target: EventTarget = window): Promise<void> {
	await act(async () => {
		target.dispatchEvent(
			new KeyboardEvent("keydown", {
				bubbles: true,
				cancelable: true,
				key: "k",
				metaKey: true,
			})
		);
		await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
	});
}

function launcherIsOpen(): boolean {
	return (
		document.querySelector(
			'[role="dialog"] [data-testid="app-launcher-dialog"]'
		) !== null
	);
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let originalRandom: () => number;

const sampleWindows: OsWindow[] = [
	{
		content: createElement("main", null, "Chat content"),
		id: "chat-window",
		path: "/chat",
		title: "Chat",
	},
	{
		content: createElement("main", null, "Spaces content"),
		id: "spaces-window",
		path: "/library/space",
		title: "Spaces",
	},
];

function renderSurface(overrides: Partial<OsDesktopSurfaceProps> = {}): void {
	const baseProps: OsDesktopSurfaceProps = {
		activeWindowId: "chat-window",
		onActivateWindow: () => undefined,
		onCloseWindow: () => undefined,
		onOpenApp: () => undefined,
		windows: sampleWindows,
		...overrides,
	};

	function WorkspaceHarness() {
		const [activeWindowId, setActiveWindowId] = useState(
			baseProps.activeWindowId
		);
		return createElement(OsDesktopSurface, {
			...baseProps,
			activeWindowId,
			onActivateWindow: (id: string) => {
				baseProps.onActivateWindow(id);
				setActiveWindowId(id);
			},
		});
	}

	// The desktop mounts Ryu OS under its one HotkeysProvider and real registry.
	act(() =>
		root.render(withHotkeys(DESKTOP_HOTKEYS, createElement(WorkspaceHarness)))
	);
}

function requiredElement<ElementType extends Element>(
	selector: string,
	parent: ParentNode = document
): ElementType {
	const element = parent.querySelector<ElementType>(selector);
	if (!element) {
		throw new Error(`Missing test element: ${selector}`);
	}
	return element;
}

function elementByExactText(
	selector: string,
	text: string,
	parent: ParentNode = document
): HTMLElement {
	for (const element of parent.querySelectorAll<HTMLElement>(selector)) {
		if (element.textContent?.trim() === text) {
			return element;
		}
	}
	throw new Error(`Missing ${selector} with exact text: ${text}`);
}

function elementContainingText(
	selector: string,
	text: string,
	parent: ParentNode = document
): HTMLElement {
	for (const element of parent.querySelectorAll<HTMLElement>(selector)) {
		if (element.textContent?.includes(text)) {
			return element;
		}
	}
	throw new Error(`Missing ${selector} containing text: ${text}`);
}

async function click(element: Element): Promise<void> {
	if (!(element instanceof HTMLElement)) {
		throw new Error("The selected action is not an HTML control");
	}
	await act(async () => {
		if (!(element instanceof HTMLElement)) {
			throw new Error("Click target must be an HTML element");
		}
		element.click();
		await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
	});
}

async function openMenu(label: "OS" | "Window" | "View"): Promise<HTMLElement> {
	const trigger = elementByExactText(
		'[data-testid="ryu-os-menubar"] [data-slot="menubar-trigger"]',
		label
	);
	if (trigger.getAttribute("aria-expanded") !== "true") {
		await click(trigger);
	}
	return requiredElement<HTMLElement>('[role="menu"]');
}

function requiredLauncherDialog(): HTMLElement {
	return requiredElement<HTMLElement>(
		'[role="dialog"] [data-testid="app-launcher-dialog"]'
	);
}

beforeEach(() => {
	originalRandom = Math.random;
	Math.random = () => 0;
	localStorage.clear();
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	document.body.replaceChildren();
	localStorage.clear();
	Math.random = originalRandom;
});

afterAll(() => {
	Reflect.set(globalThis, "fetch", originalFetch);
	Reflect.set(window, "fetch", originalWindowFetch);
});

test("the OS menubar opens the App Launcher and selecting an App calls its route", async () => {
	const openedApps: OsApp[] = [];
	renderSurface({ onOpenApp: (app) => openedApps.push(app) });

	const ryuOsMenu = await openMenu("OS");
	expect(ryuOsMenu.textContent).toContain("App Launcher");
	await click(
		requiredElement('[data-testid="app-launcher-menu-item"]', ryuOsMenu)
	);

	const dialog = requiredLauncherDialog();
	expect(dialog.textContent).toContain("Current Apps");
	expect(dialog.textContent).toContain("Open windows");
	expect(
		requiredElement(
			'[data-testid="app-launcher-app-chat"]',
			dialog
		).getAttribute("data-open")
	).toBe("true");
	expect(
		requiredElement(
			'[data-testid="app-launcher-app-tools"]',
			dialog
		).getAttribute("data-open")
	).toBe("false");

	await click(
		requiredElement('[data-testid="app-launcher-app-tools"]', dialog)
	);
	expect(openedApps).toHaveLength(1);
	expect(openedApps[0]).toMatchObject({ id: "tools", path: "/tools" });
	expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test("Window menu and live window cards activate, minimize, restore, maximize, and close windows", async () => {
	const activations: string[] = [];
	const closed: string[] = [];
	renderSurface({
		onActivateWindow: (id) => activations.push(id),
		onCloseWindow: (id) => closed.push(id),
	});

	const windowMenu = await openMenu("Window");
	await click(elementByExactText('[role="menuitem"]', "Spaces", windowMenu));
	expect(activations.at(-1)).toBe("spaces-window");
	expect(
		requiredElement('[data-testid="os-window-spaces-window"]').getAttribute(
			"data-active"
		)
	).toBe("true");

	await click(
		requiredElement('[data-testid="os-window-chat-window-minimize"]')
	);
	expect(
		requiredElement('[data-testid="os-window-chat-window"]').getAttribute(
			"data-minimized"
		)
	).toBe("true");
	expect(activations.at(-1)).toBe("spaces-window");

	await click(requiredElement('[data-testid="os-dock-app-launcher"]'));
	const dialog = requiredLauncherDialog();
	await click(
		requiredElement('[data-testid="app-launcher-window-chat-window"]', dialog)
	);
	expect(activations.at(-1)).toBe("chat-window");
	expect(
		requiredElement('[data-testid="os-window-chat-window"]').getAttribute(
			"data-minimized"
		)
	).toBe("false");
	expect(
		requiredElement('[data-testid="os-window-chat-window"]').getAttribute(
			"data-active"
		)
	).toBe("true");
	expect(document.querySelector('[role="dialog"]')).toBeNull();

	const chatArticle = requiredElement<HTMLElement>(
		'[data-testid="os-window-chat-window"]'
	);
	await act(async () => {
		chatArticle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
	});
	expect(activations.at(-1)).toBe("chat-window");

	await click(
		requiredElement('[data-testid="os-window-chat-window-maximize"]')
	);
	expect(chatArticle.getAttribute("data-maximized")).toBe("true");
	expect(requiredElement('button[aria-label="Restore Chat"]').textContent).toBe(
		""
	);
	await click(
		requiredElement('[data-testid="os-window-chat-window-maximize"]')
	);
	expect(chatArticle.getAttribute("data-maximized")).toBe("false");

	await click(requiredElement('[data-testid="os-window-chat-window-close"]'));
	expect(closed).toEqual(["chat-window"]);
});

test("View menu selects a wallpaper set and both shuffle controls stay in that set", async () => {
	renderSurface();
	let viewMenu = await openMenu("View");
	// The real wallpaper owner keeps a random session pick from module startup.
	// Move through a disjoint set so the Quiet places transition has a known
	// previous scope instead of depending on that startup pick.
	const goldenGate = elementByExactText(
		'[role="menuitemradio"]',
		"Golden Gate",
		viewMenu
	);
	await click(goldenGate);
	expect(goldenGate.getAttribute("aria-checked")).toBe("true");
	const selectedGoldenGateWallpaper = requiredElement<HTMLElement>(
		"[data-wallpaper-id]"
	).getAttribute("data-wallpaper-id");
	if (!selectedGoldenGateWallpaper) {
		throw new Error("Selected wallpaper has no identity");
	}
	expect(["golden-gate-day", "golden-gate-dusk"]).toContain(
		selectedGoldenGateWallpaper
	);
	viewMenu = await openMenu("View");
	const quietPlaces = elementByExactText(
		'[role="menuitemradio"]',
		"Quiet places",
		viewMenu
	);
	await click(quietPlaces);
	expect(quietPlaces.getAttribute("aria-checked")).toBe("true");
	expect(
		requiredElement<HTMLElement>("[data-wallpaper-id]").getAttribute(
			"data-wallpaper-id"
		)
	).toBe("deep-forest");

	viewMenu = await openMenu("View");
	await click(
		elementContainingText('[role="menuitem"]', "Shuffle wallpaper", viewMenu)
	);
	expect(
		requiredElement<HTMLElement>("[data-wallpaper-id]").getAttribute(
			"data-wallpaper-id"
		)
	).toBe("golden-trees");

	await click(requiredElement('[data-testid="os-wallpaper-shuffle"]'));
	expect(
		requiredElement<HTMLElement>("[data-wallpaper-id]").getAttribute(
			"data-wallpaper-id"
		)
	).toBe("deep-forest");
});

test("Customize desktop menu and toolbar persist settings and report dialog open state", async () => {
	renderSurface();
	const viewMenu = await openMenu("View");
	await click(
		elementByExactText('[role="menuitem"]', "Customize desktop…", viewMenu)
	);
	let dialog = requiredElement<HTMLElement>('[role="dialog"]');
	expect(dialog.textContent).toContain(
		"Choose your wallpaper and what appears on the OS home."
	);

	const clockSwitch = requiredElement<HTMLElement>(
		'[data-slot="switch"][aria-label="Clock"]',
		dialog
	);
	expect(clockSwitch.getAttribute("aria-checked")).toBe("true");
	await click(clockSwitch);
	expect(clockSwitch.getAttribute("aria-checked")).toBe("false");
	expect(localStorage.getItem("ryu:os-home:clock")).toBe("false");

	await act(async () => {
		document.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
		);
		await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
	});
	expect(document.querySelector('[role="dialog"]')).toBeNull();

	await click(requiredElement('button[aria-label="Customize desktop"]'));
	dialog = requiredElement<HTMLElement>('[role="dialog"]');
	expect(
		requiredElement(
			'[data-slot="switch"][aria-label="Clock"]',
			dialog
		).getAttribute("aria-checked")
	).toBe("false");
});

test("Dock App selection opens its existing route and Command-K opens and dismisses the launcher", async () => {
	const openedApps: OsApp[] = [];
	const activations: string[] = [];
	renderSurface({
		onActivateWindow: (id) => activations.push(id),
		onOpenApp: (app) => openedApps.push(app),
	});

	await click(requiredElement('[data-testid="os-dock-chat"]'));
	expect(activations).toEqual(["chat-window"]);
	expect(openedApps[0]).toMatchObject({ id: "chat", path: "/chat" });

	await pressModK();
	expect(requiredLauncherDialog().textContent).toContain("Open windows");
	await pressModK();
	expect(launcherIsOpen()).toBe(false);
	await pressModK();
	expect(launcherIsOpen()).toBe(true);

	await act(async () => {
		document.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
		);
		await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
	});
	expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test("one Mod+K opens exactly one surface when the app palette and the OS launcher are both mounted", async () => {
	let paletteToggles = 0;
	act(() =>
		root.render(
			withHotkeys(
				APP_PALETTE_HOTKEYS,
				createElement(AppPaletteProbe, {
					onToggle: () => {
						paletteToggles += 1;
					},
				}),
				createElement(OsDesktopSurface, {
					activeWindowId: "chat-window",
					onActivateWindow: () => undefined,
					onCloseWindow: () => undefined,
					onOpenApp: () => undefined,
					windows: sampleWindows,
				})
			)
		)
	);

	await pressModK(requiredElement('[data-testid="ryu-os-desktop"]'));
	// The launcher answers the palette action through the one dispatcher, so
	// the action has a single owner and a single surface toggles.
	expect({ launcherOpen: launcherIsOpen(), paletteToggles }).toEqual({
		launcherOpen: true,
		paletteToggles: 0,
	});
});

/** Rebinds or clears the palette action, as Keyboard Shortcuts settings does. */
function PaletteBindingControls() {
	const admin = useHotkeysAdmin();
	return createElement(
		"div",
		null,
		createElement(
			"button",
			{
				onClick: () =>
					admin.setOverride("command-palette.toggle", "Mod+Shift+L"),
				type: "button",
			},
			"Rebind palette"
		),
		createElement(
			"button",
			{
				onClick: () => admin.setOverride("command-palette.toggle", null),
				type: "button",
			},
			"Clear palette"
		)
	);
}

test("launcher hints and the chord follow the palette action's binding", async () => {
	act(() =>
		root.render(
			withHotkeys(
				DESKTOP_HOTKEYS,
				createElement(PaletteBindingControls),
				createElement(OsDesktopSurface, {
					activeWindowId: "chat-window",
					onActivateWindow: () => undefined,
					onCloseWindow: () => undefined,
					onOpenApp: () => undefined,
					windows: sampleWindows,
				})
			)
		)
	);
	const launcherMenuItem = async () =>
		requiredElement<HTMLElement>(
			'[data-testid="app-launcher-menu-item"]',
			await openMenu("OS")
		);
	const closeMenu = () =>
		act(async () => {
			document.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
			);
			await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
		});

	let item = await launcherMenuItem();
	expect(item.getAttribute("aria-keyshortcuts")).toBe("Control+K Meta+K");
	expect(
		requiredElement('[data-slot="menubar-shortcut"]', item).textContent
	).toMatch(/^(⌘K|Ctrl\+K)$/);
	await closeMenu();

	await click(elementByExactText("button", "Rebind palette"));
	await pressModK();
	expect(launcherIsOpen()).toBe(false);
	await act(async () => {
		window.dispatchEvent(
			new KeyboardEvent("keydown", {
				bubbles: true,
				cancelable: true,
				key: "L",
				metaKey: true,
				shiftKey: true,
			})
		);
		await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
	});
	expect(launcherIsOpen()).toBe(true);
	await closeMenu();
	expect(launcherIsOpen()).toBe(false);
	item = await launcherMenuItem();
	expect(item.getAttribute("aria-keyshortcuts")).toBe(
		"Control+Shift+L Meta+Shift+L"
	);
	await closeMenu();

	await click(elementByExactText("button", "Clear palette"));
	item = await launcherMenuItem();
	expect(item.hasAttribute("aria-keyshortcuts")).toBe(false);
	expect(item.querySelector('[data-slot="menubar-shortcut"]')).toBeNull();
});

test("outside a hotkey provider the launcher binds no chord", async () => {
	act(() =>
		root.render(
			createElement(OsDesktopSurface, {
				activeWindowId: "chat-window",
				onActivateWindow: () => undefined,
				onCloseWindow: () => undefined,
				onOpenApp: () => undefined,
				windows: sampleWindows,
			})
		)
	);
	await pressModK();
	expect(launcherIsOpen()).toBe(false);
});

test("Customize desktop toolbar opens the saved settings dialog", async () => {
	renderSurface();
	await click(requiredElement('button[aria-label="Customize desktop"]'));
	const dialog = requiredElement<HTMLElement>('[role="dialog"]');
	expect(dialog.textContent).toContain(
		"Your choices are saved on this device."
	);
	expect(
		requiredElement(
			'[data-slot="switch"][aria-label="Welcome text"]',
			dialog
		).getAttribute("aria-checked")
	).toBe("true");
	await act(async () => {
		document.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
		);
		await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
	});
	expect(document.querySelector('[role="dialog"]')).toBeNull();
});
