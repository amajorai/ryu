import { describe, expect, it } from "bun:test";
import {
	allocateMarketplaceMembershipPool,
	annualizedMarketplacePriceMinor,
	isMarketplaceMembershipListingEligible,
	isRecurringMarketplacePlan,
	marketplaceTierMultiplier,
} from "./marketplace-membership.ts";

describe("isRecurringMarketplacePlan", () => {
	it("funds the publisher pool only from A Major Pass", () => {
		expect(isRecurringMarketplacePlan("marketplace-membership")).toBe(true);
		for (const plan of ["pro", "max", "teams", "business"] as const) {
			expect(isRecurringMarketplacePlan(plan)).toBe(false);
		}
	});
});

describe("annualizedMarketplacePriceMinor", () => {
	it("annualizes monthly subscription pricing", () => {
		expect(
			annualizedMarketplacePriceMinor({
				amountMinor: 999,
				interval: "month",
				model: "subscription",
			})
		).toBe(11_988);
	});

	it("keeps yearly subscription pricing at its yearly amount", () => {
		expect(
			annualizedMarketplacePriceMinor({
				amountMinor: 9999,
				interval: "year",
				model: "subscription",
			})
		).toBe(9999);
	});

	it("does not annualize one-time or bounded-update offers", () => {
		expect(
			annualizedMarketplacePriceMinor({
				amountMinor: 2500,
				interval: "month",
				model: "one_time",
			})
		).toBe(2500);
		expect(
			annualizedMarketplacePriceMinor({
				amountMinor: 3500,
				interval: "month",
				model: "bounded_updates",
			})
		).toBe(3500);
	});
});

describe("marketplaceTierMultiplier", () => {
	it("uses the Setapp-shaped price tiers", () => {
		expect(
			marketplaceTierMultiplier({
				amountMinor: 999,
				currency: "usd",
				interval: "month",
				model: "subscription",
			})
		).toBe(57);
		expect(
			marketplaceTierMultiplier({
				amountMinor: 17_400,
				currency: "usd",
				interval: "year",
				model: "subscription",
			})
		).toBe(100);
	});

	it("uses the lowest multiplier for malformed or sub-dollar prices", () => {
		expect(
			marketplaceTierMultiplier({
				amountMinor: 0,
				currency: "usd",
				interval: "month",
				model: "one_time",
			})
		).toBe(1);
	});
});

describe("allocateMarketplaceMembershipPool", () => {
	it("allocates the configured publisher pool by app weight", () => {
		expect(
			allocateMarketplaceMembershipPool({
				invoiceMinor: 999,
				publisherShareBps: 7000,
				apps: [
					{ appId: "a", publisherOrgId: "pub-a", multiplier: 10 },
					{ appId: "b", publisherOrgId: "pub-b", multiplier: 20 },
				],
			})
		).toEqual([
			{ appId: "a", publisherOrgId: "pub-a", amountMinor: 233 },
			{ appId: "b", publisherOrgId: "pub-b", amountMinor: 466 },
		]);
	});

	it("assigns rounding remainder deterministically to the heaviest app", () => {
		expect(
			allocateMarketplaceMembershipPool({
				invoiceMinor: 100,
				publisherShareBps: 7000,
				apps: [
					{ appId: "a", publisherOrgId: "pub-a", multiplier: 1 },
					{ appId: "b", publisherOrgId: "pub-b", multiplier: 2 },
				],
			})
		).toEqual([
			{ appId: "a", publisherOrgId: "pub-a", amountMinor: 23 },
			{ appId: "b", publisherOrgId: "pub-b", amountMinor: 47 },
		]);
	});

	it("deduplicates app usage and returns no rows when no app was used", () => {
		expect(
			allocateMarketplaceMembershipPool({
				invoiceMinor: 999,
				publisherShareBps: 7000,
				apps: [
					{ appId: "a", publisherOrgId: "pub-a", multiplier: 5 },
					{ appId: "a", publisherOrgId: "pub-a", multiplier: 5 },
				],
			})
		).toEqual([{ appId: "a", publisherOrgId: "pub-a", amountMinor: 699 }]);
		expect(
			allocateMarketplaceMembershipPool({
				invoiceMinor: 999,
				publisherShareBps: 7000,
				apps: [],
			})
		).toEqual([]);
	});
});

describe("isMarketplaceMembershipListingEligible", () => {
	const app = {
		kind: "app",
		marketplaceVisibility: "public",
		origin: "first_party",
		pricing: {
			membershipOptIn: true,
			model: "subscription",
			sellerOrgId: "publisher-org",
		},
		status: "live",
	};

	it("accepts a live, opted-in paid app with payout readiness", () => {
		expect(
			isMarketplaceMembershipListingEligible(app, { payoutsEnabled: true })
		).toBe(true);
	});

	it("rejects free, plugin, private, community, or payout-disabled listings", () => {
		for (const listing of [
			{ ...app, kind: "plugin" },
			{ ...app, origin: "community" },
			{ ...app, marketplaceVisibility: "organization" },
			{ ...app, pricing: { ...app.pricing, membershipOptIn: false } },
			{ ...app, pricing: { ...app.pricing, model: "free" } },
		]) {
			expect(
				isMarketplaceMembershipListingEligible(listing, {
					payoutsEnabled: true,
				})
			).toBe(false);
		}
		expect(
			isMarketplaceMembershipListingEligible(app, { payoutsEnabled: false })
		).toBe(false);
	});
});
