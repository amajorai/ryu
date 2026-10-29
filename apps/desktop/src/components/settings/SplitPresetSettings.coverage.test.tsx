import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ContextType, type ReactNode } from "react";
import type { Root } from "react-dom/client";

// The REAL General → "Pane layouts" section, mounted in happy-dom over the real
// localStorage-backed preset store, next to the REAL split-view menu that lists
// and applies those presets (SplitPresetMenuItems → "Apply layout preset").
// Only the tab-arrangement callbacks of TabsContext are recorded instead of
// re-tiling real tabs; the menu's own logic and the store are untouched.
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register({ url: "http://localhost/" });
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { createRoot } = await import("react-dom/client");
const { ContextMenu, ContextMenuContent, ContextMenuTrigger } = await import(
	"@ryu/ui/components/context-menu.tsx"
);
const { TabsContext } = await import("@/src/contexts/TabsContext.tsx");
const { SplitPresetMenuItems } = await import(
	"@/src/components/layout/SplitPresetMenu.tsx"
);
const { BUILTIN_PRESETS } = await import("@/src/lib/splitPresets.ts");
const { SETTINGS_ENTRIES } = await import("@/src/lib/settings-index.ts");
const { SPLIT_PRESETS_KEY, useSplitPresetStore } = await import(
	"@/src/store/useSplitPresetStore.ts"
);
const componentSource =
	process.env.RYU_IBK_SPLIT_PRESET_SOURCE ?? "./SplitPresetSettings.tsx";
const { SplitPresetSettings } = (await import(
	componentSource
)) as typeof import("./SplitPresetSettings.tsx");

const RESEARCH = {
	createdAt: 1_700_000_000_000,
	id: "ibk:research",
	name: "Research workspace",
	root: {
		children: [{ path: "/workspace", type: "slot" }, { type: "slot" }],
		orientation: "columns",
		sizes: [0.4, 0.6],
		type: "branch",
	},
};
const REVIEW = {
	createdAt: 1_700_000_000_001,
	id: "ibk:review",
	name: "Review board",
	root: {
		children: [{ type: "slot" }, { type: "slot" }, { type: "slot" }],
		orientation: "rows",
		sizes: [0.3, 0.3, 0.4],
		type: "branch",
	},
};
const UNRELATED_KEY = "ryu_custom_themes";
const UNRELATED_VALUE = JSON.stringify([{ id: "keep-me" }]);

type Applied =
	| { kind: "new-tabs"; root: unknown }
	| { kind: "retile"; root: unknown; tabIds: string[] };
let applied: Applied[] = [];
const tabsValue = {
	applySplitPreset: (root: unknown, tabIds: string[]) => {
		applied.push({ kind: "retile", root, tabIds });
	},
	applySplitPresetToNewTabs: (root: unknown) => {
		applied.push({ kind: "new-tabs", root });
	},
	equalizeSplit: () => undefined,
	// SAFETY: SplitPresetMenuItems with `split={null}` reads only these three
	// callbacks from the tabs context; the rest of the tab model is not used.
} as unknown as NonNullable<ContextType<typeof TabsContext>>;

let settingsRoot: Root | null = null;
let settingsElement: HTMLDivElement | null = null;
let menuRoot: Root | null = null;
let menuElement: HTMLDivElement | null = null;

async function flush(ms = 20) {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, ms));
	});
}

async function settle(predicate: () => boolean, label: string) {
	const deadline = Date.now() + 3000;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error(`Condition not reached: ${label}`);
		}
		await flush(10);
	}
}

function render(element: HTMLDivElement, root: Root, node: ReactNode) {
	return act(async () => root.render(node)).then(() => element);
}

async function mountSettings() {
	settingsElement = document.createElement("div");
	document.body.append(settingsElement);
	settingsRoot = createRoot(settingsElement);
	await render(settingsElement, settingsRoot, <SplitPresetSettings />);
	await flush();
}

async function unmountSettings() {
	if (settingsRoot) {
		await act(async () => settingsRoot!.unmount());
	}
	settingsRoot = null;
	settingsElement?.remove();
	settingsElement = null;
}

/** Open the split view's real "Apply layout preset" submenu. */
async function openApplyMenu() {
	menuElement = document.createElement("div");
	document.body.append(menuElement);
	menuRoot = createRoot(menuElement);
	await render(
		menuElement,
		menuRoot,
		<TabsContext.Provider value={tabsValue}>
			<ContextMenu defaultOpen>
				<ContextMenuTrigger>split strip</ContextMenuTrigger>
				<ContextMenuContent>
					<SplitPresetMenuItems split={null} />
				</ContextMenuContent>
			</ContextMenu>
		</TabsContext.Provider>
	);
	const trigger = () =>
		Array.from(
			document.querySelectorAll<HTMLElement>('[role="menuitem"]')
		).find((item) => item.textContent?.trim() === "Apply layout preset");
	await settle(() => trigger() !== undefined, "Apply layout preset trigger");
	await act(async () => trigger()!.click());
	await settle(
		() => menuPresetNames().includes(BUILTIN_PRESETS[0]!.name),
		"preset submenu"
	);
}

async function closeApplyMenu() {
	if (menuRoot) {
		await act(async () => menuRoot!.unmount());
	}
	menuRoot = null;
	menuElement?.remove();
	menuElement = null;
}

/** Names listed by the split view's apply submenu, in order. */
function menuPresetNames() {
	return Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
		.map((item) => item.querySelector("span.flex-col > span.truncate"))
		.map((name) => name?.textContent?.trim())
		.filter((name): name is string => Boolean(name));
}

function userMenuNames() {
	const builtins = new Set(BUILTIN_PRESETS.map((preset) => preset.name));
	return menuPresetNames().filter((name) => !builtins.has(name));
}

function countRowText() {
	const title = Array.from(
		settingsElement!.querySelectorAll('[data-slot="item-title"]')
	).find((node) => node.textContent?.trim() === "Pane layout presets");
	return title
		?.closest('[data-slot="item"]')
		?.textContent?.replace("Pane layout presets", "")
		.trim();
}

function button(name: string) {
	const match = Array.from(
		settingsElement!.querySelectorAll<HTMLButtonElement>("button")
	).filter(
		(candidate) =>
			(candidate.getAttribute("aria-label") ??
				candidate.textContent?.trim()) === name
	);
	if (match.length !== 1) {
		throw new Error(`Expected one "${name}" button, found ${match.length}`);
	}
	return match[0]!;
}

function storedPresets(): unknown {
	const raw = localStorage.getItem(SPLIT_PRESETS_KEY);
	return raw === null ? null : JSON.parse(raw);
}

async function typeInto(input: HTMLInputElement, value: string) {
	await act(async () => {
		const setter = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)!.set!;
		setter.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

async function key(target: Element, name: string) {
	await act(async () => {
		target.dispatchEvent(
			new KeyboardEvent("keydown", {
				bubbles: true,
				cancelable: true,
				key: name,
			})
		);
	});
	await flush();
}

beforeEach(() => {
	localStorage.clear();
	applied = [];
	// The store was created at import with an empty collection; settings sync
	// later writes the key straight into storage without telling the store.
	useSplitPresetStore.setState({ presets: [] });
	localStorage.setItem(SPLIT_PRESETS_KEY, JSON.stringify([RESEARCH, REVIEW]));
	localStorage.setItem(UNRELATED_KEY, UNRELATED_VALUE);
});

afterEach(async () => {
	await closeApplyMenu();
	await unmountSettings();
	// Every case also proves an unrelated stored record is conserved.
	if (localStorage.getItem(UNRELATED_KEY) !== UNRELATED_VALUE) {
		throw new Error(`${UNRELATED_KEY} was changed`);
	}
});

test("Pane layout presets reads a synced collection on mount, is the settings-search anchor, and the split menu applies a renamed preset by its stored shape", async () => {
	// Before Settings mounts, the split menu still shows the stale store.
	await openApplyMenu();
	expect(userMenuNames()).toEqual([]);
	await closeApplyMenu();

	await mountSettings();
	expect(countRowText()).toBe("2 saved");
	const anchor = settingsElement!.querySelector(
		'[data-setting-id="general.tabs.split-layout-presets"]'
	);
	expect(anchor?.textContent).toContain("Pane layout presets");
	expect(
		SETTINGS_ENTRIES.find(
			(entry) => entry.id === "general.tabs.split-layout-presets"
		)?.label
	).toBe("Pane layout presets");
	expect(settingsElement!.textContent).toContain("2 panes · side by side");
	expect(settingsElement!.textContent).toContain("3 panes · stacked");

	// Rename from the keyboard: the field takes focus, Enter commits a trimmed name.
	await act(async () => button("Rename Research workspace").click());
	const field = settingsElement!.querySelector<HTMLInputElement>(
		'input[aria-label="New name for Research workspace"]'
	)!;
	expect(document.activeElement).toBe(field);
	await typeInto(field, "  Deep work  ");
	await key(field, "Enter");
	expect(storedPresets()).toEqual([{ ...RESEARCH, name: "Deep work" }, REVIEW]);
	expect(countRowText()).toBe("2 saved");

	await openApplyMenu();
	expect(userMenuNames()).toEqual(["Deep work", "Review board"]);
	const deepWork = Array.from(
		document.querySelectorAll<HTMLElement>('[role="menuitem"]')
	).find((item) => item.textContent?.includes("Deep work"))!;
	expect(deepWork.textContent).toContain("Opens 2 panes · side by side");
	await act(async () => deepWork.click());
	await flush();
	expect(applied).toEqual([{ kind: "new-tabs", root: RESEARCH.root }]);
});

test("deleting presets counts down to None saved yet, drops the stored key, conserves the other record, and the split menu stops offering them", async () => {
	await mountSettings();
	await act(async () => button("Delete Review board").click());
	expect(settingsElement!.textContent).toContain(
		"Delete “Review board”? Panes already open are not affected."
	);
	await act(async () => button("Cancel").click());
	expect(countRowText()).toBe("2 saved");
	expect(storedPresets()).toEqual([RESEARCH, REVIEW]);

	await act(async () => button("Delete Review board").click());
	await act(async () => button("Delete").click());
	expect(countRowText()).toBe("1 saved");
	expect(storedPresets()).toEqual([RESEARCH]);
	await openApplyMenu();
	expect(userMenuNames()).toEqual(["Research workspace"]);
	await closeApplyMenu();

	await act(async () => button("Delete Research workspace").click());
	await act(async () => button("Delete").click());
	expect(countRowText()).toBe("None saved yet");
	expect(localStorage.getItem(SPLIT_PRESETS_KEY)).toBeNull();
	await openApplyMenu();
	expect(userMenuNames()).toEqual([]);
	// Built-in layouts are never listed for management, and stay applicable.
	expect(menuPresetNames()).toEqual(
		BUILTIN_PRESETS.map((preset) => preset.name)
	);
	await closeApplyMenu();

	// A remount re-reads storage and agrees.
	await unmountSettings();
	await mountSettings();
	expect(countRowText()).toBe("None saved yet");
	for (const preset of BUILTIN_PRESETS) {
		expect(settingsElement!.textContent).not.toContain(`Rename ${preset.name}`);
	}
});
