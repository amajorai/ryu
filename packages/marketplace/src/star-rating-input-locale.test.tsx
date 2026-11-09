// The interactive StarRatingInput under Japanese, Arabic and German UIs: the
// radiogroup's default accessible name and the empty-selection live region go
// through the translator instead of staying English.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { StarRatingInput } = await import("./star-rating.tsx");

const STUB_CATALOGS: Record<string, Record<string, string>> = {
	ar: { "No rating selected": "لم يتم اختيار تقييم", Rating: "التقييم" },
	de: {
		"No rating selected": "Keine Bewertung ausgewählt",
		Rating: "Bewertung",
	},
	ja: { "No rating selected": "評価が選択されていません", Rating: "評価" },
};

const roots: Root[] = [];

async function renderPicker(
	locale: string,
	label?: string
): Promise<HTMLElement> {
	registerLiteralCatalogLoader(
		(requested) => STUB_CATALOGS[requested.split("-")[0] ?? ""] ?? {}
	);
	const mount = document.createElement("div");
	document.body.append(mount);
	const root = createRoot(mount);
	roots.push(root);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale={locale}
				initialPackId={null}
			>
				<StarRatingInput label={label} onChange={() => undefined} value={0} />
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	return mount;
}

afterEach(async () => {
	for (const root of roots.splice(0)) {
		await act(async () => {
			root.unmount();
		});
	}
	registerLiteralCatalogLoader(null);
	document.body.innerHTML = "";
});

describe("StarRatingInput default name and empty state", () => {
	for (const [locale, catalog] of Object.entries(STUB_CATALOGS)) {
		test(`${locale} translates the radiogroup name and empty state`, async () => {
			const mount = await renderPicker(locale);
			const group = mount.querySelector("[role=radiogroup]");
			expect(group?.getAttribute("aria-label")).toBe(catalog.Rating);
			const live = mount.querySelector("[aria-live=polite]");
			expect(live?.textContent).toBe(catalog["No rating selected"]);
		});
	}

	test("a caller-supplied label is kept as given", async () => {
		const mount = await renderPicker("de", "Gesamteindruck");
		const group = mount.querySelector("[role=radiogroup]");
		expect(group?.getAttribute("aria-label")).toBe("Gesamteindruck");
	});

	test("English keeps the source strings", async () => {
		const mount = await renderPicker("en");
		const group = mount.querySelector("[role=radiogroup]");
		expect(group?.getAttribute("aria-label")).toBe("Rating");
		const live = mount.querySelector("[aria-live=polite]");
		expect(live?.textContent).toBe("No rating selected");
	});
});
