import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { BackdropTab } = await import("./BackdropTab.tsx");
const { DEFAULT_WALLPAPER_PREFERENCE } = await import("@/src/lib/wallpaper.ts");

// The catalog's bare "Light" and "Space" are brightness and a region; the
// backdrop categories mean light effects and outer space.
const DE: Record<string, string> = {
	All: "Alle",
	Light: "Hell",
	"Light effects": "Lichteffekte",
	"Outer space": "Weltraum",
	Space: "Bereich",
};

afterEach(() => {
	registerLiteralCatalogLoader(null);
	document.body.innerHTML = "";
});

test("German backdrop category tabs name light effects and outer space", async () => {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("de") ? DE : {}));
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<I18nProvider initialLocale="de" initialPackId={null}>
				<BackdropTab
					preference={DEFAULT_WALLPAPER_PREFERENCE}
					update={() => undefined}
				/>
			</I18nProvider>
		);
	});
	// Let the catalog load and the DOM localizer pass settle.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});

	const tabs = [...container.querySelectorAll('[role="tab"]')].map((tab) =>
		tab.textContent?.trim()
	);
	// The localizer did run: the "All" tab is translated.
	expect(tabs).toContain("Alle");
	expect(tabs).toContain("Lichteffekte");
	expect(tabs).toContain("Weltraum");
	expect(tabs).not.toContain("Hell");
	expect(tabs).not.toContain("Bereich");

	await act(async () => root.unmount());
	container.remove();
});
