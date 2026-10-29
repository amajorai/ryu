import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, StrictMode } from "react";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { createRoot } = await import("react-dom/client");
const { builtinInterfaceId } = await import("@ryuhq/protocol/interfaces");
const { useInterfaceStore } = await import(
	"@/src/interfaces/interface-store.ts"
);
const { useInterfacePrefs } = await import(
	"@/src/interfaces/use-interface-prefs.ts"
);
const { useInterfaceSettings } = await import(
	"@/src/interfaces/use-interface-settings.ts"
);
const { useProductModeStore } = await import("@/src/lib/product-mode.ts");
const { InterfaceSettingsPanel } = await import("./InterfaceSettingsPanel.tsx");

const WORLD_3D = builtinInterfaceId("world-3d");
const roots: Root[] = [];

function render(): HTMLDivElement {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	roots.push(root);
	act(() => root.render(<InterfaceSettingsPanel />));
	return host;
}

function switchFor(host: HTMLElement, label: string): HTMLElement {
	const control = host.querySelector<HTMLElement>(
		`[role="switch"][aria-label="${label}"]`
	);
	if (!control) {
		throw new Error(`no switch labelled ${label}`);
	}
	return control;
}

beforeEach(() => {
	localStorage.clear();
	useProductModeStore.setState({ osAccess: true });
	useInterfaceStore.setState({ workspaceInterfaces: true });
	useInterfaceSettings.setState({ focusedId: WORLD_3D, overrides: {} });
	useInterfacePrefs.setState({ hideWorkDetails: false });
});

afterEach(() => {
	for (const root of roots.splice(0)) {
		act(() => root.unmount());
	}
	document.body.replaceChildren();
});

test("shows the focused interface's fields, kit settings included", () => {
	const host = render();
	expect(host.textContent).toContain("World 3D settings");
	expect(host.textContent).toContain("Overlay density");
	expect(host.textContent).toContain("Work bubbles");
	expect(switchFor(host, "Work bubbles").getAttribute("aria-checked")).toBe(
		"true"
	);
});

test("a change saves an override and Reset to defaults clears it", () => {
	const host = render();
	act(() => switchFor(host, "Work bubbles").click());
	expect(useInterfaceSettings.getState().overrides[WORLD_3D]).toEqual({
		workBubbles: false,
	});
	expect(switchFor(host, "Work bubbles").getAttribute("aria-checked")).toBe(
		"false"
	);
	const reset = host.querySelector<HTMLButtonElement>(
		'[data-testid="interface-settings-reset"]'
	);
	expect(reset?.disabled).toBe(false);
	act(() => reset?.click());
	expect(useInterfaceSettings.getState().overrides[WORLD_3D]).toBeUndefined();
	expect(switchFor(host, "Work bubbles").getAttribute("aria-checked")).toBe(
		"true"
	);
});

test("an interface without settings says so", () => {
	useInterfaceSettings.setState({ focusedId: builtinInterfaceId("inbox") });
	const host = render();
	expect(
		host.querySelector('[data-testid="interface-settings-empty"]')
	).not.toBeNull();
	expect(host.querySelector('[data-testid="interface-settings-reset"]')).toBe(
		null
	);
});

test("Hide work details is the shared interface preference", () => {
	const host = render();
	act(() => switchFor(host, "Hide work details").click());
	expect(useInterfacePrefs.getState().hideWorkDetails).toBe(true);
});

test("the switcher's entry opens the Interfaces sub-page", async () => {
	const { SETTINGS_ENTRIES, subpageFor } = await import(
		"@/src/lib/settings-index.ts"
	);
	const entry = SETTINGS_ENTRIES.find(
		(candidate) => candidate.id === "appearance.interfaces.interface"
	);
	expect(entry && subpageFor(entry)).toBe("interfaces");
	const chat = SETTINGS_ENTRIES.find(
		(candidate) => candidate.id === "appearance.chat.detail-level"
	);
	expect(chat && subpageFor(chat)).toBe("chat");
});

function typeInto(input: HTMLInputElement, text: string) {
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value"
	)?.set;
	setter?.call(input, text);
	input.dispatchEvent(
		new InputEvent("input", {
			bubbles: true,
			data: text,
			inputType: "insertText",
		})
	);
}

test("a number field keeps a partial value while typing and commits on blur", () => {
	const KNOWLEDGE = builtinInterfaceId("knowledge");
	useInterfaceSettings.setState({ focusedId: KNOWLEDGE, overrides: {} });
	const host = render();
	const input = host.querySelector<HTMLInputElement>(
		'input[aria-label="Link distance"]'
	);
	if (!input) {
		throw new Error("no Link distance input");
	}
	// "5" is under the 12 minimum but is on the way to "50".
	act(() => typeInto(input, "5"));
	expect(input.value).toBe("5");
	expect(useInterfaceSettings.getState().overrides[KNOWLEDGE]).toBeUndefined();
	act(() => typeInto(input, "50"));
	expect(input.value).toBe("50");
	act(() => {
		input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
	});
	expect(useInterfaceSettings.getState().overrides[KNOWLEDGE]).toEqual({
		linkDistance: 50,
	});
});

test("an out-of-range number draft reverts to the saved value on blur", () => {
	const KNOWLEDGE = builtinInterfaceId("knowledge");
	useInterfaceSettings.setState({ focusedId: KNOWLEDGE, overrides: {} });
	const host = render();
	const input = host.querySelector<HTMLInputElement>(
		'input[aria-label="Link distance"]'
	);
	if (!input) {
		throw new Error("no Link distance input");
	}
	act(() => typeInto(input, "5"));
	act(() => {
		input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
	});
	expect(input.value).toBe("30");
	expect(useInterfaceSettings.getState().overrides[KNOWLEDGE]).toBeUndefined();
});

test("the focused interface is cleared when the panel unmounts", () => {
	const KNOWLEDGE = builtinInterfaceId("knowledge");
	useInterfaceSettings.setState({ focusedId: KNOWLEDGE, overrides: {} });
	const root = roots[roots.push(createRoot(document.createElement("div"))) - 1];
	act(() => root.render(<InterfaceSettingsPanel />));
	expect(useInterfaceSettings.getState().focusedId).toBe(KNOWLEDGE);
	act(() => root.unmount());
	roots.pop();
	expect(useInterfaceSettings.getState().focusedId).toBeNull();
});

test("StrictMode's simulated remount keeps the interface the switcher focused", () => {
	const KNOWLEDGE = builtinInterfaceId("knowledge");
	useInterfaceSettings.setState({ focusedId: KNOWLEDGE, overrides: {} });
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	act(() =>
		root.render(
			<StrictMode>
				<InterfaceSettingsPanel />
			</StrictMode>
		)
	);
	expect(useInterfaceSettings.getState().focusedId).toBe(KNOWLEDGE);
	act(() => root.unmount());
	expect(useInterfaceSettings.getState().focusedId).toBeNull();
});
