import { expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("next/navigation", () => ({
	usePathname: () => "/marketplace",
}));

const { MobileNav } = await import("./mobile-nav.tsx");
const { DOCS_URL } = await import("./data/resources.tsx");

function tabLabels(html: string): string[] {
	return Array.from(
		html.matchAll(/<span class="font-medium text-xs[^"]*">([^<]+)</g),
		(match) => match[1] ?? ""
	);
}

test("mirrors the desktop header as two tabs, the Download action, and two tabs", () => {
	const html = renderToStaticMarkup(createElement(MobileNav));

	expect(html).toContain('<nav aria-label="Mobile navigation"');
	expect(html).toContain("grid-cols-5");
	expect(tabLabels(html)).toEqual(["Products", "Resources", "Docs", "Sign in"]);
	expect(html).toContain('<span class="sr-only">Download</span>');
	expect(html).toContain('href="/download"');
	expect(html).toContain('href="/login"');
	// Desktop has paused the Solutions menu, and the logo is the way home.
	expect(html).not.toContain("Solutions");
	expect(html).not.toContain('href="/"');
	expect(html.match(/aria-controls="mobile-nav-sheet"/g)).toHaveLength(2);
	expect(html.match(/aria-expanded="false"/g)).toHaveLength(2);
	expect(html).not.toContain('role="dialog"');
});

test("the Docs tab opens the docs in this tab, like the desktop header's Docs link", () => {
	const html = renderToStaticMarkup(createElement(MobileNav));
	const docsTab = html.match(
		/<a[^>]*href="([^"]+)"[^>]*>(?:(?!<\/a>).)*>Docs</
	);

	expect(docsTab?.[1]).toBe(DOCS_URL);
	expect(docsTab?.[0]).not.toContain("target=");
	expect(html).not.toContain("Marketplace");
	expect(html).not.toContain('href="/marketplace"');
});

test("highlights the Products tab on /marketplace, as the desktop Products menu does", () => {
	const html = renderToStaticMarkup(createElement(MobileNav));
	const products = html.match(
		/<button[^>]*aria-controls="mobile-nav-sheet"[^>]*class="([^"]*)"(?:(?!<\/button>).)*>Products</
	);

	expect(html).not.toContain('aria-current="page"');
	expect(products?.[1]).toContain("text-foreground");
	expect(products?.[1]).not.toContain("text-muted-foreground");
});

test("renders a host-supplied account tab in place of the sign-in link", () => {
	const html = renderToStaticMarkup(
		createElement(MobileNav, {
			account: createElement("button", { type: "button" }, "Proof account"),
		})
	);

	expect(html).toContain("Proof account");
	expect(html).not.toContain('href="/login"');
});

test("sheets mirror the desktop menus: the same groups, items, and summaries", async () => {
	const { PRODUCT_SHEET, RESOURCE_SHEET } = await import("./mobile-nav.tsx");
	const { PRODUCT_NAV_GROUPS } = await import("./data/product-realms.ts");
	const { resourceCategories } = await import("./data/resources.tsx");

	// Available products only: early-access ones stay on /products.
	expect(PRODUCT_SHEET.map((group) => group.title)).toEqual(
		PRODUCT_NAV_GROUPS.map((group) => group.title)
	);
	expect(PRODUCT_SHEET[0]?.links.map((link) => link.label)).toEqual([
		"Bot",
		"Agent",
		"Desktop",
	]);
	// Every product row carries its one-line summary from the shared data.
	for (const group of PRODUCT_SHEET) {
		for (const link of group.links) {
			expect(link.description?.length).toBeGreaterThan(0);
		}
	}
	// Plans, then the desktop Resources menu's categories; Docs sits in Learn.
	expect(RESOURCE_SHEET.map((group) => group.title)).toEqual([
		"Plans",
		...resourceCategories,
	]);
	expect(RESOURCE_SHEET[0]?.links.map((link) => link.label)).toEqual([
		"Pricing",
		"Gift Ryu",
	]);
	const docs = RESOURCE_SHEET[1]?.links.find((link) => link.label === "Docs");
	expect(docs?.href).toBe(DOCS_URL);
	// External, like the desktop Resources menu's Docs entry: a new tab.
	expect(docs?.external).toBe(true);
	for (const sheet of [PRODUCT_SHEET, RESOURCE_SHEET]) {
		const hrefs = sheet.flatMap((group) =>
			group.links.map((link) => link.href)
		);
		expect(new Set(hrefs).size).toBe(hrefs.length);
	}
});
