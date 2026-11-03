import { expect, test } from "bun:test";
import { PLAN_LINKS, resources } from "./data/resources.tsx";
import {
	isWithinPrefixes,
	PRODUCT_ACTIVE_PREFIXES,
	RESOURCE_ACTIVE_PREFIXES,
} from "./header-active-routes.ts";
import { RESOURCE_SHEET } from "./mobile-nav-sheet-data.ts";

test("every internal Resources destination lights the Resources menu", () => {
	const internalHrefs = [
		...PLAN_LINKS.map((link) => link.href),
		...resources
			.filter((resource) => !resource.external)
			.map((resource) => resource.href),
		...RESOURCE_SHEET.flatMap((group) =>
			group.links.filter((link) => !link.external).map((link) => link.href)
		),
	];
	for (const href of internalHrefs) {
		expect(isWithinPrefixes(href, RESOURCE_ACTIVE_PREFIXES)).toBe(true);
		expect(isWithinPrefixes(href, PRODUCT_ACTIVE_PREFIXES)).toBe(false);
	}
});

test("the Knowledge Base and company pages count as Resources, nested pages included", () => {
	for (const pathname of [
		"/knowledge-base",
		"/about",
		"/careers",
		"/press",
		"/events",
		"/help/getting-started",
	]) {
		expect(isWithinPrefixes(pathname, RESOURCE_ACTIVE_PREFIXES)).toBe(true);
	}
});

test("a route matches a prefix only at a path boundary", () => {
	expect(isWithinPrefixes("/about", ["/about"])).toBe(true);
	expect(isWithinPrefixes("/about/team", ["/about"])).toBe(true);
	expect(isWithinPrefixes("/aboutus", ["/about"])).toBe(false);
	expect(isWithinPrefixes("/", RESOURCE_ACTIVE_PREFIXES)).toBe(false);
	expect(isWithinPrefixes("/", PRODUCT_ACTIVE_PREFIXES)).toBe(false);
});

test("Products and Resources never claim the same route", () => {
	for (const prefix of RESOURCE_ACTIVE_PREFIXES) {
		expect(isWithinPrefixes(prefix, PRODUCT_ACTIVE_PREFIXES)).toBe(false);
	}
});
