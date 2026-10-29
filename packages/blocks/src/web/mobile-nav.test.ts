import { expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("next/navigation", () => ({
	usePathname: () => "/marketplace",
}));

const { MobileNav } = await import("./mobile-nav.tsx");

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
	expect(tabLabels(html)).toEqual([
		"Products",
		"Resources",
		"Marketplace",
		"Sign in",
	]);
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

test("marks only the Marketplace tab current on /marketplace", () => {
	const html = renderToStaticMarkup(createElement(MobileNav));

	expect(html.match(/aria-current="page"/g)).toHaveLength(1);
	expect(html).toMatch(/aria-current="page"[^>]*href="\/marketplace"/);
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

test("sheets render the shared product groups and lead Resources with Pricing and Docs", async () => {
	const { PRODUCT_SHEET, RESOURCE_SHEET } = await import("./mobile-nav.tsx");
	const { PRODUCT_NAV_GROUPS } = await import("./data/product-realms.ts");

	// Available products only: early-access ones stay on /products.
	expect(PRODUCT_SHEET.map((group) => group.title)).toEqual(
		PRODUCT_NAV_GROUPS.map((group) => group.title)
	);
	expect(PRODUCT_SHEET[0]?.links.map((link) => link.label)).toEqual([
		"Bot",
		"Agent",
		"Desktop",
	]);
	expect(RESOURCE_SHEET[0]?.links.map((link) => link.label)).toEqual([
		"Pricing",
		"Gift Ryu",
		"Docs",
	]);
	for (const sheet of [PRODUCT_SHEET, RESOURCE_SHEET]) {
		const hrefs = sheet.flatMap((group) =>
			group.links.map((link) => link.href)
		);
		expect(new Set(hrefs).size).toBe(hrefs.length);
	}
});
