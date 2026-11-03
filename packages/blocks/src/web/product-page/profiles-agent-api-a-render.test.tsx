import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { getProduct } from "../data/products.tsx";
import ProductLandingPage from "../product-landing-page.tsx";
import {
	PRODUCT_SECTION_MARKERS,
	PRODUCT_SIDE_BY_SIDE_TEST_ID,
} from "./archetypes.ts";
import type { ProductSectionKey } from "./profile-types.ts";
import {
	PROFILE_SLUGS,
	PROFILES,
	type ProfileSlug,
} from "./profiles-agent-api-a.ts";

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

/** Sections every agent-api-a page renders from its profile. */
const DATASHEET: readonly ProductSectionKey[] = [
	"code",
	"interfaces",
	"api",
	"at-a-glance",
	"limits",
	"related",
	"docs",
];

describe.each(PROFILE_SLUGS)("%s product page", (slug) => {
	test("renders its datasheet sections", () => {
		for (const key of DATASHEET) {
			expect(page(slug)).toContain(PRODUCT_SECTION_MARKERS[key](slug));
		}
	});

	test("puts the code beside the ways to call it", () => {
		expect(page(slug)).toContain(
			`data-testid="${PRODUCT_SIDE_BY_SIDE_TEST_ID}"`
		);
	});

	test("links its OpenAPI document and says the SDK is not published", () => {
		expect(page(slug)).toContain(`href="/openapi/${slug}.json"`);
		expect(page(slug)).toContain("Not published yet.");
		expect(page(slug)).not.toMatch(/npm (?:i|install) @ryuhq\/services/);
	});

	test("shows the published price in its limits table", () => {
		const firstPricedRow = PROFILES[slug]?.limits?.rows.find((row) =>
			row.value.includes("$")
		);
		expect(firstPricedRow).toBeDefined();
		expect(page(slug)).toContain(firstPricedRow?.value ?? "missing");
	});
});

test("Box and Notify show their public API host; Passport and Connect show none", () => {
	expect(page("box")).toContain("https://box.ryuhq.com");
	expect(page("notify")).toContain("https://notify.ryuhq.com");
	expect(page("passport")).not.toContain("passport.ryuhq.com");
	expect(page("connect")).not.toContain("connect.ryuhq.com");
});

test("Passport and Notify show a refusal; Connect and Box show a quickstart", () => {
	const guardrail = PRODUCT_SECTION_MARKERS.guardrail;
	const quickstart = PRODUCT_SECTION_MARKERS.quickstart;
	const howItWorks = PRODUCT_SECTION_MARKERS["how-it-works"];
	for (const slug of ["passport", "notify"] as const) {
		expect(page(slug)).toContain(guardrail(slug));
		expect(page(slug)).not.toContain(quickstart(slug));
		expect(page(slug)).toContain(howItWorks(slug));
	}
	for (const slug of ["connect", "box"] as const) {
		expect(page(slug)).toContain(quickstart(slug));
		expect(page(slug)).not.toContain(guardrail(slug));
		// The quickstart replaces the generic three steps.
		expect(page(slug)).not.toContain(howItWorks(slug));
	}
	expect(page("notify")).toContain("[REDACTED]");
	expect(page("passport")).toContain("403 forbidden");
});

test("Connect and Box link their comparisons", () => {
	expect(page("connect")).toContain(PRODUCT_SECTION_MARKERS.compare("connect"));
	expect(page("connect")).toContain('href="/compare/composio"');
	expect(page("box")).toContain('href="/compare/boat"');
});
