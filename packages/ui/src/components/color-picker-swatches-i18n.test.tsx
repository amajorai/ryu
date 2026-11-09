import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// The swatch group headings are catalog copy the picker translates itself, so
// "Recent colors" and "Swatches" read in the UI language.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { ColorPicker, ColorPickerContent, ColorPickerPanel } = await import(
	"./color-picker.tsx"
);

const DE: Record<string, string> = {
	"Select {group} {value}": "{group} {value} auswählen",
	Swatches: "Farbfelder",
};

let mounted: { container: HTMLElement; root: Root } | undefined;
afterEach(async () => {
	registerLiteralCatalogLoader(null);
	if (mounted) {
		const { container, root } = mounted;
		await act(async () => {
			root.unmount();
		});
		container.remove();
		mounted = undefined;
	}
});
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

function picker() {
	return (
		<ColorPicker
			defaultValue="#000000"
			inline
			showRecentColors={false}
			swatches={["#ff3b30"]}
		>
			<ColorPickerContent>
				<ColorPickerPanel />
			</ColorPickerContent>
		</ColorPicker>
	);
}

test("the swatch group heading renders in German", async () => {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("de") ? DE : {}));
	const container = document.createElement("div");
	// Only the picker's own translation counts, not the DOM localizer's pass.
	container.setAttribute("data-ryu-i18n", "off");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	const render = () =>
		root.render(
			<I18nProvider initialLocale="de" initialPackId={null}>
				{picker()}
			</I18nProvider>
		);
	await act(async () => render());
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	await act(async () => render());

	const group = container.querySelector(
		'[data-slot="color-picker-swatches"] [role="group"]'
	);
	expect(group?.getAttribute("aria-label")).toBe("Farbfelder");
	expect(group?.textContent).toBe("Farbfelder");
	expect(container.textContent).not.toContain("Swatches");
	// The swatch button splices the translated heading into its sentence
	// with the translator's casing, not a lowercased "farbfelder".
	const swatch = container.querySelector(
		'[data-slot="color-picker-swatch-button"]'
	);
	expect(swatch?.getAttribute("aria-label")).toBe(
		"Farbfelder #FF3B30 auswählen"
	);
});

test("the swatch button keeps English sentence casing", async () => {
	const container = document.createElement("div");
	container.setAttribute("data-ryu-i18n", "off");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () =>
		root.render(
			<I18nProvider initialLocale="en" initialPackId={null}>
				{picker()}
			</I18nProvider>
		)
	);
	const swatch = container.querySelector(
		'[data-slot="color-picker-swatch-button"]'
	);
	expect(swatch?.getAttribute("aria-label")).toBe("Select swatches #FF3B30");
	expect(container.textContent).toContain("Swatches");
});
