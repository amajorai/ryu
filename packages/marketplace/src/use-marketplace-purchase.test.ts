// Unit tests for the paid-path purchase decision. `purchaseAction` is the pure
// branch `buy()` runs after the checkout hand-off returns: it decides whether the
// org already owns the item, whether checkout can start, or whether the result is
// unusable. The ordering is load-bearing — an already-owned result carries an
// empty `url`, so the ownership check MUST win over the missing-url check, or an
// owned item would be misreported as "could not start checkout".

import { describe, expect, test } from "bun:test";
import type { PurchaseResult } from "./types.ts";
import { purchaseAction } from "./use-marketplace-purchase.ts";

function result(over: Partial<PurchaseResult> = {}): PurchaseResult {
	return { alreadyLicensed: false, url: "", ...over };
}

describe("purchaseAction", () => {
	test("a fresh purchase with a checkout URL routes to checkout", () => {
		expect(
			purchaseAction(result({ url: "https://checkout.stripe.com/x" }))
		).toEqual({ kind: "checkout", url: "https://checkout.stripe.com/x" });
	});

	test("an already-owned result routes to owned (no charge)", () => {
		expect(purchaseAction(result({ alreadyLicensed: true }))).toEqual({
			kind: "owned",
		});
	});

	test("ownership wins even when a stray URL is present (ordering guard)", () => {
		// Regression pin: if the missing-url check ran first this would misroute to
		// error/checkout instead of owned.
		expect(
			purchaseAction(
				result({ alreadyLicensed: true, url: "https://checkout.stripe.com/x" })
			)
		).toEqual({ kind: "owned" });
	});

	test("a not-owned result with an empty URL is an error", () => {
		expect(purchaseAction(result({ alreadyLicensed: false, url: "" }))).toEqual({
			kind: "error",
		});
	});
});
