import { describe, expect, it } from "bun:test";
import { POLAR_PRODUCTS } from "./constants.ts";
import {
	FIRST_PURCHASE_VOUCHER_EXCLUSIONS,
	voucherAppliesToSlug,
} from "./vouchers.ts";

describe("first-purchase voucher coverage", () => {
	// Every checkout product is either eligible or excluded with a stated reason.
	// A product added to the catalog without a decision fails here instead of
	// silently sitting outside both lists.
	it("decides every Polar product slug", () => {
		// Guard against a vacuous pass if the catalog import ever comes back empty.
		expect(POLAR_PRODUCTS.length).toBeGreaterThan(0);
		for (const { slug } of POLAR_PRODUCTS) {
			const decided =
				voucherAppliesToSlug(slug) ||
				Object.hasOwn(FIRST_PURCHASE_VOUCHER_EXCLUSIONS, slug);
			expect({ decided, slug }).toEqual({ decided: true, slug });
		}
	});
});
