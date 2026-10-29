import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { getProduct, products } from "../data/products.tsx";
import ProductLandingPage from "../product-landing-page.tsx";
import { getProductExplainer, PRODUCT_EXPLAINERS } from "./explainers.ts";

const SECTION_IDS = [
	"product-statement",
	"product-how-it-works",
	"product-built-for",
	"product-works-with",
] as const;

function renderProduct(slug: string): string {
	const product = getProduct(slug);
	if (!product) {
		throw new Error(`unknown product ${slug}`);
	}
	return renderToStaticMarkup(<ProductLandingPage product={product} />);
}

test("a product with a full explainer renders every section in page order", () => {
	const html = renderProduct("core");
	const positions = SECTION_IDS.map((id) =>
		html.indexOf(`data-testid="${id}"`)
	);
	for (const position of positions) {
		expect(position).toBeGreaterThan(-1);
	}
	expect([...positions].sort((a, b) => a - b)).toEqual(positions);
	expect(html).toContain("What it is");
	expect(html).toContain("How it works");
	expect(html).toContain("Built for");
	expect(html).toContain("Works with");
	// Related products link to their own pages.
	expect(html).toContain('href="/products/gateway"');
	expect(html).toContain('href="/products/desktop"');
});

test("sections are left out when the explainer does not set them", () => {
	const product = getProduct("core");
	if (!product) {
		throw new Error("core is missing");
	}
	const html = renderToStaticMarkup(
		<ProductLandingPage product={{ ...product, slug: "no-such-product" }} />
	);
	for (const id of SECTION_IDS) {
		expect(html).not.toContain(`data-testid="${id}"`);
	}
	expect(getProductExplainer("no-such-product")).toEqual({});

	// A planned product with only a statement gets only that section.
	const planned = renderProduct("compute");
	expect(planned).toContain('data-testid="product-statement"');
	expect(planned).not.toContain('data-testid="product-how-it-works"');
	expect(planned).not.toContain('data-testid="product-works-with"');
});

test("every explainer belongs to a product and links only to real products", () => {
	const slugs = new Set(products.map((product) => product.slug));
	for (const [slug, explainer] of Object.entries(PRODUCT_EXPLAINERS)) {
		expect(slugs.has(slug)).toBe(true);
		for (const related of explainer.worksWith ?? []) {
			expect(slugs.has(related)).toBe(true);
			expect(related).not.toBe(slug);
		}
		if (explainer.steps) {
			expect(explainer.steps).toHaveLength(3);
		}
	}
	// Every product page has at least the one-paragraph statement.
	for (const product of products) {
		expect(getProductExplainer(product.slug).statement).toBeTruthy();
	}
});
