// The category page names its Store shelf in the breadcrumb and the heading.
// A shelf name is English catalog copy, so a Japanese reader sees 「ブラウザ」,
// never "Browsers", and both places read the same words.

import { afterAll, afterEach, expect, test } from "bun:test";
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
const { default: StoreCategoryPage } = await import(
	"./store-category-page.tsx"
);

const JA: Record<string, string> = {
	"Back to categories": "カテゴリに戻る",
	Browsers: "ブラウザ",
	Categories: "カテゴリ",
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

async function renderPage(
	locale: string,
	category: string
): Promise<HTMLElement> {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith("ja") ? JA : {}
	);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale={locale}
				initialPackId={null}
			>
				<StoreCategoryPage
					category={category}
					items={["one"]}
					onBack={() => undefined}
					renderItem={(item) => <span key={item}>{item}</span>}
				/>
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	return container;
}

test("the shelf name in the heading and breadcrumb is translated", async () => {
	const page = await renderPage("ja", "Browsers");
	expect(page.querySelector("h2")?.textContent).toBe("ブラウザ");
	expect(page.querySelector('[aria-current="page"]')?.textContent).toBe(
		"ブラウザ"
	);
	expect(
		page.querySelector('[aria-label="カテゴリに戻る"]')?.textContent
	).toContain("カテゴリ");
});

test("an unknown shelf and English read as before", async () => {
	const unknown = await renderPage("ja", "Ham Radio");
	expect(unknown.querySelector("h2")?.textContent).toBe("Ham Radio");
	await act(async () => {
		mounted?.root.unmount();
	});
	mounted?.container.remove();
	mounted = undefined;
	const english = await renderPage("en", "Browsers");
	expect(english.querySelector("h2")?.textContent).toBe("Browsers");
	expect(
		english.querySelector('[aria-label="Back to categories"]')
	).not.toBeNull();
});
