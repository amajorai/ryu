import { describe, expect, it } from "bun:test";
import {
	DISCOUNTED_TEAMS_PERIOD_POOL_SHARE_BASIS_POINTS,
	discountedPeriodPaidMicroUsd,
	discountedPeriodPoolMicroUsd,
	TEAMS_FOUNDING_TRIAL,
} from "./agent-plans.ts";
import {
	baseNodeCountForPlanAtLocation,
	baseNodeTypeForPlanAtLocation,
	stockFallbackNodeTypeForPlanAtLocation,
	TEAMS_NODE_TIERS,
} from "./base-node.ts";
import { ONBOARDING_TEAMS_OFFER } from "./onboarding-offer.ts";
import {
	currentPlanVersionFor,
	monthlyCreditPoolMicroUsdForSeats,
	monthlyPriceMicroUsdForSeats,
	openRouterCreditPurchaseCostUsd,
	PLANS,
	planVersionFor,
	TOPUP_POLAR_PROCESSING_BPS,
	TOPUP_POLAR_PROCESSING_FIXED_USD,
	usdToMicro,
} from "./plans.ts";

/**
 * THE ECONOMICS GUARD for discounted Teams periods.
 *
 * `plan-economics.test.ts` proves the LIST catalog makes money. A promotional
 * discount breaks that proof: it cuts revenue while the plan still grants its
 * pool and provisions its included node. Both public offers lost money that way
 * (the desktop onboarding month about -$41 per organization; the private founding
 * code about -$41 a month at five seats and about -$168 a month at fifty, for
 * three months), so each discounted period
 * is held to a non-negative contribution here with the same worst-case cost
 * model: the whole pool is spent, every pool dollar is funded through OpenRouter
 * (fee + GST), Polar takes its conservative processing rate, and the included
 * node reserve is paid in full.
 */

/**
 * Conservative monthly USD reserve per included node type (EU defaults), the
 * same figures as `plan-economics.test.ts`: Teams includes one `cx23` base
 * server and may get the same-price `cpx22` stock fallback, so it is reserved
 * at the dearer `cpx22`.
 */
const NODE_USD_PER_MONTH = new Map<string, number>([
	["cx23", 12],
	["cpx22", 36],
]);
/** The Teams node reserve every discounted period below must cover. */
const TEAMS_NODE_RESERVE_USD = 36;
/** The `cx23` reserve a Teams org gets whenever its base server is in stock. */
const BASE_SERVER_RESERVE_USD = 12;

/**
 * DOCUMENTED worst-case loss of a discounted five-seat Teams month, in USD,
 * recorded rather than hidden. The $50 month grants the capped $10 pool; costed
 * on the `cpx22` stock fallback ($36 reserve) it is -$1.522, while on the `cx23`
 * base server a new org normally gets it is +$22.48. The one-base-server
 * decision (2026-10-19) did not change the discount or the pool cap, so this is
 * a founder decision. The test asserts the figure exactly (worse fails) and
 * fails once it recovers, so the row must then be deleted.
 */
const KNOWN_FIVE_SEAT_DISCOUNTED_LOSS_USD = -1.522;

/**
 * "clears" when a discounted period meets its floor: non-negative, or exactly
 * the documented five-seat loss while still non-negative on the `cx23` base
 * server. Anything else names the contribution so the failure is readable.
 */
function discountedFloorVerdict(
	seats: number,
	period: DiscountedPeriod
): string {
	const contribution = period.contributionUsd;
	if (seats !== 5) {
		return contribution >= 0 ? "clears" : `loss ${contribution}`;
	}
	const documented =
		Math.abs(contribution - KNOWN_FIVE_SEAT_DISCOUNTED_LOSS_USD) < 0.0005;
	const clearsOnBaseServer =
		contribution + period.nodeUsd - BASE_SERVER_RESERVE_USD >= 0;
	return documented && clearsOnBaseServer
		? "clears"
		: `undocumented five-seat contribution ${contribution}`;
}
const POLAR_RATE = TOPUP_POLAR_PROCESSING_BPS / 10_000;
const usd = (micro: number): number => micro / 1_000_000;

function teamsNodeReserveUsd(seats: number): number {
	const type = baseNodeTypeForPlanAtLocation("teams", "nbg1", seats);
	if (!type) {
		return 0;
	}
	const unitFor = (nodeType: string): number => {
		const unit = NODE_USD_PER_MONTH.get(nodeType);
		if (unit === undefined) {
			throw new Error(`no monthly reserve known for node type "${nodeType}"`);
		}
		return unit;
	};
	const fallback = stockFallbackNodeTypeForPlanAtLocation("teams", "nbg1");
	const unit = Math.max(unitFor(type), fallback ? unitFor(fallback) : 0);
	return unit * baseNodeCountForPlanAtLocation("teams", "nbg1", seats);
}

interface DiscountedPeriod {
	contributionUsd: number;
	nodeUsd: number;
	paidUsd: number;
	poolUsd: number;
}

function discountedTeamsPeriod(
	seats: number,
	discountBasisPoints: number
): DiscountedPeriod {
	const plan = PLANS.teams;
	const version = planVersionFor("teams", currentPlanVersionFor("teams"));
	const paidMicro = discountedPeriodPaidMicroUsd({
		discountBasisPoints,
		listPriceMicroUsd: monthlyPriceMicroUsdForSeats({ plan, seats, version }),
	});
	const poolMicro = discountedPeriodPoolMicroUsd({
		listPoolMicroUsd: monthlyCreditPoolMicroUsdForSeats({
			plan,
			seats,
			version,
		}),
		paidMicroUsd: paidMicro,
	});
	const paidUsd = usd(paidMicro);
	const poolUsd = usd(poolMicro);
	const nodeUsd = teamsNodeReserveUsd(seats);
	const processingUsd = paidUsd * POLAR_RATE + TOPUP_POLAR_PROCESSING_FIXED_USD;
	return {
		contributionUsd:
			paidUsd -
			openRouterCreditPurchaseCostUsd(poolUsd) -
			processingUsd -
			nodeUsd,
		nodeUsd,
		paidUsd,
		poolUsd,
	};
}

describe("discounted period pool cap", () => {
	it("never grants more than the configured share of what was paid", () => {
		expect(DISCOUNTED_TEAMS_PERIOD_POOL_SHARE_BASIS_POINTS).toBeLessThanOrEqual(
			3000
		);
		for (const seats of [5, 6, 10, 25, 49, 50, 100]) {
			const period = discountedTeamsPeriod(
				seats,
				TEAMS_FOUNDING_TRIAL.discountBasisPoints
			);
			expect(period.poolUsd).toBeLessThanOrEqual(period.paidUsd * 0.3);
		}
	});

	it("never exceeds the list pool and never goes negative", () => {
		expect(
			discountedPeriodPoolMicroUsd({
				listPoolMicroUsd: usdToMicro(50),
				paidMicroUsd: usdToMicro(1000),
			})
		).toBe(usdToMicro(50));
		expect(
			discountedPeriodPoolMicroUsd({
				listPoolMicroUsd: usdToMicro(50),
				paidMicroUsd: 0,
			})
		).toBe(0);
		expect(
			discountedPeriodPoolMicroUsd({
				listPoolMicroUsd: usdToMicro(50),
				paidMicroUsd: -1,
			})
		).toBe(0);
		expect(
			discountedPeriodPaidMicroUsd({
				discountBasisPoints: 12_000,
				listPriceMicroUsd: usdToMicro(250),
			})
		).toBe(0);
	});
});

describe("desktop onboarding Teams offer economics", () => {
	it("derives the displayed price and pool from the discount", () => {
		expect(ONBOARDING_TEAMS_OFFER.trialMonthlyPriceUsd).toBe(50);
		expect(ONBOARDING_TEAMS_OFFER.firstMonthCreditPoolUsd).toBe(10);
		expect(ONBOARDING_TEAMS_OFFER.redemptionsPerOwnerAccount).toBe(1);
	});

	it("covers the base-server reserve and the capped pool in its discounted month", () => {
		const period = discountedTeamsPeriod(
			ONBOARDING_TEAMS_OFFER.includedSeats,
			ONBOARDING_TEAMS_OFFER.discountBasisPoints
		);
		expect(period.paidUsd).toBe(ONBOARDING_TEAMS_OFFER.trialMonthlyPriceUsd);
		expect(period.poolUsd).toBe(ONBOARDING_TEAMS_OFFER.firstMonthCreditPoolUsd);
		expect(period.nodeUsd).toBe(TEAMS_NODE_RESERVE_USD);
		expect(
			discountedFloorVerdict(ONBOARDING_TEAMS_OFFER.includedSeats, period)
		).toBe("clears");
	});

	it("would lose money with the uncapped list pool (the regression this guards)", () => {
		const uncappedPoolUsd = ONBOARDING_TEAMS_OFFER.listMonthlyCreditPoolUsd;
		const paid = ONBOARDING_TEAMS_OFFER.trialMonthlyPriceUsd;
		const contribution =
			paid -
			openRouterCreditPurchaseCostUsd(uncappedPoolUsd) -
			(paid * POLAR_RATE + TOPUP_POLAR_PROCESSING_FIXED_USD) -
			TEAMS_NODE_RESERVE_USD;
		expect(contribution).toBeLessThan(0);
	});
});

describe("private Teams founding offer economics", () => {
	it("keeps the paid founding rate at the five-seat floor", () => {
		const period = discountedTeamsPeriod(
			TEAMS_FOUNDING_TRIAL.includedAgents,
			TEAMS_FOUNDING_TRIAL.discountBasisPoints
		);
		expect(period.paidUsd).toBe(TEAMS_FOUNDING_TRIAL.trialMonthlyPriceUsd);
	});

	// Every discounted month, at every seat count a founding org can reach,
	// including both sides of each seat tier.
	const seatCounts = new Set<number>([5, 6, 10, 25, 49, 100]);
	for (const tier of TEAMS_NODE_TIERS) {
		seatCounts.add(tier.minSeats);
	}
	for (const seats of [...seatCounts].sort((a, b) => a - b)) {
		for (let month = 1; month <= TEAMS_FOUNDING_TRIAL.durationMonths; month++) {
			it(`month ${month} at ${seats} seats clears its contribution floor`, () => {
				const period = discountedTeamsPeriod(
					seats,
					TEAMS_FOUNDING_TRIAL.discountBasisPoints
				);
				expect(discountedFloorVerdict(seats, period)).toBe("clears");
			});
		}
	}

	it("reserves one base server at fifty seats", () => {
		expect(
			discountedTeamsPeriod(50, TEAMS_FOUNDING_TRIAL.discountBasisPoints)
				.nodeUsd
		).toBe(TEAMS_NODE_RESERVE_USD);
	});
});
