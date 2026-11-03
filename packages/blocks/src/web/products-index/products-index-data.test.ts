import { expect, test } from "bun:test";
import {
	productCategories,
	products,
	productsByCategory,
} from "../data/products.tsx";
import { docsHref } from "../data/resources.tsx";
import { getStandaloneProductPricing } from "../data/standalone-pricing.ts";
import { productHref } from "../product-href.ts";
import { productDocsPath } from "../product-page/product-docs-path.ts";
import { hasPublishedPricing } from "../product-page/published-pricing.ts";
import {
	categoryId,
	PRODUCTS_INDEX_AVAILABILITY_LABELS,
	productsIndexGroups,
	productsIndexSummary,
} from "./products-index-data.ts";

const groups = productsIndexGroups();
const rows = groups.flatMap((group) => group.rows);

test("rows are grouped by category in the catalog's order, every product once", () => {
	expect(groups.map((group) => group.category)).toEqual(productCategories);
	for (const group of groups) {
		expect(group.rows.map((row) => row.slug)).toEqual(
			productsByCategory(group.category).map((product) => product.slug)
		);
		expect(group.rows.every((row) => row.category === group.category)).toBe(
			true
		);
	}
	expect(new Set(rows.map((row) => row.slug)).size).toBe(rows.length);
	expect(rows.length).toBe(products.length);
});

test("hidden slugs are dropped and a category left empty is removed", () => {
	const agentApis = productsByCategory("Agent APIs").map((p) => p.slug);
	const filtered = productsIndexGroups(["bot", ...agentApis]);
	const slugs = filtered.flatMap((group) => group.rows.map((row) => row.slug));
	expect(slugs).not.toContain("bot");
	for (const slug of agentApis) {
		expect(slugs).not.toContain(slug);
	}
	expect(filtered.map((group) => group.category)).not.toContain("Agent APIs");
	expect(filtered.map((group) => group.category)).toContain("Workspaces");
});

test("each row restates the catalog: name, link, tagline, status label and docs", () => {
	for (const row of rows) {
		const product = products.find((p) => p.slug === row.slug);
		if (!product) {
			throw new Error(`missing product ${row.slug}`);
		}
		expect(row.name).toBe(product.name);
		expect(row.href).toBe(productHref(product));
		expect(row.tagline).toBe(product.tagline);
		expect(row.availability).toBe(product.status ?? "available");
		expect(row.status).toBe(
			PRODUCTS_INDEX_AVAILABILITY_LABELS[row.availability]
		);
		const docsPath = productDocsPath(product);
		expect(row.docsHref).toBe(docsPath ? docsHref(docsPath) : undefined);
	}
});

test("pricing is the published lead sentence, and only when hasPublishedPricing", () => {
	let priced = 0;
	for (const row of rows) {
		const product = products.find((p) => p.slug === row.slug);
		const entry = getStandaloneProductPricing(row.slug);
		const published = Boolean(
			product?.standalone && entry && hasPublishedPricing(row.slug)
		);
		if (!published) {
			expect([row.slug, row.pricing]).toEqual([row.slug, undefined]);
			continue;
		}
		priced += 1;
		expect(entry?.price.startsWith(row.pricing ?? "\u0000")).toBe(true);
		expect(row.pricing).toMatch(/[.!?]$/);
	}
	expect(priced).toBeGreaterThan(0);
	// Sites is early access with no published price: it must not show one.
	expect(rows.find((row) => row.slug === "sites")?.pricing).toBeUndefined();
});

test("the summary counts the rows shown, never more", () => {
	const summary = productsIndexSummary(groups);
	expect(summary.total).toBe(rows.length);
	expect(summary.byCategory).toEqual(
		groups.map((group) => ({
			category: group.category,
			count: group.rows.length,
		}))
	);
	const { byAvailability } = summary;
	expect(byAvailability.available).toBe(
		rows.filter((row) => row.status === "Available").length
	);
	expect(byAvailability["early-access"]).toBe(
		rows.filter((row) => row.status === "Early access").length
	);
	expect(
		byAvailability.available +
			byAvailability["early-access"] +
			byAvailability["coming-soon"]
	).toBe(summary.total);

	const hidden = productsIndexSummary(productsIndexGroups(["bot", "box"]));
	expect(hidden.total).toBe(rows.length - 2);
	expect(productsIndexSummary([]).total).toBe(0);
});

test("no row claims general availability the catalog never states", () => {
	// The catalog has no "generally available" status; an unmarked product is
	// shown as plainly "Available", and only an explicit status changes that.
	expect(rows.some((row) => /generally available/i.test(row.status))).toBe(
		false
	);
	const unmarked = products.filter((product) => !product.status);
	expect(unmarked.length).toBeGreaterThan(0);
	for (const product of unmarked) {
		expect(rows.find((row) => row.slug === product.slug)?.status).toBe(
			"Available"
		);
	}
	expect(rows.find((row) => row.slug === "box")?.status).toBe("Early access");
	expect(rows.find((row) => row.slug === "devices")?.status).toBe(
		"Coming soon"
	);
	expect(Object.keys(productsIndexSummary(groups).byAvailability)).toEqual([
		"available",
		"early-access",
		"coming-soon",
	]);
});

test("category ids are DOM-safe", () => {
	expect(categoryId("Agent APIs")).toBe("agent-apis");
	expect(categoryId("Workspaces")).toBe("workspaces");
});
