import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { STAGE_PRODUCT_SLUGS } from "../backgrounds/stage-routes.ts";
import { getProduct, products } from "../data/products.tsx";
import { PUBLISHED_PRICING } from "../data/standalone-pricing.ts";
import ProductLandingPage from "../product-landing-page.tsx";
import {
	ARCHETYPE_REQUIREMENTS,
	ARCHETYPE_SECTION_ORDER,
	ARCHETYPE_SIDE_BY_SIDE,
	AUTHORED_SECTION_GROUPS,
	figureFollowsHero,
	getProductArchetype,
	LIMITS_REQUIRED_SLUGS,
	OPENAPI_REQUIRED_SLUGS,
	PRODUCT_ARCHETYPE_BY_SLUG,
	PRODUCT_ARCHETYPES,
	PRODUCT_SECTION_MARKERS,
	PRODUCT_SECTION_NAV,
	requirementsForSlug,
} from "./archetypes.ts";
import type { ProductSectionKey } from "./profile-types.ts";

const repoRoot = new URL("../../../../../", import.meta.url);

function render(slug: string): string {
	const product = getProduct(slug);
	if (!product) {
		throw new Error(`unknown product ${slug}`);
	}
	return renderToStaticMarkup(createElement(ProductLandingPage, { product }));
}

test("every catalog product and stage slug has an archetype", () => {
	const mapped = Object.keys(PRODUCT_ARCHETYPE_BY_SLUG).sort();
	expect(mapped).toEqual([...STAGE_PRODUCT_SLUGS].sort());
	for (const product of products) {
		expect([product.slug, product.slug in PRODUCT_ARCHETYPE_BY_SLUG]).toEqual([
			product.slug,
			true,
		]);
	}
	for (const archetype of Object.values(PRODUCT_ARCHETYPE_BY_SLUG)) {
		expect(PRODUCT_ARCHETYPES).toContain(archetype);
	}
});

test("the mapping follows the lead decisions", () => {
	expect(getProductArchetype("hire")).toBe("preview");
	expect(getProductArchetype("devices")).toBe("preview");
	expect(getProductArchetype("box")).toBe("agent-api");
	expect(getProductArchetype("gateway")).toBe("infrastructure");
	expect(getProductArchetype("marketplace")).toBe("catalog");
	expect(getProductArchetype("desktop")).toBe("workspace");
	expect(getProductArchetype("sdk")).toBe("builder");
	expect(getProductArchetype("not-a-product")).toBe("infrastructure");
	const catalogSlugs = STAGE_PRODUCT_SLUGS.filter(
		(slug) => PRODUCT_ARCHETYPE_BY_SLUG[slug] === "catalog"
	);
	expect(catalogSlugs.sort()).toEqual(["connections", "marketplace"]);
});

test("each order opens on the hero, closes on the CTA, and never repeats", () => {
	for (const archetype of PRODUCT_ARCHETYPES) {
		const order = ARCHETYPE_SECTION_ORDER[archetype];
		expect([archetype, order[0]]).toEqual([archetype, "hero"]);
		expect([archetype, order.at(-1)]).toEqual([archetype, "cta"]);
		expect([archetype, new Set(order).size]).toEqual([archetype, order.length]);
	}
});

test("each archetype opens on its own signature, not one shared head", () => {
	const openers = PRODUCT_ARCHETYPES.map((archetype) =>
		ARCHETYPE_SECTION_ORDER[archetype].slice(1, 3).join(",")
	);
	expect(new Set(openers).size).toBe(PRODUCT_ARCHETYPES.length);
	expect(ARCHETYPE_SECTION_ORDER.builder[1]).toBe("code");
	expect(ARCHETYPE_SECTION_ORDER["agent-api"].slice(1, 3)).toEqual([
		"code",
		"interfaces",
	]);
	expect(ARCHETYPE_SECTION_ORDER.catalog[1]).toBe("catalog");
	expect(ARCHETYPE_SECTION_ORDER.preview[1]).toBe("status-board");
	expect(figureFollowsHero("infrastructure")).toBe(true);
	expect(figureFollowsHero("workspace")).toBe(true);
	expect(figureFollowsHero("builder")).toBe(false);
	// Tails differ too: not every page ends faq, compare, related, docs, cta.
	const tails = PRODUCT_ARCHETYPES.map((archetype) =>
		ARCHETYPE_SECTION_ORDER[archetype].slice(-4).join(",")
	);
	expect(new Set(tails).size).toBeGreaterThan(2);
	expect(ARCHETYPE_SECTION_ORDER.preview.slice(-2)).toEqual(["faq", "cta"]);
});

test("every archetype keeps all authored catalog content on the page", () => {
	for (const archetype of PRODUCT_ARCHETYPES) {
		const order = ARCHETYPE_SECTION_ORDER[archetype];
		for (const group of AUTHORED_SECTION_GROUPS) {
			expect([
				archetype,
				group,
				group.some((key) => order.includes(key)),
			]).toEqual([archetype, group, true]);
		}
	}
	const workspace = ARCHETYPE_SECTION_ORDER.workspace;
	expect(workspace).toContain("explorer");
	expect(workspace).not.toContain("features");
});

test("archetypes differ in the order of their body, not only in what is skipped", () => {
	const bodies = PRODUCT_ARCHETYPES.map((archetype) =>
		ARCHETYPE_SECTION_ORDER[archetype].slice(2, 6).join(",")
	);
	expect(new Set(bodies).size).toBe(PRODUCT_ARCHETYPES.length);
	expect(ARCHETYPE_SECTION_ORDER.preview).toContain("status-board");
	expect(ARCHETYPE_SECTION_ORDER.catalog).toContain("catalog");
});

test("side-by-side pairs are adjacent in their archetype's order", () => {
	for (const [archetype, pair] of Object.entries(ARCHETYPE_SIDE_BY_SIDE)) {
		const order =
			ARCHETYPE_SECTION_ORDER[
				archetype as keyof typeof ARCHETYPE_SECTION_ORDER
			];
		const [left, right] = pair ?? [];
		const index = order.indexOf(left as ProductSectionKey);
		expect(index).toBeGreaterThan(-1);
		expect(order[index + 1]).toBe(right as ProductSectionKey);
	}
});

test("markers are full attribute strings and unique per section", () => {
	const markers = Object.entries(PRODUCT_SECTION_MARKERS).map(
		([key, marker]) => [key, marker("box")] as const
	);
	for (const [key, marker] of markers) {
		expect([key, marker.startsWith("data-")]).toEqual([key, true]);
		if (key !== "hero" && key !== "figure") {
			expect([key, /^data-testid="[^"]+"$/.test(marker)]).toEqual([key, true]);
		}
	}
	expect(new Set(markers.map(([, marker]) => marker)).size).toBe(
		markers.length
	);
	expect(PRODUCT_SECTION_MARKERS.pricing("gateway")).toBe(
		'data-testid="standalone-pricing-gateway"'
	);
	expect(
		'data-testid="standalone-pricing-card-gateway"'.includes(
			PRODUCT_SECTION_MARKERS.pricing("gateway")
		)
	).toBe(false);
	expect(PRODUCT_SECTION_MARKERS.explorer("bot")).toBe(
		'data-testid="product-feature-explorer"'
	);
});

test("markers of sections that already exist match what the page renders today", () => {
	const core = render("core");
	for (const key of [
		"hero",
		"figure",
		"statement",
		"how-it-works",
		"built-for",
		"capabilities",
		"faq",
		"works-with",
		"cta",
	] as const) {
		expect([key, core.includes(PRODUCT_SECTION_MARKERS[key]("core"))]).toEqual([
			key,
			true,
		]);
	}
	const gateway = render("gateway");
	expect(gateway).toContain(PRODUCT_SECTION_MARKERS.features("gateway"));
	expect(gateway).toContain(PRODUCT_SECTION_MARKERS.pricing("gateway"));
});

test("sub-nav anchors are unique except the features/explorer alternatives", () => {
	const ids = Object.entries(PRODUCT_SECTION_NAV)
		.filter(([key]) => key !== "explorer")
		.map(([, nav]) => nav?.id);
	expect(new Set(ids).size).toBe(ids.length);
	expect(PRODUCT_SECTION_NAV.explorer?.id).toBe(
		PRODUCT_SECTION_NAV.features?.id
	);
	for (const key of ["hero", "figure", "cta"] as const) {
		expect(PRODUCT_SECTION_NAV[key]).toBeUndefined();
	}
});

test("requirements add limits and OpenAPI only for the named agent APIs", () => {
	expect(requirementsForSlug("box", { hasDocsCta: true })).toEqual([
		"facts",
		"code",
		"interfaces",
		"docs",
		"limits",
		"openapi",
	]);
	expect(requirementsForSlug("messaging", { hasDocsCta: true })).toEqual([
		"facts",
		"code",
		"interfaces",
		"docs",
		"openapi",
	]);
	expect(requirementsForSlug("sites", { hasDocsCta: false })).toEqual([
		"facts",
		"code",
		"interfaces",
		"openapi",
	]);
	expect(requirementsForSlug("hire", { hasDocsCta: true })).toEqual([
		"facts",
		"status",
	]);
	expect(requirementsForSlug("core", { hasDocsCta: true })).toEqual([
		...ARCHETYPE_REQUIREMENTS.infrastructure,
	]);
});

test("limits are required exactly where PUBLISHED_PRICING has rates", () => {
	for (const slug of LIMITS_REQUIRED_SLUGS) {
		expect([slug, slug in PUBLISHED_PRICING]).toEqual([slug, true]);
		expect(getProductArchetype(slug)).toBe("agent-api");
	}
	for (const slug of ["messaging", "sites", "hire"]) {
		expect(LIMITS_REQUIRED_SLUGS as readonly string[]).not.toContain(slug);
	}
});

test("every OpenAPI-required slug has a published document", () => {
	for (const slug of OPENAPI_REQUIRED_SLUGS) {
		const path = new URL(`apps/web/public/openapi/${slug}.json`, repoRoot);
		expect([slug, existsSync(path)]).toEqual([slug, true]);
	}
});
