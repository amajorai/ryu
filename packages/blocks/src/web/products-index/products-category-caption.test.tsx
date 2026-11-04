import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register({ url: "https://ryu.test/products" });
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { ProductsCategoryCaption } = await import(
	"./products-category-caption.tsx"
);

const JA: Record<string, string> = {
	Build: "構築",
	"{category} products": "{category} の製品",
};

const roots: Root[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) {
		await act(async () => {
			root.unmount();
		});
	}
	registerLiteralCatalogLoader(null);
	document.body.replaceChildren();
});

async function renderJa(category: string): Promise<string> {
	registerLiteralCatalogLoader((locale) =>
		locale.startsWith("ja") ? JA : null
	);
	const mount = document.createElement("div");
	document.body.append(mount);
	const root = createRoot(mount);
	roots.push(root);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="ja"
				initialPackId={null}
			>
				<ProductsCategoryCaption category={category} />
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	return mount.textContent ?? "";
}

test("outside a provider the caption is the English sentence", () => {
	expect(
		renderToStaticMarkup(<ProductsCategoryCaption category="Build" />)
	).toBe("Build products");
});

test("Japanese visitors get the category and the caption sentence translated", async () => {
	expect(await renderJa("Build")).toBe("構築 の製品");
});
