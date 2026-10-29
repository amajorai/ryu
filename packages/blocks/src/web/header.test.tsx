// The package bunfig preloads this, but `bun test` reads bunfig only from the
// working directory, so a run from the repo root would load every CSS module
// as `{}`. Register it here too, then load CSS modules (and the header that
// imports one) dynamically: static imports are linked before this runs.
import "../../scripts/css-modules-preload.ts";
import { expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PRODUCT_NAV_GROUPS } from "./data/product-realms.ts";
import {
	DOCS_URL,
	PLAN_LINKS,
	resources,
	resourcesByCategory,
} from "./data/resources.tsx";

mock.module("next/navigation", () => ({
	usePathname: () => "/marketplace",
}));

const { default: blurStyles } = await import("./progressive-blur.module.css");
const { default: Header } = await import("./header.tsx");

test("marketing header renders Products, Resources, Enterprise, and Docs, with Pricing in Resources", () => {
	const html = renderToStaticMarkup(createElement(Header));

	expect(html.match(/data-slot="navigation-menu-trigger"/g)).toHaveLength(2);
	expect(html).toContain("Products");
	expect(html).toContain("Resources");
	expect(html).toContain("bg-background");
	expect(html).toContain("backdrop-blur-none");
	expect(html).toContain("backdrop-saturate-100");
	expect(html).toContain('href="/enterprise"');
	// Pricing moved into the Resources menu (PLAN_LINKS), which renders on open.
	expect(html).not.toContain('href="/pricing"');
	expect(html).toContain(`href="${DOCS_URL}"`);
	// The logo is decorative and the badge is hidden below lg, so the home link
	// carries its own screen-reader text.
	expect(html).toContain('<span class="sr-only">Ryu home</span>');
	// Marketplace is no longer a flat top-bar link; it lives in the Products menu.
	expect(html).not.toContain('href="/marketplace"');
	expect(html).not.toContain('href="/challenges"');
	expect(
		PRODUCT_NAV_GROUPS.flatMap((group) => group.items).map((item) => item.href)
	).toContain("/marketplace");
	expect(resourcesByCategory("Community")).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ href: "/challenges", label: "Challenges" }),
		])
	);
});

test("the Resources menu labels the community stats entry Stats", () => {
	const stats = resources.find((resource) => resource.href === "/community");
	expect(stats?.label).toBe("Stats");
	expect(stats?.category).toBe("Community");
});

test("top-bar links are full pills the size of the menu triggers", () => {
	const html = renderToStaticMarkup(createElement(Header));
	const enterprise = html.match(/<a[^>]*href="\/enterprise"[^>]*>/)?.[0] ?? "";

	expect(enterprise).toContain("rounded-full");
	expect(enterprise).not.toContain("rounded-4xl");
	expect(enterprise).toContain("h-9");
	expect(enterprise).toContain("px-3");
});

test("on /marketplace only the Products trigger is active", () => {
	const html = renderToStaticMarkup(createElement(Header));
	const triggers = Array.from(
		html.matchAll(/<button[^>]*data-slot="navigation-menu-trigger"[^>]*>/g),
		(match) => match[0]
	);

	expect(triggers).toHaveLength(2);
	expect(triggers[0]).toContain('data-active="true"');
	expect(triggers[1]).not.toContain('data-active="true"');
	expect(html).not.toContain('aria-current="page"');
});

test("resources menu keeps three small groups and leaves Pricing and Marketplace to their own menus", () => {
	for (const category of ["Learn", "Updates", "Community"] as const) {
		const items = resourcesByCategory(category);
		expect(items.length).toBeGreaterThanOrEqual(3);
		expect(items.length).toBeLessThanOrEqual(4);
	}
	const hrefs = resources.map((resource) => resource.href);
	expect(new Set(hrefs).size).toBe(hrefs.length);
	expect(hrefs).not.toContain("/pricing");
	expect(hrefs).not.toContain("/marketplace");
	expect(hrefs).not.toContain("/subscriptions");
	expect(PLAN_LINKS.map((link) => link.href)).toEqual(["/pricing", "/gifts"]);
});

test("transparent marketing header feathers over the landing visual", () => {
	const html = renderToStaticMarkup(
		createElement(Header, { transparent: true })
	);

	expect(html).toContain('data-transparent="true"');
	expect(html).toContain(
		"color-mix(in oklab, var(--background) 38%, transparent)"
	);
	expect(html).toContain(blurStyles.blur);
	expect(html).toContain(blurStyles.top);
	expect(html).toContain("absolute inset-0 z-0");
	expect(html).toContain("height:176px");
	expect(html).toContain("--blur-amount:12px");
	expect(html).not.toContain("bg-background/20 backdrop-blur-sm");
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
	expect(html).toContain('aria-label="Back to Console"');
	expect(html).toContain('href="/console"');
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
