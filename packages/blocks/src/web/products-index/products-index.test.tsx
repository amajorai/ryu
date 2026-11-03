import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { productsByCategory } from "../data/products.tsx";
import { ProductsIndex } from "./products-index.tsx";
import { productsIndexGroups } from "./products-index-data.ts";
import { PRODUCTS_INDEX_START_LINKS } from "./products-index-start.tsx";

const html = renderToStaticMarkup(<ProductsIndex />);
const rows = productsIndexGroups().flatMap((group) => group.rows);

/** The markup of one product's table row. */
function rowHtml(source: string, slug: string): string {
	const start = source.indexOf(`data-products-index-row="${slug}"`);
	if (start === -1) {
		throw new Error(`no row for ${slug}`);
	}
	return source.slice(start, source.indexOf("</tr>", start));
}

test("one table per category with the five spec columns", () => {
	const groups = productsIndexGroups();
	expect(html.match(/<table[\s>]/g)).toHaveLength(groups.length);
	for (const header of ["Product", "What it is", "Status", "Pricing", "Docs"]) {
		expect(html).toContain(`scope="col">${header}</th>`);
	}
	for (const group of groups) {
		expect(html).toContain(`${group.category} products</caption>`);
		expect(html).toContain(`role="region" tabindex="0"`);
	}
});

test("each row links the product page and states its tagline and status chip", () => {
	for (const row of rows) {
		const markup = rowHtml(html, row.slug);
		expect(markup).toContain(`href="${row.href}"`);
		expect(markup).toContain(row.name);
		expect(markup).toContain(
			row.tagline.replaceAll("&", "&amp;").replaceAll("'", "&#x27;")
		);
		expect(markup).toMatch(new RegExp(`</span>${row.status}</span>`));
	}
});

test("pricing shows the published lead sentence or links /pricing", () => {
	const gateway = rowHtml(html, "gateway");
	expect(gateway).toContain("Self-hosting is free.");
	expect(gateway).not.toContain('href="/pricing"');
	const sites = rowHtml(html, "sites");
	expect(sites).toContain('href="/pricing"');
	expect(sites).toContain("See pricing");
});

test("docs links open externally with rel=noopener, and rows without docs say so", () => {
	const core = rowHtml(html, "core");
	expect(core).toMatch(/href="https?:[^"]+\/docs\/core"/);
	expect(core).toContain('rel="noopener noreferrer"');
	expect(core).toContain('target="_blank"');
	expect(rowHtml(html, "bot")).toContain("No docs link");
});

test("the summary strip counts the shown products only", () => {
	const hidden = productsByCategory("Agent APIs").map((p) => p.slug);
	const filtered = renderToStaticMarkup(<ProductsIndex hiddenSlugs={hidden} />);
	const count = (source: string, key: string) =>
		source.match(
			new RegExp(
				`data-products-index-count="${key}"[^>]*>(?:<dt[^>]*>.*?</dt>)<dd[^>]*>(\\d+)</dd>`
			)
		)?.[1];
	expect(count(html, "total")).toBe(String(rows.length));
	expect(count(filtered, "total")).toBe(String(rows.length - hidden.length));
	expect(filtered).not.toContain('data-products-index-count="Agent APIs"');
	expect(filtered).not.toContain('data-products-index-group="Agent APIs"');
	expect(count(html, "Build")).toBe(String(productsByCategory("Build").length));
	expect(count(html, "available")).toBe(
		String(rows.filter((row) => row.status === "Available").length)
	);
	expect(html).not.toMatch(/generally available/i);
	expect(count(html, "early-access")).toBe(
		String(rows.filter((row) => row.status === "Early access").length)
	);
});

test("headings run h2 then h3 per category, and the start row links onward", () => {
	expect(html).not.toContain("<h1");
	const levels = [...html.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));
	expect(levels[0]).toBe(2);
	for (const [index, level] of levels.entries()) {
		expect(level <= (levels[index - 1] ?? 1) + 1).toBe(true);
	}
	for (const link of PRODUCTS_INDEX_START_LINKS) {
		expect(html).toContain(`href="${link.href}"`);
	}
	expect(html).toContain("How it fits together");
});
