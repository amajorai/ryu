import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	type ProductsIndexGroup,
	productsIndexGroups,
} from "./products-index-data.ts";
import {
	AVAILABILITY_MARKERS,
	ProductsIndexTable,
} from "./products-index-table.tsx";

const GROUP: ProductsIndexGroup = {
	category: "Build",
	rows: [
		{
			availability: "available",
			category: "Build",
			docsHref: "https://docs.example.test/docs/core",
			href: "/products/core",
			name: "Core",
			pricing: "Self-hosting is free.",
			slug: "core",
			status: "Available",
			tagline: "The local runtime.",
		},
		{
			availability: "early-access",
			category: "Build",
			href: "/products/sites",
			name: "Sites",
			slug: "sites",
			status: "Early access",
			tagline: "Sites you publish.",
		},
		{
			availability: "coming-soon",
			category: "Build",
			href: "/products/devices",
			name: "Devices",
			slug: "devices",
			status: "Coming soon",
			tagline: "Hardware.",
		},
	],
};

const html = renderToStaticMarkup(
	<ProductsIndexTable group={GROUP} headingId="build-title" />
);

function rowHtml(slug: string): string {
	const start = html.indexOf(`data-products-index-row="${slug}"`);
	if (start === -1) {
		throw new Error(`no row for ${slug}`);
	}
	return html.slice(start, html.indexOf("</tr>", start));
}

test("the section is named by its h3 and the table carries the five column headers", () => {
	expect(html).toContain('aria-labelledby="build-title"');
	expect(html).toMatch(/<h3[^>]*id="build-title"[^>]*>Build<\/h3>/);
	expect(html).toContain("3 products");
	expect(html).toContain("Build products</caption>");
	for (const header of ["Product", "What it is", "Status", "Pricing", "Docs"]) {
		expect(html).toContain(`scope="col">${header}</th>`);
	}
	expect(html.match(/scope="row"/g)).toHaveLength(3);
});

test("a row links its product page and its docs in a new tab", () => {
	const core = rowHtml("core");
	expect(core).toContain('href="/products/core"');
	expect(core).toContain("The local runtime.");
	expect(core).toContain('href="https://docs.example.test/docs/core"');
	expect(core).toContain('rel="noopener noreferrer"');
	expect(core).toContain('target="_blank"');
	expect(core).toContain('aria-label="Docs for Core (opens in a new tab)"');
	expect(rowHtml("sites")).toContain("No docs link");
});

test("each status chip states its label beside the matching marker", () => {
	for (const row of GROUP.rows) {
		const markup = rowHtml(row.slug);
		expect(markup).toContain(`</span>${row.status}</span>`);
		expect(markup).toContain(AVAILABILITY_MARKERS[row.availability]);
	}
	expect(AVAILABILITY_MARKERS["coming-soon"]).toContain("border-dashed");
});

test("a published price is shown as text; otherwise the row links /pricing", () => {
	const core = rowHtml("core");
	expect(core).toContain("Self-hosting is free.");
	expect(core).not.toContain('href="/pricing"');
	const sites = rowHtml("sites");
	expect(sites).toContain('href="/pricing"');
	expect(sites).toContain("See pricing");
	expect(sites).toContain('aria-label="See pricing for Sites"');
});

test("the real catalog renders one row per product in a group", () => {
	const [first] = productsIndexGroups();
	if (!first) {
		throw new Error("empty catalog");
	}
	const markup = renderToStaticMarkup(
		<ProductsIndexTable group={first} headingId="first" />
	);
	expect(markup.match(/data-products-index-row=/g)).toHaveLength(
		first.rows.length
	);
});

test("a one-product group counts it in the singular", () => {
	const single = renderToStaticMarkup(
		<ProductsIndexTable
			group={{ ...GROUP, rows: GROUP.rows.slice(0, 1) }}
			headingId="single-title"
		/>
	);
	expect(single).toContain("1 product<");
	expect(single).not.toContain("1 products");
});
