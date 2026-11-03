import { expect, test } from "bun:test";
import { STANDALONE_PRODUCT_PRICING } from "../data/standalone-pricing.ts";
import { hasPublishedPricing as reExported } from "../product-landing-page.tsx";
import { hasPublishedPricing } from "./published-pricing.ts";

test("published prices show; early access without a price does not", () => {
	expect(hasPublishedPricing("gateway")).toBe(true);
	expect(hasPublishedPricing("box")).toBe(true);
	expect(hasPublishedPricing("mail")).toBe(true);
	expect(hasPublishedPricing("sites")).toBe(false);
	expect(hasPublishedPricing("core")).toBe(false);
	expect(hasPublishedPricing("not-a-product")).toBe(false);
});

test("every standalone entry is decided by its status and price text", () => {
	for (const entry of STANDALONE_PRODUCT_PRICING) {
		const unpublished =
			entry.status === "Early access" &&
			/\bnot (?:yet )?(?:published|available)\b/i.test(entry.price);
		expect([entry.slug, hasPublishedPricing(entry.slug)]).toEqual([
			entry.slug,
			!unpublished,
		]);
	}
});

test("the product landing page keeps re-exporting the helper", () => {
	expect(reExported).toBe(hasPublishedPricing);
});
