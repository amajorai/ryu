import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { getProduct } from "../data/products.tsx";
import {
	formatMailAllowance,
	PUBLISHED_PRICING,
} from "../data/standalone-pricing.ts";
import ProductLandingPage from "../product-landing-page.tsx";
import {
	PRODUCT_SECTION_MARKERS,
	PRODUCT_SIDE_BY_SIDE_TEST_ID,
} from "./archetypes.ts";
import type { ProductSectionKey } from "./profile-types.ts";
import { PROFILE_SLUGS, type ProfileSlug } from "./profiles-agent-api-b.ts";

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

/** Sections every agent-api-b page renders from its profile. */
const DATASHEET: readonly ProductSectionKey[] = [
	"code",
	"interfaces",
	"api",
	"at-a-glance",
	"limits",
	"related",
	"docs",
];

const marker = (key: ProductSectionKey, slug: ProfileSlug) =>
	PRODUCT_SECTION_MARKERS[key](slug);

describe.each(PROFILE_SLUGS)("%s product page", (slug) => {
	test("renders its datasheet sections", () => {
		for (const key of DATASHEET) {
			expect(page(slug)).toContain(marker(key, slug));
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
});

test("Mail walks in with a quickstart and shows its plan allowances", () => {
	expect(page("mail")).toContain(marker("quickstart", "mail"));
	expect(page("mail")).not.toContain(marker("guardrail", "mail"));
	// The quickstart replaces the generic three steps.
	expect(page("mail")).not.toContain(marker("how-it-works", "mail"));
	expect(page("mail")).toContain(
		formatMailAllowance(PUBLISHED_PRICING.mail.max)
	);
	expect(page("mail")).toContain("https://api.ryuhq.com");
	expect(page("mail")).toContain(marker("pricing", "mail"));
});

test("Messaging shows its refusals and never a dollar amount", () => {
	const html = page("messaging");
	expect(html).toContain(marker("guardrail", "messaging"));
	expect(html).toContain(marker("how-it-works", "messaging"));
	expect(html).not.toContain(marker("quickstart", "messaging"));
	expect(html).toContain("recipient_opted_out");
	expect(html).toContain("insufficient_credits");
	expect(html).toContain(marker("pricing", "messaging"));
	expect(html).not.toMatch(/\$\s?\d/);
});

test("Sites shows the blocked deploy, no base URL and no price", () => {
	const html = page("sites");
	expect(html).toContain(marker("guardrail", "sites"));
	expect(html).toContain("security_blocked");
	expect(html).toContain(marker("how-it-works", "sites"));
	expect(html).not.toContain(marker("pricing", "sites"));
	expect(html).not.toContain("Base URL");
	expect(html).not.toMatch(/\$\s?\d/);
});
