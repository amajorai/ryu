import { describe, expect, it } from "bun:test";
import {
	currentPlanVersionFor,
	monthlyCreditPoolMicroUsdForSeats,
	monthlyPriceMicroUsdForSeats,
	PLAN_MONTHLY_PRICE_MICRO_USD,
	PLANS,
	type PlanId,
	type PlanVersion,
	planVersionFor,
} from "@ryu/auth/lib/plans";
import {
	BUSINESS_ADDITIONAL_SEAT_USD,
	BUSINESS_BASE_MONTHLY_USD,
	BUSINESS_CREDIT_BUNDLE_SIZE,
	BUSINESS_INCLUDED_CREDIT_USD,
	BUSINESS_INCLUDED_SEATS,
	businessIncludedCreditUsd,
	businessMonthlyPriceUsd,
} from "./business-pricing.ts";
import {
	type HostedAgentPricingPlanId,
	hostedAgentIncludedCreditUsd,
	hostedAgentMonthlyPriceUsd,
	MARKETPLACE_PASS_MONTHLY_USD,
	MAX_INCLUDED_USD,
	MAX_MONTHLY_USD,
	PLUS_INCLUDED_USD,
	PLUS_MONTHLY_USD,
	PRO_INCLUDED_USD,
	PRO_MONTHLY_USD,
	TEAMS_AGENT_STANDARD_USD,
	TEAMS_INCLUDED_CREDIT_BUNDLE_SIZE,
	TEAMS_INCLUDED_PER_BUNDLE_USD,
	TEAMS_INCLUDED_USD,
	TEAMS_LITE_ADDITIONAL_SEAT_USD,
	TEAMS_LITE_INCLUDED_CREDIT_BUNDLE_SIZE,
	TEAMS_LITE_INCLUDED_PER_BUNDLE_USD,
	TEAMS_LITE_INCLUDED_USD,
	TEAMS_LITE_MONTHLY_PER_SEAT_USD,
	TEAMS_LITE_MONTHLY_USD,
	TEAMS_MONTHLY_PER_SEAT_USD,
	TEAMS_MONTHLY_USD,
} from "./pricing.tsx";
import { TEAMS_MAX_SEATS, TEAMS_MIN_SEATS } from "./pricing-seat-model.ts";

/**
 * The pricing cards mirror the billing catalog instead of importing it (the
 * catalog carries Polar product ids and env-var names that must not reach a
 * browser bundle). This suite is the guard that keeps those mirrors honest: a
 * catalog change fails here until the card constants follow it.
 */

const MICRO_USD_PER_USD = 1_000_000;
const usd = (microUsd: number): number => microUsd / MICRO_USD_PER_USD;

/** The row a new checkout is stamped with today. */
const current = (plan: PlanId): PlanVersion =>
	planVersionFor(plan, currentPlanVersionFor(plan));

const priceAt = (plan: PlanId, seats: number): number =>
	usd(
		monthlyPriceMicroUsdForSeats({
			plan: PLANS[plan],
			seats,
			version: current(plan),
		})
	);

const poolAt = (plan: PlanId, seats: number): number =>
	usd(
		monthlyCreditPoolMicroUsdForSeats({
			plan: PLANS[plan],
			seats,
			version: current(plan),
		})
	);

const minSeats = (plan: PlanId): number => {
	const model = PLANS[plan].seatModel;
	return model.kind === "per_seat" ? model.minSeats : 1;
};

describe("pricing card constants mirror the billing catalog", () => {
	it("individual list prices match the current version rows", () => {
		const mirrors: readonly (readonly [PlanId, number])[] = [
			["pro", PRO_MONTHLY_USD],
			["plus", PLUS_MONTHLY_USD],
			["max", MAX_MONTHLY_USD],
			["marketplace-membership", MARKETPLACE_PASS_MONTHLY_USD],
		];
		for (const [plan, mirrored] of mirrors) {
			expect({ plan, usd: mirrored }).toEqual({
				plan,
				usd: usd(PLAN_MONTHLY_PRICE_MICRO_USD[plan]),
			});
			expect({ plan, usd: mirrored }).toEqual({
				plan,
				usd: usd(current(plan).monthlyPriceMicroUsd),
			});
		}
	});

	it("individual included pools match the current version rows", () => {
		const mirrors: readonly (readonly [PlanId, number])[] = [
			["pro", PRO_INCLUDED_USD],
			["plus", PLUS_INCLUDED_USD],
			["max", MAX_INCLUDED_USD],
		];
		for (const [plan, mirrored] of mirrors) {
			expect({ plan, usd: mirrored }).toEqual({ plan, usd: poolAt(plan, 1) });
		}
	});

	it("organization seat minimums and floors match the catalog", () => {
		expect(TEAMS_MIN_SEATS).toBe(minSeats("teams"));
		expect(TEAMS_MIN_SEATS).toBe(minSeats("teams-lite"));
		expect(BUSINESS_INCLUDED_SEATS).toBe(minSeats("business"));

		expect(TEAMS_MONTHLY_PER_SEAT_USD).toBe(
			usd(PLAN_MONTHLY_PRICE_MICRO_USD.teams)
		);
		expect(TEAMS_MONTHLY_USD).toBe(priceAt("teams", TEAMS_MIN_SEATS));
		expect(TEAMS_LITE_MONTHLY_USD).toBe(priceAt("teams-lite", TEAMS_MIN_SEATS));
		expect(TEAMS_LITE_MONTHLY_PER_SEAT_USD).toBe(
			usd(PLAN_MONTHLY_PRICE_MICRO_USD["teams-lite"])
		);
		expect(TEAMS_LITE_ADDITIONAL_SEAT_USD).toBe(
			usd(current("teams-lite").additionalSeatPriceMicroUsd ?? Number.NaN)
		);
		expect(TEAMS_AGENT_STANDARD_USD).toBe(
			priceAt("teams", TEAMS_MIN_SEATS + 1) - priceAt("teams", TEAMS_MIN_SEATS)
		);
		expect(BUSINESS_BASE_MONTHLY_USD).toBe(
			usd(current("business").baseMonthlyPriceMicroUsd ?? Number.NaN)
		);
		expect(BUSINESS_BASE_MONTHLY_USD).toBe(
			priceAt("business", BUSINESS_INCLUDED_SEATS)
		);
		expect(BUSINESS_ADDITIONAL_SEAT_USD).toBe(
			usd(current("business").additionalSeatPriceMicroUsd ?? Number.NaN)
		);
	});

	it("organization pool bundles match the current version rows", () => {
		expect(TEAMS_INCLUDED_USD).toBe(poolAt("teams", TEAMS_MIN_SEATS));
		expect(TEAMS_INCLUDED_PER_BUNDLE_USD).toBe(
			usd(current("teams").monthlyCreditPoolMicroUsd)
		);
		expect(TEAMS_INCLUDED_CREDIT_BUNDLE_SIZE).toBe(
			current("teams").creditPoolBundleSize ?? Number.NaN
		);
		expect(TEAMS_LITE_INCLUDED_USD).toBe(poolAt("teams-lite", TEAMS_MIN_SEATS));
		expect(TEAMS_LITE_INCLUDED_PER_BUNDLE_USD).toBe(
			usd(current("teams-lite").monthlyCreditPoolMicroUsd)
		);
		expect(TEAMS_LITE_INCLUDED_CREDIT_BUNDLE_SIZE).toBe(
			current("teams-lite").creditPoolBundleSize ?? Number.NaN
		);
		expect(BUSINESS_INCLUDED_CREDIT_USD).toBe(
			usd(current("business").monthlyCreditPoolMicroUsd)
		);
		expect(BUSINESS_CREDIT_BUNDLE_SIZE).toBe(
			current("business").creditPoolBundleSize ?? Number.NaN
		);
	});

	it("card price and pool helpers equal the catalog at every self-serve seat count", () => {
		const plans: readonly HostedAgentPricingPlanId[] = [
			"teams",
			"teams-lite",
			"business",
		];
		for (const plan of plans) {
			for (let seats = TEAMS_MIN_SEATS; seats <= TEAMS_MAX_SEATS; seats++) {
				expect({
					plan,
					seats,
					price: hostedAgentMonthlyPriceUsd(plan, seats),
					pool: hostedAgentIncludedCreditUsd(plan, seats),
				}).toEqual({
					plan,
					seats,
					price: priceAt(plan, seats),
					pool: poolAt(plan, seats),
				});
			}
		}
		for (let seats = BUSINESS_INCLUDED_SEATS; seats <= 50; seats++) {
			expect(businessMonthlyPriceUsd(seats)).toBe(priceAt("business", seats));
			expect(businessIncludedCreditUsd(seats)).toBe(poolAt("business", seats));
		}
	});
});
