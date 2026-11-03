import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { getProduct } from "../data/products.tsx";
import ProductLandingPage from "../product-landing-page.tsx";
import { PRODUCT_SECTION_MARKERS } from "./archetypes.ts";
import type { ProductSectionKey } from "./profile-types.ts";
import { PROFILES } from "./profiles-infrastructure-a.ts";

function page(slug: string): string {
	const product = getProduct(slug);
	if (!product) {
		throw new Error(`No catalog product ${slug}`);
	}
	return renderToStaticMarkup(<ProductLandingPage product={product} />);
}

const SHARED: readonly ProductSectionKey[] = [
	"at-a-glance",
	"architecture",
	"comparison",
	"security",
	"related",
	"docs",
];

describe("infrastructure-a pages render their profile sections", () => {
	for (const slug of ["core", "gateway", "cloud"] as const) {
		test(slug, () => {
			const html = page(slug);
			for (const key of SHARED) {
				expect([
					slug,
					key,
					html.includes(PRODUCT_SECTION_MARKERS[key](slug)),
				]).toEqual([slug, key, true]);
			}
			const profile = PROFILES[slug];
			expect(profile?.architecture?.title).toBeTruthy();
			expect(html).toContain(profile?.architecture?.title ?? "");
			// Core and Gateway show install and request code; Cloud is managed.
			expect(html.includes(PRODUCT_SECTION_MARKERS.code(slug))).toBe(
				slug !== "cloud"
			);
			// Only the Gateway refuses a call in its terminal demo.
			expect(html.includes(PRODUCT_SECTION_MARKERS.guardrail(slug))).toBe(
				slug === "gateway"
			);
		});
	}

	test("compare links render only where the profile lists comparisons", () => {
		for (const slug of ["core", "gateway", "cloud"] as const) {
			const listed = (PROFILES[slug]?.compareSlugs ?? []).length > 0;
			expect([
				slug,
				page(slug).includes(PRODUCT_SECTION_MARKERS.compare(slug)),
			]).toEqual([slug, listed]);
		}
	});
});
