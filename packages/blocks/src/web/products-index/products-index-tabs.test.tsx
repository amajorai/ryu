import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

if (typeof document === "undefined") {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { ProductCount, ProductsIndexTabs } = await import(
	"./products-index-tabs.tsx"
);

const TABS = [
	{ id: "workspaces", label: "Workspaces", count: 2, panel: <p>Bot row</p> },
	{ id: "build", label: "Build", count: 3, panel: <p>SDK row</p> },
	{ id: "platform", label: "Platform", count: 1, panel: <p>Core row</p> },
];

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
	registerLiteralCatalogLoader(null);
	act(() => root?.unmount());
	host?.remove();
	root = null;
	host = null;
});
afterAll(async () => {
	await GlobalRegistrator.unregister();
});

function mount(): HTMLElement {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	act(() => root?.render(<ProductsIndexTabs tabs={TABS} />));
	return host;
}

function panels(node: HTMLElement): HTMLElement[] {
	return [...node.querySelectorAll<HTMLElement>("[data-products-index-panel]")];
}

function visiblePanelIds(node: HTMLElement): (string | undefined)[] {
	return panels(node)
		.filter((panel) => !panel.hidden)
		.map((panel) => panel.dataset.productsIndexPanel);
}

function button(node: HTMLElement, id: string): HTMLButtonElement {
	const found = node.querySelector<HTMLButtonElement>(
		`[data-products-index-filter="${id}"]`
	);
	if (!found) {
		throw new Error(`no filter ${id}`);
	}
	return found;
}

function status(node: HTMLElement): HTMLElement | null {
	return node.querySelector<HTMLElement>("[data-products-index-status]");
}

test("the server HTML holds every panel and an All filter with the total count", () => {
	const html = renderToStaticMarkup(<ProductsIndexTabs tabs={TABS} />);
	for (const text of ["Bot row", "SDK row", "Core row"]) {
		expect(html).toContain(text);
	}
	expect(html.match(/data-products-index-panel=/g)).toHaveLength(3);
	// "All" is pressed first, so no panel starts hidden for no-JS visitors.
	expect(html).not.toContain("hidden");
	expect(html).toMatch(/>All<\/span><span[^>]*>6<\/span>/);
	expect(html).toMatch(/>Build<\/span><span[^>]*>3<\/span>/);
});

test("it is a filter, not tabs: a labelled group of pressed buttons", () => {
	const node = mount();
	expect(node.querySelector('[role="tablist"]')).toBeNull();
	expect(node.querySelector('[role="tab"]')).toBeNull();
	expect(node.querySelector('[role="tabpanel"]')).toBeNull();
	const group = node.querySelector<HTMLElement>('[role="group"]');
	expect(group?.getAttribute("aria-label")).toBe("Filter products by category");
	expect(group?.getAttribute("aria-describedby")).toBe(status(node)?.id);
	expect(status(node)?.getAttribute("aria-live")).toBe("polite");
	expect(button(node, "all").getAttribute("aria-pressed")).toBe("true");
	expect(button(node, "build").getAttribute("aria-pressed")).toBe("false");
	expect(status(node)?.textContent).toBe("6 products");
});

test("a category leaves only its own panel visible and announces its count; All restores", () => {
	const node = mount();
	expect(visiblePanelIds(node)).toEqual(["workspaces", "build", "platform"]);

	act(() => button(node, "build").click());
	expect(visiblePanelIds(node)).toEqual(["build"]);
	expect(button(node, "build").getAttribute("aria-pressed")).toBe("true");
	expect(button(node, "all").getAttribute("aria-pressed")).toBe("false");
	expect(status(node)?.textContent).toBe("3 products");
	// Every panel is still in the DOM, just hidden.
	expect(node.textContent).toContain("Bot row");

	act(() => button(node, "platform").click());
	expect(visiblePanelIds(node)).toEqual(["platform"]);
	expect(status(node)?.textContent).toBe("1 product");

	act(() => button(node, "all").click());
	expect(visiblePanelIds(node)).toEqual(["workspaces", "build", "platform"]);
	expect(status(node)?.textContent).toBe("6 products");
});

const RU: Record<string, string> = {
	"{count, plural, one {# product} other {# products}}":
		"{count, plural, one {# продукт} few {# продукта} many {# продуктов} other {# продукта}}",
};

async function productCountIn(locale: string, count: number): Promise<string> {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith(locale) ? RU : {}
	);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => {
		root?.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				<ProductCount count={count} />
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	return host.textContent ?? "";
}

test("the product count is one plural message, so each locale picks its own form", async () => {
	expect(renderToStaticMarkup(<ProductCount count={1} />)).toBe("1 product");
	expect(renderToStaticMarkup(<ProductCount count={4} />)).toBe("4 products");
	expect(await productCountIn("ru", 5)).toBe("5 продуктов");
});
