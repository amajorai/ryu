import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { getProduct } from "../data/products.tsx";
import ProductLandingPage from "../product-landing-page.tsx";
import { PRODUCT_SECTION_MARKERS } from "./archetypes.ts";
import type { ProductSectionKey } from "./profile-types.ts";
import {
	PROFILE_SLUGS,
	PROFILES,
	type ProfileSlug,
} from "./profiles-workspace.ts";
import { AVAILABILITY_STATE_LABELS } from "./sections/availability-matrix.tsx";

function renderPage(slug: ProfileSlug): string {
	const product = getProduct(slug);
	if (!product) {
		throw new Error(`unknown product ${slug}`);
	}
	return renderToStaticMarkup(<ProductLandingPage product={product} />);
}

const pages = new Map(PROFILE_SLUGS.map((slug) => [slug, renderPage(slug)]));

function page(slug: ProfileSlug): string {
	return pages.get(slug) ?? "";
}

/** Sections every workspace page renders from its profile. */
const FROM_PROFILE: readonly ProductSectionKey[] = [
	"availability",
	"at-a-glance",
	"compare",
	"related",
	"docs",
];

/** HTML-escape a value the way React writes text content. */
function escaped(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

describe.each(PROFILE_SLUGS)("%s product page", (slug) => {
	test("renders its profile sections", () => {
		for (const key of FROM_PROFILE) {
			expect(page(slug)).toContain(PRODUCT_SECTION_MARKERS[key](slug));
		}
	});

	test("puts availability right after the explorer, before the facts", () => {
		const html = page(slug);
		const at = (key: ProductSectionKey) =>
			html.indexOf(PRODUCT_SECTION_MARKERS[key](slug));
		expect(at("explorer")).toBeGreaterThan(-1);
		expect(at("availability")).toBeGreaterThan(at("explorer"));
		expect(at("at-a-glance")).toBeGreaterThan(at("availability"));
	});

	test("shows every platform with its state in words, and every fact", () => {
		const html = page(slug);
		const entry = PROFILES[slug];
		for (const row of entry?.availability ?? []) {
			expect(html).toContain(escaped(row.platform));
			expect(html).toContain(`data-availability-state="${row.state}"`);
			expect(html).toContain(AVAILABILITY_STATE_LABELS[row.state]);
		}
		for (const fact of entry?.facts ?? []) {
			expect(html).toContain(escaped(fact.value));
		}
	});

	test("links each comparison it lists", () => {
		for (const compareSlug of PROFILES[slug]?.compareSlugs ?? []) {
			expect(page(slug)).toContain(`href="/compare/${compareSlug}"`);
		}
	});
});

test("each workspace page tells a different availability story", () => {
	expect(page("desktop")).toContain("Windows 10 or 11, 64-bit.");
	expect(page("agent")).toContain("Self-hosted or local node");
	expect(page("bot")).toContain("Ryu Bot app");
	expect(page("chrome-extension")).toContain(
		"Not on the Chrome Web Store yet."
	);
	expect(page("os")).toContain("Ryu Desktop on Windows and Linux");
	expect(page("chrome-extension")).not.toContain("Firefox");
	expect(page("desktop")).not.toContain("Self-hosted or local node");
});

test("Ryu for Chrome titles its matrix by place, the others by platform", () => {
	expect(page("chrome-extension")).toMatch(/<h2[^>]*>Where it appears<\/h2>/);
	expect(page("chrome-extension")).not.toContain(">Where it runs<");
	expect(page("desktop")).toMatch(/<h2[^>]*>Where it runs<\/h2>/);
});
