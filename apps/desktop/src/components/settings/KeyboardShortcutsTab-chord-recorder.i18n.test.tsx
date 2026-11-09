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
const { ChordCaps } = await import("./KeyboardShortcutsTab-chord-recorder.tsx");

// Stub catalogs: the bare tokens carry the wrong (non-keyboard) sense the
// real catalog has, and the key-sense messages carry the right one.
const CATALOGS: Record<string, Record<string, string>> = {
	ar: { Space: "المساحة", "Space key": "مفتاح المسافة" },
	de: {
		"Ctrl key": "Strg",
		Shift: "Umschalt",
		"Shift key": "Umschalt",
		Space: "Bereich",
		"Space key": "Leertaste",
	},
	ja: { Down: "停止中", Up: "稼働中" },
};

async function renderCaps(
	locale: string,
	chord: string
): Promise<{ container: HTMLDivElement; unmount: () => Promise<void> }> {
	registerLiteralCatalogLoader((requested) => {
		const base = requested.split("-")[0] ?? requested;
		return CATALOGS[base] ?? {};
	});
	const container = document.createElement("div");
	if (locale === "ar") {
		container.setAttribute("dir", "rtl");
	}
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				<ChordCaps chord={chord} />
			</I18nProvider>
		);
	});
	// Let the catalog load and the DOM localizer pass settle.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	return {
		container,
		unmount: async () => {
			await act(async () => root.unmount());
			container.remove();
		},
	};
}

function capTexts(container: HTMLElement): string[] {
	return [...container.querySelectorAll("kbd")].map(
		(cap) => cap.textContent ?? ""
	);
}

afterEach(() => {
	registerLiteralCatalogLoader(null);
	document.body.innerHTML = "";
});

test("ja: an arrow keycap is a glyph, never the status sense of Down", async () => {
	const { container, unmount } = await renderCaps("ja", "Mod+Alt+Down");
	const caps = capTexts(container);
	expect(caps).toContain("↓");
	expect(container.textContent).not.toContain("停止中");
	expect(container.textContent).not.toContain("Down");
	for (const cap of container.querySelectorAll("kbd")) {
		expect(cap.getAttribute("data-ryu-i18n")).toBe("off");
		expect(cap.getAttribute("translate")).toBe("no");
	}
	await unmount();
});

test("de: Space renders as the key, not the region sense", async () => {
	const { container, unmount } = await renderCaps("de", "Mod+Shift+Space");
	expect(capTexts(container)).toEqual(["Strg", "Umschalt", "Leertaste"]);
	expect(container.textContent).not.toContain("Bereich");
	await unmount();
});

test("ar: Space renders as the key, not the area sense", async () => {
	const { container, unmount } = await renderCaps("ar", "Space");
	expect(capTexts(container)).toEqual(["مفتاح المسافة"]);
	expect(container.textContent).not.toContain("المساحة");
	await unmount();
});
