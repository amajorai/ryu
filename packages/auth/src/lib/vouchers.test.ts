import { describe, expect, it } from "bun:test";
import { PLANS, type PlanId } from "./plans.ts";
import {
	FIRST_PURCHASE_VOUCHER_BASIS_POINTS,
	FIRST_PURCHASE_VOUCHER_CODE,
	FIRST_PURCHASE_VOUCHER_EXCLUSIONS,
	FIRST_PURCHASE_VOUCHER_SLUGS,
	voucherAppliesToSlug,
} from "./vouchers.ts";

/**
 * THE MARGIN GUARD for the first-purchase voucher.
 *
 * `vouchers.ts` lists which plans a 10%-off code may be redeemed against, and
 * that list is a money decision, not a preference. This file re-derives the
 * worst-case first-period margin from the LIVE plan catalog and fails if any
 * eligible slug goes underwater — so raising a credit pool or cutting a price
 * breaks a test rather than a P&L.
 *
 * Note what this file does NOT decide any more: yearly products are excluded by
 * the COPY rule ("your first month"), not by their margin. Polar's `once`
 * duration covers the whole billing period, so a yearly product would receive
 * about ten times the advertised first-month discount. See
 * `plan-economics.test.ts` for the margin invariants that guard the catalog.
 *
 * WORST CASE means the assumption that makes the number a FLOOR: the subscriber
 * spends 100% of the included credit pool. Pools are use-it-or-lose-it (the
 * subscription bucket is RESET each period by `resetSubscriptionBucket`, never
 * rolled over), so unspent credit only ever makes the real figure better.
 *
 * The model is deliberately kept HERE rather than in `vouchers.ts`: the voucher
 * module is imported by public React trees and must stay free of the plan
 * catalog (see its header). A test has no such constraint.
 */

/**
 * Conservative monthly infrastructure reserve for Pro's included base node.
 */
const BASE_NODE_USD_PER_MONTH = 12;

/**
 * Polar is the merchant of record. Use the conservative current subscription
 * processing case: 6.5% + $0.50, including the listed international-card
 * surcharge.
 */
const PROCESSOR_RATE = 0.065;
const PROCESSOR_FIXED_USD = 0.5;

/** Yearly plans bill 10 months and serve 12 ("two months free"). */
const YEARLY_MONTHS_BILLED = 10;
const YEARLY_MONTHS_SERVED = 12;

const MICRO_USD_PER_USD = 1_000_000;
const usd = (micro: number): number => micro / MICRO_USD_PER_USD;

interface Offering {
	interval: "monthly" | "yearly";
	plan: PlanId;
	seats: number;
	slug: string;
}

/**
 * Every recurring offering in the catalog, with the seat count a real checkout
 * would carry (Teams' floor is 5; Max's is 1). The one-time desktop licence and
 * the ad-hoc cloud instance are absent on purpose — neither has a credit pool or
 * a billing period, so this model says nothing about them and they are excluded
 * from the voucher for reasons `vouchers.ts` records separately.
 */
const OFFERINGS: readonly Offering[] = [
	{ slug: "pro-monthly", plan: "pro", interval: "monthly", seats: 1 },
	{ slug: "pro-yearly", plan: "pro", interval: "yearly", seats: 1 },
	{ slug: "max-monthly", plan: "max", interval: "monthly", seats: 1 },
	{ slug: "max-yearly", plan: "max", interval: "yearly", seats: 1 },
	{ slug: "teams-monthly", plan: "teams", interval: "monthly", seats: 5 },
	{ slug: "teams-yearly", plan: "teams", interval: "yearly", seats: 5 },
];

/**
 * Ryu's margin on the FIRST billing period of `offering`, in USD, after a
 * discount of `discountBps` basis points.
 *
 * The interval is what makes this worth computing rather than eyeballing: a
 * Polar `once` discount applies to the whole first billing period, so on a
 * yearly product a "10% off" is ten percent of a YEAR — while the credit pool
 * the plan owes over that same year is twelve monthly grants, not ten.
 */
function firstPeriodMarginUsd(
	offering: Offering,
	discountBps: number,
	processorRate: number = PROCESSOR_RATE
): number {
	const plan = PLANS[offering.plan];
	const monthlyPrice = usd(plan.monthlyPriceMicroUsd);
	const monthlyPool = usd(plan.monthlyCreditPoolMicroUsd);

	const monthsBilled =
		offering.interval === "yearly" ? YEARLY_MONTHS_BILLED : 1;
	const monthsServed =
		offering.interval === "yearly" ? YEARLY_MONTHS_SERVED : 1;

	const list = monthlyPrice * monthsBilled * offering.seats;
	const charged = list * (1 - discountBps / 10_000);

	// OpenRouter's 5.5% funding fee is above its $0.80 minimum for Pro's pool.
	// The free base node is ONE node per org, so it does not scale with seats.
	const poolFunding =
		monthlyPool > 0 ? monthlyPool + Math.max(monthlyPool * 0.055, 0.8) : 0;
	const credits = poolFunding * monthsServed * offering.seats;
	const node = BASE_NODE_USD_PER_MONTH * monthsServed;
	const fee = charged * processorRate + PROCESSOR_FIXED_USD;

	return charged - credits - node - fee;
}

const offeringFor = (slug: string): Offering => {
	const found = OFFERINGS.find((o) => o.slug === slug);
	if (!found) {
		throw new Error(`No margin model for slug: ${slug}`);
	}
	return found;
};

describe("first-purchase voucher", () => {
	it("is a typable alphanumeric code (Polar rejects anything else)", () => {
		expect(FIRST_PURCHASE_VOUCHER_CODE).toMatch(/^[A-Z0-9]{3,256}$/);
	});

	it("is exactly 10%", () => {
		expect(FIRST_PURCHASE_VOUCHER_BASIS_POINTS).toBe(1000);
	});

	it("never lists a slug it also excludes", () => {
		for (const slug of FIRST_PURCHASE_VOUCHER_SLUGS) {
			expect(FIRST_PURCHASE_VOUCHER_EXCLUSIONS[slug]).toBeUndefined();
		}
	});

	it("excludes max-yearly and the lifetime licence, with a reason each", () => {
		for (const slug of ["max-yearly", "lifetime"]) {
			expect(voucherAppliesToSlug(slug)).toBe(false);
			expect(FIRST_PURCHASE_VOUCHER_EXCLUSIONS[slug]).toBeTruthy();
		}
	});

	// THE COPY GUARD. The card page and the Polar discount name both promise "your
	// first month", and Polar's `once` is a first BILLING PERIOD — the two are the
	// same sentence only while every eligible product bills monthly. Adding a
	// yearly product silently turns a first-month discount into a first-year
	// discount, so the promise
	// is defended here rather than in a comment above the copy.
	it("is monthly-only, so 'your first month' is literally true", () => {
		for (const slug of FIRST_PURCHASE_VOUCHER_SLUGS) {
			expect(slug.endsWith("-monthly")).toBe(true);
		}
		for (const slug of ["pro-yearly", "max-yearly", "teams-yearly"]) {
			expect(voucherAppliesToSlug(slug)).toBe(false);
			expect(FIRST_PURCHASE_VOUCHER_EXCLUSIONS[slug]).toBeTruthy();
		}
	});
});

describe("first-purchase voucher margin", () => {
	// THE POINT OF THE FILE. Every recurring plan the code can be redeemed
	// against must still make money on the discounted period, under the
	// spend-the-whole-pool worst case.
	for (const slug of FIRST_PURCHASE_VOUCHER_SLUGS) {
		it(`${slug} stays profitable at 10% off`, () => {
			const margin = firstPeriodMarginUsd(
				offeringFor(slug),
				FIRST_PURCHASE_VOUCHER_BASIS_POINTS
			);
			expect(margin).toBeGreaterThan(0);
		});

		it(`${slug} stays profitable at 10% off even at a 6% processor rate`, () => {
			const margin = firstPeriodMarginUsd(
				offeringFor(slug),
				FIRST_PURCHASE_VOUCHER_BASIS_POINTS,
				0.06
			);
			expect(margin).toBeGreaterThan(0);
		});
	}

	// WHY YEARLY IS EXCLUDED: the discount is scoped to the first billing period.
	//
	// A Polar `once` discount covers a whole BILLING PERIOD, and a yearly period is
	// ten months of billing. A card promising "10% off your first month" would
	// therefore pay out about ten times what it says.
	it("a yearly product would discount ~10x what the card advertises", () => {
		const yearly = offeringFor("max-yearly");
		const monthly = offeringFor("max-monthly");
		const plan = PLANS[yearly.plan];

		const monthlyGiveaway =
			usd(plan.monthlyPriceMicroUsd) *
			monthly.seats *
			(FIRST_PURCHASE_VOUCHER_BASIS_POINTS / 10_000);
		const yearlyGiveaway =
			usd(plan.monthlyPriceMicroUsd) *
			YEARLY_MONTHS_BILLED *
			yearly.seats *
			(FIRST_PURCHASE_VOUCHER_BASIS_POINTS / 10_000);

		expect(yearlyGiveaway).toBeCloseTo(monthlyGiveaway * YEARLY_MONTHS_BILLED);
		expect(voucherAppliesToSlug("max-yearly")).toBe(false);
	});
});
