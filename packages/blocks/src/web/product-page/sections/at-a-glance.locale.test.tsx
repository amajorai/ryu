import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { formatMessage } from "@ryu/i18n/core";
import { I18nProvider } from "@ryu/i18n/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getProduct, type Product } from "../../data/products.tsx";
import { productsIndexRow } from "../../products-index/products-index-data.ts";

// The "At a glance" Pricing fact and the /products index price cell are
// server-rendered in English. The DOM localizer translated the template but
// kept the English figures ("$0.025"), while the pricing section on the same
// page showed "0,025 $" in French. The client leaf rebuilds the lead for the
// reader's number format.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { ProductAtAGlance } = await import("./at-a-glance.tsx");
const { ProductsIndexTable } = await import(
	"../../products-index/products-index-table.tsx"
);

function requireBox(): Product {
	const found = getProduct("box");
	if (!found) {
		throw new Error("the catalog has no box product");
	}
	return found;
}
const box = requireBox();

let mounted: { container: HTMLElement; root: Root } | undefined;
afterEach(async () => {
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

async function renderText(
	locale: string,
	node: React.ReactNode
): Promise<string> {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				{node}
			</I18nProvider>
		);
	});
	return container.textContent ?? "";
}

function glanceText(locale: string): Promise<string> {
	return renderText(locale, <ProductAtAGlance product={box} />);
}

test("the English Pricing fact is unchanged", async () => {
	const text = await glanceText("en");
	const englishLead = productsIndexRow(box).pricing;
	expect(englishLead).toContain("$0.025");
	expect(text).toContain(englishLead ?? "");
});

test("the French Pricing fact formats the price with a no-break space before $", async () => {
	const text = await glanceText("fr");
	expect(text).toContain("0,025 $");
	expect(text).not.toContain("$0.025");
});

test("the spec layout formats the price for the reader too", async () => {
	const text = await renderText(
		"fr",
		<ProductAtAGlance layout="spec" product={box} />
	);
	expect(text).toContain("0,025 $");
});

test("the /products index price cell formats the price for the reader", async () => {
	const row = productsIndexRow(box);
	const group = { category: box.category, rows: [row] };
	const fr = await renderText(
		"fr",
		<ProductsIndexTable group={group} headingId="t" />
	);
	expect(fr).toContain("0,025 $");
	expect(fr).not.toContain("$0.025");
});

test("productsIndexRow keeps the English row by default and formats with tl", () => {
	const english = productsIndexRow(box).pricing ?? "";
	const french =
		productsIndexRow(
			box,
			(source, values = {}) => formatMessage(source, values, "fr"),
			"fr"
		).pricing ?? "";
	expect(english).toContain("$0.025");
	expect(french).toContain("0,025 $");
});

test("de, ja and ar readers get their own number formats in both places", async () => {
	const row = productsIndexRow(box);
	const group = { category: box.category, rows: [row] };
	const de = await glanceText("de");
	expect(de).toContain("0,025");
	expect(de).not.toContain("$0.025");
	// Japanese keeps the prefixed dollar sign and decimal point.
	expect(await glanceText("ja")).toContain("$0.025");
	const ar = await renderText(
		"ar",
		<ProductsIndexTable group={group} headingId="t" />
	);
	expect(ar).toMatch(/0\.025\sUS\$/u);
	expect(ar).not.toContain("$0.025");
});
