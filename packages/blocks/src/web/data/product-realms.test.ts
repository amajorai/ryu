import { expect, test } from "bun:test";
import { productHref } from "../products-overview.tsx";
import {
	PRODUCT_NAV_GROUPS,
	PRODUCT_REALMS,
	upcomingNavLabel,
} from "./product-realms.ts";
import { productStatusLabel, products } from "./products.tsx";

test("the product realm keeps the public product names and destinations together", () => {
	expect(PRODUCT_REALMS.map((realm) => realm.id)).toEqual([
		"os",
		"bot",
		"console",
		"gateway",
		"connect",
		"passport",
		"box",
		"mail",
		"notify",
		"sites",
		"hire",
		"compute",
		"share",
	]);
	expect(PRODUCT_REALMS.map((realm) => realm.label)).toEqual([
		"OS",
		"Bot",
		"Agent",
		"Ryu Gateway",
		"Ryu Connect",
		"Ryu Passport",
		"Ryu Box",
		"Ryu Mail",
		"Ryu Notify",
		"Ryu Sites",
		"Ryu Hire",
		"Ryu Compute",
		"Ryu Share",
	]);
	for (const realm of PRODUCT_REALMS) {
		expect(realm.href.startsWith("/")).toBe(true);
		expect(realm.description.length).toBeGreaterThan(20);
	}
});

test("product navigation uses the four canonical groups", () => {
	expect(PRODUCT_NAV_GROUPS.map((group) => group.title)).toEqual([
		"Workspaces",
		"Build",
		"Platform",
		"Agent APIs",
	]);
	expect(
		PRODUCT_NAV_GROUPS.map((group) => group.items.map((item) => item.href))
	).toEqual([
		["/bot", "/agent", "/products/desktop"],
		[
			"/products/agents",
			"/products/workflows",
			"/products/skills",
			"/marketplace",
			"/products/sdk",
		],
		[
			"/products/core",
			"/products/gateway",
			"/products/cloud",
			"/products/agents-as-a-service",
			"/products/red-team",
		],
		["/products/mail"],
	]);
	expect(
		PRODUCT_NAV_GROUPS.map((group) => upcomingNavLabel(group.upcoming ?? []))
	).toEqual(["On the way", "On the way", "On the way", "On the way"]);
});

test("product navigation agrees with the /products catalogue", () => {
	// Marketplace has its own top-level route rather than /products/marketplace.
	const catalogue = new Map(
		products.flatMap((product) => [
			[productHref(product), product] as const,
			[`/${product.slug}`, product] as const,
		])
	);
	for (const group of PRODUCT_NAV_GROUPS) {
		for (const item of group.items) {
			const product = catalogue.get(item.href);
			expect(product?.category).toBe(group.title);
			expect(product?.navLabel).toBe(item.label);
			// Available products only; pre-release ones go on the muted line.
			expect(product?.status).toBeUndefined();
		}
		for (const item of group.upcoming ?? []) {
			const product = catalogue.get(item.href);
			expect(product?.category).toBe(group.title);
			expect(product?.navLabel).toBe(item.label);
			expect(product && productStatusLabel(product)).toBe(item.status);
		}
	}
	// Every pre-release product in a group is listed on that group's muted line.
	for (const group of PRODUCT_NAV_GROUPS) {
		const upcoming = new Set((group.upcoming ?? []).map((item) => item.href));
		for (const product of products) {
			if (product.category === group.title && product.status) {
				expect(upcoming.has(productHref(product))).toBe(true);
			}
		}
	}
});

test("every product nav item is short, described, and linked once", () => {
	const items = PRODUCT_NAV_GROUPS.flatMap((group) => [
		...group.items,
		...(group.upcoming ?? []),
	]);
	for (const group of PRODUCT_NAV_GROUPS) {
		expect(group.items.length).toBeLessThanOrEqual(6);
	}
	for (const item of items) {
		expect(item.description.length).toBeGreaterThan(10);
		expect(item.description.split(/\s+/).length).toBeLessThanOrEqual(8);
	}
	const hrefs = items.map((item) => item.href);
	expect(new Set(hrefs).size).toBe(hrefs.length);
	// Menu items use the catalogue's bare nav labels.
	expect(PRODUCT_NAV_GROUPS[0]?.items.map((item) => item.label)).toEqual([
		"Bot",
		"Agent",
		"Desktop",
	]);
});
