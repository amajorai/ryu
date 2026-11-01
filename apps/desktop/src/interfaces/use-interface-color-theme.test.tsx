// The active interface's colour theme becomes the temporary override, and
// leaving the interface (or turning the switch off) clears it. While
// Marketplace interfaces are still loading, the persisted override is kept so
// a cold start does not flash the user's preset.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { InterfaceDescriptor } from "@ryuhq/protocol/interfaces";
import { act } from "react";
import type { Root } from "react-dom/client";

interface QueryState {
	data: { interfaces?: InterfaceDescriptor[] } | undefined;
	isPending: boolean;
}

let queryState: QueryState = { data: undefined, isPending: true };
const realContributions = await import("@/src/hooks/usePluginContributions.ts");
mock.module("@/src/hooks/usePluginContributions.ts", () => ({
	...realContributions,
	usePluginContributionsQuery: () => queryState,
}));

const { createRoot } = await import("react-dom/client");
const { useInterfaceStore } = await import("./interface-store.ts");
const { BOT_INTERFACE, OS_INTERFACE, provisionalInterfaces } = await import(
	"./registry.ts"
);
const { useProductModeStore } = await import("@/src/lib/product-mode.ts");
const { setPersistedToggle } = await import(
	"@/src/hooks/usePersistedToggle.ts"
);
const {
	getThemeOverride,
	INTERFACE_COLOR_THEMES_KEY,
	setThemeOverride,
	THEME_OVERRIDE_STORAGE_KEY,
} = await import("@/src/lib/themes/theme-override.ts");
const { nextThemeOverride, useInterfaceColorThemeSync } = await import(
	"./use-interface-color-theme.ts"
);

const TOWN_ID = "@acme/pixel-town:town";
const TOWN: InterfaceDescriptor = {
	colorTheme: { dark: "catppuccin-dark", light: "catppuccin-light" },
	description: "A tiny town.",
	id: TOWN_ID,
	label: "Pixel Town",
	origin: "marketplace",
	params: {},
	plugin: "@acme/pixel-town",
	renderer: "channels",
};
const PLAIN: InterfaceDescriptor = {
	...TOWN,
	colorTheme: undefined,
	id: "@acme/plain:plain",
	label: "Plain",
};
const TOWN_OVERRIDE = {
	dark: "catppuccin-dark",
	label: "Pixel Town",
	light: "catppuccin-light",
	plugin: "@acme/pixel-town",
	source: TOWN_ID,
};
const WORKSPACE = { productMode: "os", workspaceInterfaceId: TOWN_ID } as const;

describe("nextThemeOverride", () => {
	test("an interface with a colour theme asks for it", () => {
		expect(
			nextThemeOverride({
				active: TOWN,
				current: null,
				enabled: true,
				loading: false,
				...WORKSPACE,
			})
		).toEqual(TOWN_OVERRIDE);
	});

	test("an interface without one, or the switch off, clears it", () => {
		const base = { current: TOWN_OVERRIDE, loading: false, ...WORKSPACE };
		expect(nextThemeOverride({ ...base, active: PLAIN, enabled: true })).toBe(
			null
		);
		expect(nextThemeOverride({ ...base, active: TOWN, enabled: false })).toBe(
			null
		);
	});

	test("a pending placeholder keeps the current override", () => {
		const [placeholder] = provisionalInterfaces(true, TOWN_ID);
		if (!placeholder) {
			throw new Error("no placeholder");
		}
		expect(
			nextThemeOverride({
				active: placeholder,
				current: TOWN_OVERRIDE,
				enabled: true,
				loading: false,
				...WORKSPACE,
			})
		).toEqual(TOWN_OVERRIDE);
	});

	test("loading keeps it only for the interface about to render", () => {
		const base = {
			active: BOT_INTERFACE,
			current: TOWN_OVERRIDE,
			enabled: true,
			loading: true,
		};
		expect(nextThemeOverride({ ...base, ...WORKSPACE })).toEqual(TOWN_OVERRIDE);
		expect(
			nextThemeOverride({ ...base, ...WORKSPACE, productMode: "bot" })
		).toBeNull();
		expect(
			nextThemeOverride({ ...base, ...WORKSPACE, productMode: "console" })
		).toBeNull();
		expect(
			nextThemeOverride({
				...base,
				...WORKSPACE,
				workspaceInterfaceId: OS_INTERFACE.id,
			})
		).toBeNull();
	});
});

const roots: Root[] = [];

function Probe() {
	useInterfaceColorThemeSync();
	return null;
}

function mount(): Root {
	const root = createRoot(document.createElement("div"));
	roots.push(root);
	act(() => root.render(<Probe />));
	return root;
}

function rerender(root: Root) {
	act(() => root.render(<Probe />));
}

beforeEach(() => {
	localStorage.clear();
	setThemeOverride(null);
	useProductModeStore.setState({ osAccess: true, requestedMode: "os" });
	useInterfaceStore.setState({
		contributed: [],
		workspaceInterfaceId: TOWN_ID,
		workspaceInterfaces: true,
	});
	queryState = { data: undefined, isPending: true };
});

afterEach(() => {
	for (const root of roots.splice(0)) {
		act(() => root.unmount());
	}
});

describe("useInterfaceColorThemeSync", () => {
	test("keeps the persisted override while contributions load", () => {
		setThemeOverride(TOWN_OVERRIDE);
		mount();
		expect(getThemeOverride()).toEqual(TOWN_OVERRIDE);
	});

	test("sets the override once the active interface resolves", () => {
		const root = mount();
		expect(getThemeOverride()).toBeNull();
		queryState = { data: { interfaces: [TOWN, PLAIN] }, isPending: false };
		rerender(root);
		expect(getThemeOverride()).toEqual(TOWN_OVERRIDE);
	});

	test("switching interfaces or turning the switch off clears it", () => {
		queryState = { data: { interfaces: [TOWN, PLAIN] }, isPending: false };
		mount();
		expect(getThemeOverride()).toEqual(TOWN_OVERRIDE);

		act(() => setPersistedToggle(INTERFACE_COLOR_THEMES_KEY, false));
		expect(getThemeOverride()).toBeNull();
		act(() => setPersistedToggle(INTERFACE_COLOR_THEMES_KEY, true));
		expect(getThemeOverride()).toEqual(TOWN_OVERRIDE);

		act(() => useInterfaceStore.setState({ workspaceInterfaceId: PLAIN.id }));
		expect(getThemeOverride()).toBeNull();
	});

	test("a startup realm other than the interface drops the persisted one", () => {
		setThemeOverride(TOWN_OVERRIDE);
		useProductModeStore.setState({ requestedMode: "bot" });
		mount();
		expect(getThemeOverride()).toBeNull();
	});

	test("unmounting ends the override and restores the user's preset", () => {
		queryState = { data: { interfaces: [TOWN, PLAIN] }, isPending: false };
		const root = mount();
		expect(getThemeOverride()).toEqual(TOWN_OVERRIDE);
		act(() => root.unmount());
		roots.splice(roots.indexOf(root), 1);
		expect(getThemeOverride()).toBeNull();
		expect(localStorage.getItem(THEME_OVERRIDE_STORAGE_KEY)).toBeNull();
	});

	test("a remembered interface that is gone clears a stale override", () => {
		setThemeOverride(TOWN_OVERRIDE);
		queryState = { data: { interfaces: [] }, isPending: false };
		mount();
		expect(getThemeOverride()).toBeNull();
	});
});
