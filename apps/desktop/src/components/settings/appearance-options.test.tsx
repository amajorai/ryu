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
const { FILE_TREE_ICON_OPTIONS } = await import("./appearance-options.tsx");

// "Complete" is the finished-state word (完了, Abgeschlossen, مكتمل). The icon
// set that ships every glyph is a "Full set", so it never reads as a status.
const STUBS: Record<string, Record<string, string>> = {
	ar: { Complete: "مكتمل", "Full set": "المجموعة الكاملة" },
	de: { Complete: "Abgeschlossen", "Full set": "Vollständiger Satz" },
	ja: { Complete: "完了", "Full set": "フルセット" },
};

afterEach(() => {
	registerLiteralCatalogLoader(null);
	document.body.innerHTML = "";
});

async function renderIconOptions(locale: string): Promise<string> {
	registerLiteralCatalogLoader((requested) => STUBS[requested] ?? {});
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				<ul>
					{FILE_TREE_ICON_OPTIONS.map((option) => (
						<li data-value={option.value} key={option.value}>
							{option.label}
						</li>
					))}
				</ul>
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	const text =
		container.querySelector('[data-value="complete"]')?.textContent ?? "";
	await act(async () => root.unmount());
	container.remove();
	return text;
}

test("the complete icon set keeps its stored value under a 'Full set' label", () => {
	const option = FILE_TREE_ICON_OPTIONS.find(
		(candidate) => candidate.value === "complete"
	);
	expect(option?.label).toBe("Full set");
});

test.each([
	["ja", "フルセット", "完了"],
	["de", "Vollständiger Satz", "Abgeschlossen"],
	["ar", "المجموعة الكاملة", "مكتمل"],
])("the %s icon-set option names the full set, not a finished state", async (locale, fullSet, finished) => {
	const text = await renderIconOptions(locale);
	expect(text).toBe(fullSet);
	expect(text).not.toBe(finished);
});
