import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { bannedCopyHits } from "../data/banned-copy.ts";
import { getProduct } from "../data/products.tsx";
import ProductLandingPage from "../product-landing-page.tsx";
import { getProductArchetype, PRODUCT_SECTION_MARKERS } from "./archetypes.ts";
import { productDocsPath } from "./product-docs-path.ts";
import { groundingErrors, repoRoot } from "./profile-grounding.ts";
import type { ProductProfile, ProductSectionKey } from "./profile-types.ts";
import {
	getProductProfile,
	profileCopyStrings,
	profileGaps,
	profileShapeErrors,
} from "./profiles.ts";
import {
	ARCHETYPE,
	PROFILE_SLUGS,
	PROFILES,
	type ProfileSlug,
} from "./profiles-catalog.ts";

function profile(slug: ProfileSlug): ProductProfile {
	const found = PROFILES[slug];
	if (!found) {
		throw new Error(`no profile for ${slug}`);
	}
	return found;
}

function readRepoFile(path: string): string {
	return readFileSync(join(repoRoot(), path), "utf8");
}

function renderPage(slug: ProfileSlug): string {
	const product = getProduct(slug);
	if (!product) {
		throw new Error(`unknown product ${slug}`);
	}
	return renderToStaticMarkup(<ProductLandingPage product={product} />);
}

/** HTML-escape a value the way React writes text content. */
function escaped(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#x27;");
}

const pages = new Map(PROFILE_SLUGS.map((slug) => [slug, renderPage(slug)]));

function page(slug: ProfileSlug): string {
	return pages.get(slug) ?? "";
}

/** Labels the base facts already use; a profile fact must not repeat them. */
const BASE_FACT_LABELS = ["Availability", "Category", "Pricing", "Docs"];

/** Sections every catalog page renders from its profile. */
const FROM_PROFILE: readonly ProductSectionKey[] = [
	"catalog",
	"at-a-glance",
	"related",
	"docs",
];

/** The web Marketplace's kind segments (`KIND_SEGMENTS` in apps/web). */
function marketplaceSegments(): string[] {
	const source = readRepoFile("apps/web/src/lib/marketplace-catalog.server.ts");
	const block = source.match(/KIND_SEGMENTS = \{([\s\S]*?)\} as const/)?.[1];
	return [...(block ?? "").matchAll(/^\s*"?([a-z-]+)"?:/gm)].map(
		(match) => match[1] ?? ""
	);
}

describe.each(PROFILE_SLUGS)("%s profile", (slug) => {
	const entry = profile(slug);

	test("is the catalog archetype and is registered", () => {
		expect(ARCHETYPE).toBe("catalog");
		expect(getProductArchetype(slug)).toBe("catalog");
		expect(getProductProfile(slug)).toBe(entry);
	});

	test("meets every requirement of its page", () => {
		expect(profileGaps(slug)).toEqual([]);
		expect(profileShapeErrors(entry)).toEqual([]);
	});

	test("is grounded in real repo files and quotes", () => {
		expect(groundingErrors(entry)).toEqual([]);
	});

	test("uses no banned copy and states no price", () => {
		const copy = profileCopyStrings(entry);
		expect(bannedCopyHits(copy)).toEqual([]);
		expect(copy.filter((text) => /\$\s?\d/.test(text))).toEqual([]);
	});

	test("adds its own facts without repeating a base fact", () => {
		const labels = entry.facts.map((fact) => fact.label);
		expect(labels.length).toBeGreaterThanOrEqual(4);
		expect(new Set(labels).size).toBe(labels.length);
		expect(labels.filter((label) => BASE_FACT_LABELS.includes(label))).toEqual(
			[]
		);
	});

	test("lists distinct catalog entries, each described", () => {
		const items = entry.catalog?.items ?? [];
		expect(items.length).toBeGreaterThanOrEqual(4);
		expect(new Set(items.map((item) => item.title)).size).toBe(items.length);
		for (const item of items) {
			expect(item.description.length).toBeGreaterThan(0);
		}
	});

	test("links the docs page behind its Read the docs button, if it has one", () => {
		const product = getProduct(slug);
		const docsPath = product ? productDocsPath(product) : undefined;
		const paths = entry.docs?.map((link) => link.path) ?? [];
		expect(paths.length).toBeGreaterThanOrEqual(3);
		expect(new Set(paths).size).toBe(paths.length);
		if (docsPath) {
			expect(paths).toContain(docsPath);
		}
	});

	test("renders its profile sections, every catalog entry and every fact", () => {
		const html = page(slug);
		for (const key of FROM_PROFILE) {
			expect(html).toContain(PRODUCT_SECTION_MARKERS[key](slug));
		}
		const count = entry.catalog?.items.length ?? 0;
		expect(html).toContain(`data-catalog-count="${count}"`);
		for (const item of entry.catalog?.items ?? []) {
			expect(html).toContain(escaped(item.title));
			expect(html).toContain(escaped(item.description));
		}
		for (const fact of entry.facts) {
			expect(html).toContain(escaped(fact.value));
		}
	});

	test("opens on the catalog, ahead of the statement and the facts", () => {
		const html = page(slug);
		const at = (key: ProductSectionKey) =>
			html.indexOf(PRODUCT_SECTION_MARKERS[key](slug));
		expect(at("catalog")).toBeGreaterThan(-1);
		expect(at("statement")).toBeGreaterThan(at("catalog"));
		expect(at("at-a-glance")).toBeGreaterThan(at("statement"));
	});
});

test("Marketplace lists listing kinds, each opening its own web Marketplace page", () => {
	const segments = marketplaceSegments();
	expect(segments).toContain("apps");
	const items = profile("marketplace").catalog?.items ?? [];
	const hrefs = items.map((item) => item.href);
	expect(new Set(hrefs).size).toBe(items.length);
	for (const href of hrefs) {
		const segment = href?.match(/^\/marketplace\/([a-z-]+)$/)?.[1];
		expect(segments).toContain(segment ?? `missing: ${href}`);
		expect(page("marketplace")).toContain(`href="${href}"`);
	}
});

test("Marketplace's listing-kind count matches the shared Browse kinds", () => {
	const browse = readRepoFile(
		"packages/marketplace/src/catalog/chrome/marketplace-sections.ts"
	);
	const block = browse.match(
		/MARKETPLACE_BROWSE_KINDS = \[([\s\S]*?)\] as const/
	)?.[1];
	const kinds = [...(block ?? "").matchAll(/value: "([a-z_]+)"/g)].length;
	const fact = profile("marketplace").facts.find(
		(row) => row.label === "Listing kinds in all"
	);
	expect(fact?.value).toBe(String(kinds));
	const catalog = profile("marketplace").catalog;
	expect((catalog?.items.length ?? 0) < kinds).toBe(true);
	// The grid shows a selection, so its count must not read as the total.
	expect(catalog?.countLabel).toBe("Shown here");
	const html = page("marketplace");
	expect(html).toMatch(
		new RegExp(`>${catalog?.items.length}</span><span[^>]*>Shown here<`)
	);
	expect(html).not.toContain(">Listed below<");
	expect(html).toContain("Listing kinds in all");
});

test("Connections lists the four access levels, recommended one first, without links", () => {
	const items = profile("connections").catalog?.items ?? [];
	expect(items.map((item) => item.title)).toEqual([
		"Risk-based (recommended)",
		"Read only",
		"Write access",
		"Full access, including delete",
	]);
	expect(items.every((item) => item.href === undefined)).toBe(true);
	expect(
		profile("connections").facts.find((row) => row.label === "Default access")
			?.value
	).toBe("Risk-based");
});

test("Connections links its comparisons; Marketplace makes none", () => {
	for (const compareSlug of profile("connections").compareSlugs ?? []) {
		expect(page("connections")).toContain(`href="/compare/${compareSlug}"`);
	}
	expect(profile("connections").compareSlugs).toEqual(["composio", "zapier"]);
	expect(profile("marketplace").compareSlugs).toBeUndefined();
});

test("the two catalog pages tell different stories", () => {
	expect(page("marketplace")).toContain("What you can install");
	expect(page("connections")).toContain("How much each account may do");
	expect(page("marketplace")).not.toContain("Read only");
	expect(page("connections")).not.toContain("/marketplace/apps");
});
