import { expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("next/navigation", () => ({
	usePathname: () => "/marketplace",
}));

const { MobileNav } = await import("./mobile-nav.tsx");

test("renders five accessible mobile navigation destinations", () => {
	const html = renderToStaticMarkup(createElement(MobileNav));

	expect(html).toContain('<nav aria-label="Mobile navigation"');
	for (const label of [
		"Home",
		"Products",
		"Solutions",
		"Resources",
		"Download",
	]) {
		expect(html).toContain(label);
	}
	expect(html).toContain('href="/"');
	expect(html).toContain('href="/download"');
	expect(html.match(/aria-controls="mobile-nav-sheet"/g)).toHaveLength(3);
	expect(html.match(/aria-expanded="false"/g)).toHaveLength(3);
	expect(html).not.toContain('role="dialog"');
});
