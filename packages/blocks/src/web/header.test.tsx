import { expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("next/navigation", () => ({
	usePathname: () => "/marketplace",
}));

const { default: Header } = await import("./header.tsx");

test("marketing header renders product/resource controls and Marketplace", () => {
	const html = renderToStaticMarkup(createElement(Header));

	expect(html.match(/data-slot="navigation-menu-trigger"/g)).toHaveLength(2);
	expect(html).toContain("Products");
	expect(html).toContain("Resources");
	expect(html).toContain("bg-background");
	expect(html).toContain("backdrop-blur-none");
	expect(html).toContain("backdrop-saturate-100");
	expect(html).toContain('href="/marketplace"');
	expect(html).toContain('aria-current="page"');
});

test("portal header orders account, organization, and utilities", () => {
	const html = renderToStaticMarkup(
		createElement(Header, {
			inverse: true,
			orgSlot: createElement("span", null, "Acme"),
			portalContextNav: createElement("span", null, "Tabs"),
			portalUtilityMenu: createElement("span", null, "Help"),
			userMenu: createElement("span", null, "Account"),
			variant: "portal",
		})
	);

	expect(html.indexOf("Account")).toBeLessThan(html.indexOf("Acme"));
	expect(html.indexOf("Acme")).toBeLessThan(html.indexOf("Help"));
	expect(html).toContain('aria-label="Back to dashboard"');
	expect(html).toContain('href="/dashboard"');
	expect(html).not.toContain("Research Preview");
});

test("portal inverse header renders the inverted shell", () => {
	const html = renderToStaticMarkup(
		createElement(Header, {
			inverse: true,
			orgSlot: createElement("span", null, "Acme"),
			variant: "portal",
		})
	);

	expect(html).toContain("bg-foreground text-background");
	expect(html).toContain("text-background/40");
});
