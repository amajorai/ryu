import { expect, test } from "bun:test";
import { getProduct, products } from "../data/products.tsx";
import { docsHref } from "../data/resources.tsx";
import { PRICING_COPY } from "../data/standalone-pricing.ts";
import { productAvailabilityLabel, productBaseFacts } from "./base-facts.ts";
import { resolveDocsPath } from "./profile-grounding.ts";

function product(slug: string) {
	const found = getProduct(slug);
	if (!found) {
		throw new Error(`unknown product ${slug}`);
	}
	return found;
}

test("availability reads from the catalog status", () => {
	expect(productAvailabilityLabel(product("core"))).toBe("Generally available");
	expect(productAvailabilityLabel(product("box"))).toBe("Early access");
	expect(productAvailabilityLabel(product("devices"))).toBe("Coming soon");
});

test("a priced agent API states availability, category, its lead price and docs", () => {
	const facts = productBaseFacts(product("box"));
	expect(facts.map((fact) => fact.label)).toEqual([
		"Availability",
		"Category",
		"Pricing",
		"Docs",
	]);
	const pricing = facts[2];
	expect(pricing?.href).toBe("#pricing");
	for (const rate of [
		PRICING_COPY.boxSmallHour,
		PRICING_COPY.boxDefaultHour,
		PRICING_COPY.boxLargeHour,
		PRICING_COPY.boxMinimum,
	]) {
		expect(pricing?.value).toContain(rate);
	}
	// Only the first sentence: the storage sentence stays in the pricing section.
	expect(pricing?.value).not.toContain("GiB-month");
	expect(facts[3]).toEqual({
		label: "Docs",
		value: "/docs/standalone/box",
		href: docsHref("/docs/standalone/box"),
		external: true,
	});
});

test("unpublished or absent prices produce no pricing fact", () => {
	const sites = productBaseFacts(product("sites")).map((fact) => fact.label);
	expect(sites).toEqual(["Availability", "Category", "Docs"]);
	const hire = productBaseFacts(product("hire")).map((fact) => fact.label);
	expect(hire).toEqual(["Availability", "Category"]);
	const core = productBaseFacts(product("core")).map((fact) => fact.label);
	expect(core).toEqual(["Availability", "Category", "Docs"]);
});

test("messaging's base facts carry no dollar figure", () => {
	for (const fact of productBaseFacts(product("messaging"))) {
		expect(fact.value).not.toMatch(/\$\d/);
	}
});

test("every product's base facts are short and their docs paths resolve", () => {
	for (const item of products) {
		const facts = productBaseFacts(item);
		expect([item.slug, facts.length >= 2]).toEqual([item.slug, true]);
		for (const fact of facts) {
			expect([item.slug, fact.label, fact.value.length > 0]).toEqual([
				item.slug,
				fact.label,
				true,
			]);
			if (fact.label === "Docs") {
				expect([item.slug, Boolean(resolveDocsPath(fact.value))]).toEqual([
					item.slug,
					true,
				]);
			}
		}
	}
});
