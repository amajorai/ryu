import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProductsIndexSummary as Summary } from "./products-index-data.ts";
import { ProductsIndexSummary } from "./products-index-summary.tsx";

const summary: Summary = {
	total: 7,
	byCategory: [
		{ category: "Workspaces", count: 4 },
		{ category: "Platform", count: 3 },
	],
	byAvailability: { available: 5, "early-access": 2, "coming-soon": 0 },
};

describe("ProductsIndexSummary", () => {
	const html = renderToStaticMarkup(<ProductsIndexSummary summary={summary} />);

	test("shows the total and each category count it is given", () => {
		expect(html).toContain('data-testid="products-index-summary"');
		expect(html).toMatch(/data-products-index-count="total"[\s\S]*?>7</);
		expect(html).toMatch(/data-products-index-count="Workspaces"[\s\S]*?>4</);
		expect(html).toMatch(/data-products-index-count="Platform"[\s\S]*?>3</);
	});

	test("draws a bar segment only for release states that have products", () => {
		expect(html).toContain('data-products-index-bar-segment="available"');
		expect(html).toContain('data-products-index-bar-segment="early-access"');
		expect(html).not.toContain('data-products-index-bar-segment="coming-soon"');
		expect(html).toContain("flex-grow:5");
	});

	test("labels the section with one h2 and no h1", () => {
		expect(html.match(/<h2/g)).toHaveLength(1);
		expect(html).not.toContain("<h1");
	});
});
