import { expect, mock, test } from "bun:test";
import {
	closedStandaloneProductPages,
	STANDALONE_SERVICE_SLUGS,
	standaloneServiceFlag,
	unlistedStandaloneServices,
} from "@ryu/auth/lib/feature-flags";
import { hiddenProductListings } from "@ryu/auth/lib/product-launch-flags";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	productMenuGroupsFor,
	productNavGroupsFor,
} from "./data/product-realms.ts";
import { products } from "./data/products.tsx";
import { STANDALONE_PRODUCT_PRICING } from "./data/standalone-pricing.ts";

// Every standalone surface in @ryu/blocks takes the host's closed/unlisted
// service slugs and filters at render time. The shared data (products,
// realms, STANDALONE_PRODUCT_PRICING) is never edited to hide a service.

mock.module("next/navigation", () => ({ usePathname: () => "/products" }));

const { ProductsOverview } = await import("./products-overview.tsx");
const { StandaloneProductPricingCatalog } = await import(
	"./standalone-product-pricing.tsx"
);

test("every standalone product and pricing row has its own rollout flag", () => {
	const standaloneProducts = products
		.filter((product) => product.standalone === true)
		.map((product) => product.slug);
	for (const slug of [
		...standaloneProducts,
		...STANDALONE_PRODUCT_PRICING.map((entry) => entry.slug),
	]) {
		expect(standaloneServiceFlag(slug)).toBe(`services.${slug}`);
	}
	const flaggedSlugs: string[] = [...STANDALONE_SERVICE_SLUGS];
	expect(flaggedSlugs.toSorted()).toEqual(
		[...new Set(standaloneProducts)].toSorted()
	);
});

/** Realm ids of one nav group's items and its pre-release line, in order. */
function navRealmIds(groupTitle: string, hidden?: readonly string[]) {
	const group = productNavGroupsFor(hidden).find(
		(candidate) => candidate.title === groupTitle
	);
	const realmIds = (items: readonly { id?: string }[] = []) =>
		items.flatMap((item) => (item.id ? [item.id] : []));
	return {
		items: realmIds(group?.items),
		upcoming: realmIds(group?.upcoming),
	};
}

test("the nav drops closed service realms and keeps the rest in order", () => {
	const hidden = closedStandaloneProductPages({ "services.box": true });
	const services = navRealmIds("Agent APIs", hidden);
	// The menus list available products only; rolled-out early-access services
	// stay on the pre-release line of the shared data.
	expect(services.items).toEqual([]);
	expect(navRealmIds("Workspaces", hidden).items).toEqual(["bot", "console"]);
	expect(services.upcoming).toEqual(["box", "compute", "share"]);
	// No hidden list: the full shared groups.
	expect(navRealmIds("Agent APIs").items).toEqual(["mail"]);
	expect(navRealmIds("Agent APIs").upcoming).toEqual([
		"connect",
		"passport",
		"box",
		"notify",
		"sites",
		"hire",
		"compute",
		"share",
	]);
	// Hiding is render-only: the shared nav data is not edited.
	expect(productNavGroupsFor()).toHaveLength(4);
});

test("menus skip a group with no rolled-out product instead of a blank column", () => {
	const hidden = closedStandaloneProductPages({ "services.box": true });
	const titles = productMenuGroupsFor(hidden).map((group) => group.title);

	expect(titles).not.toContain("Agent APIs");
	expect(titles).toEqual(["Workspaces", "Build", "Platform"]);
	expect(productMenuGroupsFor([]).map((group) => group.title)).toContain(
		"Agent APIs"
	);
});

test("the products index leaves out closed services but keeps plan-included pages", () => {
	const hiddenSlugs = closedStandaloneProductPages(null);
	// Box is on by default (it launched); the other services wait for rollout.
	expect(hiddenSlugs).not.toContain("box");
	const html = renderToStaticMarkup(
		createElement(ProductsOverview, { hiddenSlugs })
	);
	for (const slug of hiddenSlugs) {
		expect(html).not.toContain(`href="/products/${slug}"`);
	}
	expect(html).toContain('href="/products/box"');
	expect(html).toContain('href="/products/gateway"');
	expect(html).toContain('href="/products/cloud"');
	// The kill switch (an explicit false) closes the Box page.
	const killed = renderToStaticMarkup(
		createElement(ProductsOverview, {
			hiddenSlugs: closedStandaloneProductPages({ "services.box": false }),
		})
	);
	expect(killed).not.toContain('href="/products/box"');
	const open = renderToStaticMarkup(createElement(ProductsOverview));
	expect(open).toContain('href="/products/box"');
});

test("the nav data lists Box by default and drops it under the kill switch", () => {
	expect(
		navRealmIds("Agent APIs", closedStandaloneProductPages(null)).upcoming
	).toEqual(["box", "compute", "share"]);
	expect(
		navRealmIds(
			"Agent APIs",
			closedStandaloneProductPages({ "services.box": false })
		).upcoming
	).toEqual(["compute", "share"]);
});

test("the standalone pricing catalog renders only rolled-out cards", () => {
	const cardNames = (html: string) =>
		STANDALONE_PRODUCT_PRICING.filter((entry) =>
			html.includes(`>${entry.name}</div>`)
		).map((entry) => entry.slug);
	// Default (never read): only the launched Box card.
	const byDefault = renderToStaticMarkup(
		createElement(StandaloneProductPricingCatalog, {
			hiddenSlugs: unlistedStandaloneServices(null),
		})
	);
	expect(cardNames(byDefault)).toEqual(["box"]);
	expect(byDefault).not.toContain("standalone-pricing-early-access");
	// Every service closed (Box under its kill switch): no card at all.
	const closed = renderToStaticMarkup(
		createElement(StandaloneProductPricingCatalog, {
			hiddenSlugs: unlistedStandaloneServices({ "services.box": false }),
		})
	);
	for (const entry of STANDALONE_PRODUCT_PRICING) {
		expect(closed).not.toContain(`>${entry.name}</div>`);
	}
	expect(closed).toContain('data-testid="standalone-pricing-early-access"');
	// The marketplace and credit fee disclosure stays on the page.
	expect(closed).toContain("Marketplace and credit fees");

	const someOpen = renderToStaticMarkup(
		createElement(StandaloneProductPricingCatalog, {
			hiddenSlugs: unlistedStandaloneServices({
				"services.box": true,
				"services.gateway": true,
			}),
		})
	);
	expect(cardNames(someOpen).toSorted()).toEqual(["box", "gateway"]);
	expect(someOpen).toContain('data-testid="standalone-pricing-card-gateway"');
	expect(someOpen).not.toContain("standalone-pricing-early-access");
	// Hiding is render-only: every published row is still in the data.
	expect(STANDALONE_PRODUCT_PRICING).toHaveLength(9);
});

test("unlaunched products leave the menus, the sheet and the index until their flag opens", () => {
	const unreleased = [
		"/products/workflows",
		"/products/agents-as-a-service",
		"/products/red-team",
	];
	const menuHrefs = (hidden: readonly string[]) =>
		productMenuGroupsFor(hidden).flatMap((group) =>
			group.items.map((item) => item.href)
		);
	// Default (never read): the catalog.* launch flags are off.
	const hidden = hiddenProductListings(null);
	for (const href of unreleased) {
		expect(menuHrefs(hidden)).not.toContain(href);
	}
	expect(menuHrefs(hidden)).toContain("/products/core");
	expect(menuHrefs(hidden)).toContain("/products/cloud");
	const index = renderToStaticMarkup(
		createElement(ProductsOverview, { hiddenSlugs: hidden })
	);
	for (const href of unreleased) {
		expect(index).not.toContain(`href="${href}"`);
	}
	// Turning one flag on in the admin console lists that product again.
	const opened = hiddenProductListings({ "catalog.red_team": true });
	expect(menuHrefs(opened)).toContain("/products/red-team");
	expect(menuHrefs(opened)).not.toContain("/products/workflows");
});
