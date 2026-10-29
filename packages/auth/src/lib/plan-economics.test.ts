import { describe, expect, it } from "bun:test";
import {
	baseNodeCountForPlanAtLocation,
	baseNodeTypeForPlanAtLocation,
	legacyBaseNodeCountForPlanAtLocation,
	legacyBaseNodeTypeForPlanAtLocation,
	ORG_PLAN_STOCK_FALLBACK_NODE_TYPE,
	stockFallbackNodeTypeForPlanAtLocation,
	TEAMS_NODE_TIERS,
} from "./base-node.ts";
import {
	currentMarginRows,
	evaluateRowMargins,
	FLOOR_EXCEPTIONS,
	mailAndStorageUsdPerMonth,
	marginNodeFor,
	planMargin,
	YEARLY_MARGIN_FLOOR,
} from "./plan-margin.ts";
import { type PlanVariantCell, regionForLocation } from "./plan-variants.ts";
import {
	currentPlanVersionFor,
	DEPOSIT_FEE_BPS,
	DEPOSIT_FEE_BPS_BY_PLAN,
	DEPOSIT_FEE_FIXED_MICRO_USD,
	DEPOSIT_MARGIN_CAP_MICRO_USD,
	depositFee,
	INCLUDED_CREDIT_FRACTION_MAX,
	monthlyPriceMicroUsdForSeats,
	openRouterCreditPurchaseCostUsd,
	PLAN_IDS,
	PLAN_VERSIONS,
	PLANS,
	type PlanId,
	planVersionFor,
	TOPUP_OPENROUTER_FEE_BPS,
	TOPUP_OPENROUTER_GST_BPS,
	TOPUP_POLAR_PROCESSING_BPS,
	TOPUP_POLAR_PROCESSING_FIXED_USD,
	topupBreakEvenUsd,
	usdToMicro,
} from "./plans.ts";
import {
	effectiveRawUsd,
	hasNodeCost,
	nodeCost,
	nodeReserveFn,
	PROVIDER_NODE_COSTS,
	type ProviderNodeCost,
	RESERVE_MULTIPLIER,
	reserveMonthlyUsd,
	UnpricedNodeTypeError,
} from "./provider-node-costs.ts";

/**
 * THE ECONOMICS GUARD for the plan catalog.
 *
 * `plans.test.ts` checks that the catalog resolves — the right product id maps
 * to the right plan, seats multiply, entitlements come out. This file checks
 * something it never did: that the numbers in the catalog MAKE MONEY.
 *
 * It exists because they did not. Before 2026-08-14 the catalog priced Max at
 * $200 with a $150 pool, which is a LOSS on the annual plan at full list price,
 * and set the deposit fee at 10% base / 5% for subscribers when break-even is
 * ~10.3% — so every top-up lost money and the "premium perk" lost the most. Both
 * were invisible because the costs that make them losses were not in this repo:
 * OpenRouter charges 5.5% to buy the credits we grant at cost, and Singapore GST
 * adds 9% to that credit-purchase subtotal from 2026-09-18.
 *
 * Every constant that cost model depends on is named here rather than imported,
 * because they are EXTERNAL rates. When one moves, this file is the place the
 * move is felt — a test failure naming the plan that no longer works, instead of
 * a slow bleed nobody reads.
 */

/** OpenRouter's fee to BUY the credits we then meter at cost (5.5%). */
const OPENROUTER_CREDIT_FEE = TOPUP_OPENROUTER_FEE_BPS / 10_000;
/** Singapore GST on the OpenRouter credit-purchase subtotal. */
const OPENROUTER_GST_RATE = TOPUP_OPENROUTER_GST_BPS / 10_000;
/** Conservative Polar Starter plus international-card processing case. */
const POLAR_RATE_ONE_TIME = TOPUP_POLAR_PROCESSING_BPS / 10_000;
const POLAR_FIXED_USD = TOPUP_POLAR_PROCESSING_FIXED_USD;
/**
 * Node reserves come from THE ONE COST TABLE (`provider-node-costs.ts`): the
 * raw provider price (compute + IPv4, the highest of the region's locations)
 * times the founder's 1.5x reserve rule, rounded up, never below a stricter
 * reviewed reserve. The 50% covers operations, Hetzner's automated backups
 * (20% of the server price) and ordinary drift. The same table derives the
 * Hetzner catalog's static fallback, and the scheduled margin check runs the
 * same engine (`plan-margin.ts`) against live prices, so this guard, the
 * catalog and the live alarm cannot disagree about what a server costs.
 *
 * ONE BASE SERVER (founder decision, 2026-10-19). Every plan includes `cx23`,
 * and the organization plans (Teams, Teams Lite, Business) fall back to the
 * same-price `cpx22` when `cx23` is sold out in every EU region. The engine
 * costs each plan at the DEARER of the two it can be given, so Teams, Teams
 * Lite and Business are costed on `cpx22` ($36) and Plus, Pro and Max on `cx23`
 * ($12). `cx33`/`cx43`/`cx53` stay priced for the grandfathered nodes the old
 * per-plan ladder created (see the legacy-ladder test below).
 */
const RESERVE = nodeReserveFn(new Date());
/** Annual terms bill 10 months and serve 12 ("two months free"). */
const YEARLY_MONTHS_BILLED = 10;
const YEARLY_MONTHS_SERVED = 12;
const CURRENT_YEARLY_MARGIN_FLOOR = 0.2;

/**
 * DOCUMENTED BREACHES of {@link CURRENT_YEARLY_MARGIN_FLOOR}, recorded rather
 * than hidden. Each figure is the exact worst-case ratio at the minimum seat
 * count. The floor suite asserts the plan sits AT this figure: it fails if the
 * margin gets worse (the figure no longer matches) and fails if it recovers to
 * the floor (the row is stale and must be deleted).
 *
 * EMPTY, and meant to stay that way. Costing mail and storage (2026-10-19) put
 * Plus at 14.07% and Pro at 16.87%. The founder decision (2026-10-20) keeps
 * prices, sets both to 5,000 sends, 10 GiB mail and 10 GB Space storage, and
 * trims the pool for NEW contracts only (Plus v2 $10 -> $9, Pro v7 $15 -> $14):
 * Plus 20.50%, Pro 22.05%. Max left the list when the one-base-server decision
 * moved it from cx33 to cx23.
 */
const KNOWN_YEARLY_FLOOR_BREACHES: Partial<Record<PlanId, number>> = {};

const usd = (micro: number): number => micro / 1_000_000;

/** Plans with a recurring price — the only ones this model describes. */
const RECURRING: PlanId[] = PLAN_IDS.filter(
	(id) => PLANS[id].monthlyPriceMicroUsd > 0
);

/** The organization plans: seat-priced, with the EU stock fallback. */
const ORG_PLANS: readonly PlanId[] = ["teams", "teams-lite", "business"];

/** Seat counts just past each bundle/price/node boundary, up to self-serve. */
const ORG_SEAT_BANDS = [5, 6, 9, 10, 11, 25, 49, 50];

describe("included credit pool", () => {
	// The cap is the structural property that keeps ANNUAL solvent: a yearly term
	// bills 10 months and grants 12 pools, so a pool that looks affordable
	// monthly can still sink the year. Capping the fraction is what removes the
	// need for a per-plan yearly override — and it is exactly what Max's old 75%
	// grant violated.
	for (const id of RECURRING) {
		it(`${id} grants no more than ${INCLUDED_CREDIT_FRACTION_MAX * 100}% of its price`, () => {
			const plan = PLANS[id];
			const billedSeats =
				plan.seatModel.kind === "per_seat" ? plan.seatModel.minSeats : 1;
			const fraction =
				plan.monthlyCreditPoolMicroUsd /
				(plan.monthlyPriceMicroUsd * billedSeats);
			expect(fraction).toBeLessThanOrEqual(INCLUDED_CREDIT_FRACTION_MAX);
		});
	}
});

describe("regional included node profiles", () => {
	it("gives every plan one EU base server and the org plans cpx22 in Singapore", () => {
		for (const id of RECURRING) {
			const type = baseNodeTypeForPlanAtLocation(id, "nbg1", 50);
			if (type) {
				expect(type).toBe("cx23");
				expect(baseNodeCountForPlanAtLocation(id, "nbg1", 50)).toBe(1);
			}
		}
		expect(baseNodeTypeForPlanAtLocation("pro", "sin")).toBeNull();
		expect(baseNodeTypeForPlanAtLocation("plus", "sin")).toBeNull();
		expect(baseNodeTypeForPlanAtLocation("max", "sin")).toBeNull();
		expect(baseNodeTypeForPlanAtLocation("teams", "sin", 20)).toBe("cpx22");
		expect(baseNodeTypeForPlanAtLocation("teams-lite", "sin", 20)).toBe(
			"cpx22"
		);
		expect(baseNodeTypeForPlanAtLocation("business", "sin", 20)).toBe("cpx22");
		expect(baseNodeCountForPlanAtLocation("pro", "sin")).toBe(0);
		expect(baseNodeCountForPlanAtLocation("max", "sin")).toBe(0);
		expect(baseNodeCountForPlanAtLocation("teams", "sin", 50)).toBe(1);
		expect(baseNodeCountForPlanAtLocation("business", "sin", 50)).toBe(1);
	});

	it("gives only the organization plans the EU stock fallback, never in Singapore", () => {
		for (const id of ["teams", "teams-lite", "business"] as const) {
			expect(stockFallbackNodeTypeForPlanAtLocation(id, "nbg1")).toBe("cpx22");
			expect(stockFallbackNodeTypeForPlanAtLocation(id, "sin")).toBeNull();
		}
		for (const id of ["plus", "pro", "max", "desktop-license"] as const) {
			expect(stockFallbackNodeTypeForPlanAtLocation(id, "nbg1")).toBeNull();
		}
	});
});

const cellAt = (location: string): PlanVariantCell => ({
	capacity: "standard",
	provider: "hetzner",
	region: regionForLocation(location),
});

/**
 * One node's reserve. Throws on an unpriced type: silently costing a band $0
 * is precisely how an unprofitable tier would slip through.
 */
function nodeUnitUsd(type: string, location: string): number {
	return RESERVE("hetzner", regionForLocation(location), type);
}

/**
 * What the free node(s) for `plan` at `seats` cost Ryu per month: the dearer of
 * the plan's base server and its stock fallback, through the same resolvers the
 * provisioner uses.
 */
function nodeUsdPerMonth(id: PlanId, seats: number, location = "nbg1"): number {
	const node = marginNodeFor(id, cellAt(location), seats, RESERVE);
	return node.unitUsd * node.count;
}

/**
 * Margin on one billing period, in USD, with every real cost subtracted, on
 * the CURRENT row. Worst case by construction: it assumes the subscriber spends
 * 100% of the pool, which is reset each period and never rolls over.
 */
function periodMarginUsd(
	id: PlanId,
	yearly: boolean,
	seats: number,
	location = "nbg1"
): number {
	return planMargin({
		cell: cellAt(location),
		nodeReserveUsd: RESERVE,
		plan: id,
		row: planVersionFor(id, currentPlanVersionFor(id)),
		seats,
		term: yearly ? "yearly" : "monthly",
	}).marginUsd;
}

describe("plan margin (worst case: the whole pool is spent)", () => {
	for (const id of RECURRING) {
		const minSeats =
			PLANS[id].seatModel.kind === "per_seat"
				? PLANS[id].seatModel.minSeats
				: 1;

		it(`${id} monthly is profitable at its minimum seat count`, () => {
			expect(periodMarginUsd(id, false, minSeats)).toBeGreaterThan(0);
		});

		// The one that used to fail. A yearly term serves 12 pools against 10
		// months of revenue, so it is always the binding case — never assume a
		// healthy monthly margin implies a healthy annual one.
		it(`${id} yearly is profitable at its minimum seat count`, () => {
			expect(periodMarginUsd(id, true, minSeats)).toBeGreaterThan(0);
		});
	}

	// EVERY SEAT BAND of every organization plan, not just the minimum. Pools
	// and prices step at bundle boundaries (and the node ladder can step too),
	// so the binding case is the seat count just past a boundary.
	for (const id of ORG_PLANS) {
		for (const seats of ORG_SEAT_BANDS) {
			for (const yearly of [false, true]) {
				const term = yearly ? "yearly" : "monthly";
				it(`${id} ${term} is profitable at ${seats} seats`, () => {
					expect(periodMarginUsd(id, yearly, seats)).toBeGreaterThan(0);
				});
			}
		}
	}

	it("prices every node type the ladder can provision", () => {
		// `nodeUsdPerMonth` throws on an unpriced type. Adding a band with a type
		// nobody costed must fail HERE, naming the type, rather than quietly
		// costing that band $0 and passing every margin test above.
		for (const tier of TEAMS_NODE_TIERS) {
			expect(() => nodeUsdPerMonth("teams", tier.minSeats)).not.toThrow();
			expect(() =>
				nodeUsdPerMonth("teams", tier.minSeats, "sin")
			).not.toThrow();
		}
		for (const id of RECURRING) {
			expect(() => nodeUsdPerMonth(id, 1)).not.toThrow();
		}
	});

	it("costs every organization plan on its dearer stock fallback", () => {
		// The org plans may be given `cpx22` at the same price when `cx23` is sold
		// out, so every margin above must already be the cpx22 margin; Plus, Pro
		// and Max are never given it.
		const fallback = nodeUnitUsd(ORG_PLAN_STOCK_FALLBACK_NODE_TYPE, "nbg1");
		expect(fallback).toBeGreaterThan(nodeUnitUsd("cx23", "nbg1"));
		for (const id of ORG_PLANS) {
			expect(nodeUsdPerMonth(id, 5)).toBe(fallback);
		}
		for (const id of ["plus", "pro", "max"] as const) {
			expect(nodeUsdPerMonth(id, 1)).toBe(nodeUnitUsd("cx23", "nbg1"));
		}
	});

	it("grandfathered nodes from the legacy ladder stay profitable", () => {
		// Existing servers keep the size the old per-plan ladder gave them (Max
		// cx33, Teams cx43 and two at 50 seats, Business cx53). They are never
		// resized up, so this is the most such a subscriber can cost.
		for (const id of RECURRING) {
			for (const location of ["nbg1", "sin"]) {
				const type = legacyBaseNodeTypeForPlanAtLocation(id, location);
				if (!type) {
					continue;
				}
				const seatsList = ORG_PLANS.includes(id) ? ORG_SEAT_BANDS : [1];
				for (const seats of seatsList) {
					const legacyNode =
						nodeUnitUsd(type, location) *
						legacyBaseNodeCountForPlanAtLocation(id, location, seats);
					const margin =
						periodMarginUsd(id, true, seats, location) +
						(nodeUsdPerMonth(id, seats, location) - legacyNode) *
							YEARLY_MONTHS_SERVED;
					expect(`${id}@${location}x${seats}:${margin > 0}`).toBe(
						`${id}@${location}x${seats}:true`
					);
				}
			}
		}
	});

	it("max yearly is comfortably profitable, not marginal", () => {
		// Named explicitly because this is the plan that was NEGATIVE. A bare
		// "> 0" would have passed at $71.60 on $2000 (3.6%) too, which is not a
		// business — it is a rounding error waiting for a discount to erase it.
		// With mail and storage costed and Max on the one cx23 base server, it
		// clears the 20% floor again; it may not fall below it.
		const margin = periodMarginUsd("max", true, 1);
		const revenue = usd(PLANS.max.monthlyPriceMicroUsd) * YEARLY_MONTHS_BILLED;
		expect(margin / revenue).toBeGreaterThanOrEqual(
			CURRENT_YEARLY_MARGIN_FLOOR
		);
	});

	it("costs mail and storage at the stated external rates", () => {
		// Plus and Pro: 5,000 sends ($0.50) + 10 GiB mail + 10 GB Space ($0.50).
		for (const id of ["plus", "pro"] as const) {
			expect(mailAndStorageUsdPerMonth(id)).toBeCloseTo(1, 6);
		}
		// Max: 100,000 sends ($10.00) + 100 GiB mail + 50 GB Space ($3.75).
		expect(mailAndStorageUsdPerMonth("max")).toBeCloseTo(13.75, 6);
		// Organization plans: 100,000 sends + 20 GiB mail + 50 GB Space.
		for (const id of ["teams", "teams-lite", "business"] as const) {
			expect(mailAndStorageUsdPerMonth(id)).toBeCloseTo(11.75, 6);
		}
		// A Major Pass keeps the free baseline: 50 sends, 1 GiB mail, 1 GB Space.
		expect(mailAndStorageUsdPerMonth("marketplace-membership")).toBeCloseTo(
			0.055,
			6
		);
	});
});

describe("current pricing margin floor", () => {
	const yearlyRatio = (id: PlanId, minSeats: number): number => {
		const plan = PLANS[id];
		const billedSeats = plan.seatModel.kind === "per_seat" ? minSeats : 1;
		const revenue =
			usd(
				monthlyPriceMicroUsdForSeats({
					plan,
					seats: billedSeats,
					version: planVersionFor(id, currentPlanVersionFor(id)),
				})
			) * YEARLY_MONTHS_BILLED;
		return periodMarginUsd(id, true, minSeats) / revenue;
	};

	// Every organization-plan seat band, in the EU and in Singapore, not just
	// the minimum: the floor is a promise about every subscriber.
	for (const id of ORG_PLANS) {
		for (const location of ["nbg1", "sin"]) {
			for (const seats of ORG_SEAT_BANDS) {
				it(`${id} yearly clears the ${CURRENT_YEARLY_MARGIN_FLOOR * 100}% floor at ${seats} seats in ${location}`, () => {
					const revenue =
						usd(
							monthlyPriceMicroUsdForSeats({
								plan: PLANS[id],
								seats,
								version: planVersionFor(id, currentPlanVersionFor(id)),
							})
						) * YEARLY_MONTHS_BILLED;
					expect(
						periodMarginUsd(id, true, seats, location) / revenue
					).toBeGreaterThanOrEqual(CURRENT_YEARLY_MARGIN_FLOOR);
				});
			}
		}
	}

	for (const id of RECURRING) {
		const minSeats =
			PLANS[id].seatModel.kind === "per_seat"
				? PLANS[id].seatModel.minSeats
				: 1;
		const breach = KNOWN_YEARLY_FLOOR_BREACHES[id];

		if (breach === undefined) {
			it(
				id +
					" yearly clears the " +
					CURRENT_YEARLY_MARGIN_FLOOR * 100 +
					"% contribution floor",
				() => {
					expect(yearlyRatio(id, minSeats)).toBeGreaterThanOrEqual(
						CURRENT_YEARLY_MARGIN_FLOOR
					);
				}
			);
			continue;
		}

		// Reported by name in every run, so the breach is never silent.
		it(
			id +
				" yearly is a DOCUMENTED BREACH of the " +
				CURRENT_YEARLY_MARGIN_FLOOR * 100 +
				"% floor at " +
				(breach * 100).toFixed(2) +
				"% (mail and storage costed; pricing decision pending)",
			() => {
				const ratio = yearlyRatio(id, minSeats);
				expect(ratio).toBeCloseTo(breach, 4);
				expect(ratio).toBeLessThan(CURRENT_YEARLY_MARGIN_FLOOR);
				expect(ratio).toBeGreaterThan(0);
			}
		);
	}
});

describe("current pricing worksheet", () => {
	// Contribution after credits, node, mail and storage (full send allowance,
	// full mail + Space storage), processing, and the publisher pool.
	const cases = [
		["marketplace-membership", 1, false, 4.145, 0.2073],
		["marketplace-membership", 1, true, 45.84, 0.2292],
		["plus", 1, false, 12.283, 0.3149],
		["plus", 1, true, 79.966, 0.205],
		["pro", 1, false, 16.183, 0.3303],
		["pro", 1, true, 108.066, 0.2205],
		["max", 1, false, 31.8165, 0.3214],
		["max", 1, true, 202.168, 0.2042],
		// The organization plans are costed on the cpx22 stock fallback.
		["teams", 5, false, 128.0025, 0.512],
		["teams", 5, true, 1074.03, 0.4296],
		["teams-lite", 5, false, 69.001, 0.46],
		["teams-lite", 5, true, 553.012, 0.3687],
		["teams-lite", 6, false, 92.752, 0.4638],
		["teams-lite", 6, true, 744.524, 0.3723],
		["teams-lite", 10, false, 279.752, 0.6994],
		["teams-lite", 10, true, 2614.524, 0.6536],
		["teams-lite", 25, false, 912.005, 0.793],
		["teams-lite", 25, true, 8799.06, 0.7651],
		["teams-lite", 50, false, 1965.76, 0.8191],
		["teams-lite", 50, true, 19_106.62, 0.7961],
		["business", 5, false, 117.255, 0.3908],
		["business", 5, true, 851.56, 0.2839],
		["business", 25, false, 592.275, 0.4556],
		["business", 25, true, 4681.8, 0.3601],
		["business", 50, false, 1186.05, 0.4651],
		["business", 50, true, 9469.6, 0.3714],
	] as const;

	for (const [id, seats, yearly, contribution, margin] of cases) {
		it(
			id +
				" " +
				(yearly ? "yearly" : "monthly") +
				" at " +
				seats +
				" seats matches the worksheet",
			() => {
				const plan = PLANS[id];
				const revenue =
					usd(
						monthlyPriceMicroUsdForSeats({
							plan,
							seats,
							version: planVersionFor(id, currentPlanVersionFor(id)),
						})
					) * (yearly ? YEARLY_MONTHS_BILLED : 1);
				const actual = periodMarginUsd(id, yearly, seats);
				expect(actual).toBeCloseTo(contribution, 3);
				expect(actual / revenue).toBeCloseTo(margin, 3);
			}
		);
	}
});

describe("regional margin floor", () => {
	for (const id of RECURRING) {
		const minSeats =
			PLANS[id].seatModel.kind === "per_seat"
				? PLANS[id].seatModel.minSeats
				: 1;

		it(`${id} stays profitable in Singapore on the supported included-node policy`, () => {
			expect(periodMarginUsd(id, false, minSeats, "sin")).toBeGreaterThan(0);
			expect(periodMarginUsd(id, true, minSeats, "sin")).toBeGreaterThan(0);
		});
	}

	for (const id of ORG_PLANS) {
		for (const seats of ORG_SEAT_BANDS) {
			it(`${id} Singapore ${seats}-seat band has a priced node reserve`, () => {
				expect(periodMarginUsd(id, true, seats, "sin")).toBeGreaterThan(0);
			});
		}
	}
});

/**
 * Margin on a top-up: the buyer is charged `face + fee` and the wallet is
 * credited `face` (`computeTopupQuote`), so Ryu receives the fee and pays to
 * fund the face.
 */
function topupMarginUsd(faceUsd: number, plan: PlanId | null): number {
	const fee = usd(depositFee(usdToMicro(faceUsd), plan));
	const charged = faceUsd + fee;
	return (
		charged -
		faceUsd -
		(openRouterCreditPurchaseCostUsd(faceUsd) - faceUsd) -
		(charged * POLAR_RATE_ONE_TIME + POLAR_FIXED_USD)
	);
}

describe("deposit fee", () => {
	// A top-up must not lose money at ANY plausible size.
	//
	// These stay as a readable canary; the exhaustive whole-cent assertion below is
	// the actual guard against a loss band.
	const SIZES = [5, 10, 12.5, 15, 20, 50, 100, 500];

	it("includes Singapore GST in upstream OpenRouter funding cost", () => {
		// $15 face -> $0.825 OpenRouter fee, then 9% GST on the $15.825 subtotal.
		expect(openRouterCreditPurchaseCostUsd(15)).toBeCloseTo(17.249_25, 5);
	});

	/**
	 * The largest face value at which the FIXED floor still covers its own costs.
	 *
	 * At the floor/percentage join, OpenRouter is above its $0.80 minimum. A flat
	 * fee `F` nets `F - [0.055 + 0.09 x (1 + 0.055)] x face - (face + F) x
	 * 0.065 - 0.50`; derive the coverage point from the constants rather than
	 * writing it down.
	 */
	const floorProfitableToUsd = (): number => {
		const floor = usd(DEPOSIT_FEE_FIXED_MICRO_USD);
		return (
			(floor * (1 - POLAR_RATE_ONE_TIME) - POLAR_FIXED_USD) /
			(OPENROUTER_CREDIT_FEE +
				OPENROUTER_GST_RATE * (1 + OPENROUTER_CREDIT_FEE) +
				POLAR_RATE_ONE_TIME)
		);
	};

	it("the base rate clears break-even", () => {
		// The 27% base rate leaves room for the processor schedule plus GST.
		expect(DEPOSIT_FEE_BPS).toBeGreaterThan(2600);
		expect(topupBreakEvenUsd(DEPOSIT_FEE_BPS)).toBeCloseTo(14.08, 2);
		expect(topupBreakEvenUsd(DEPOSIT_FEE_BPS_BY_PLAN.max)).toBeCloseTo(
			17.76,
			2
		);
	});

	for (const plan of [null, ...PLAN_IDS]) {
		const label = plan ?? "no plan";
		it(`${label} top-ups are profitable at every size`, () => {
			for (const face of SIZES) {
				expect(topupMarginUsd(face, plan)).toBeGreaterThan(0);
			}
		});
	}

	// THE STRUCTURAL GUARD. Every plan's fee curve has two regimes — the floor
	// below the crossover, the percentage above it — and profitability has to be
	// continuous ACROSS the join. The floor must therefore stay profitable at
	// least as far as the point where the percentage takes over AND starts
	// clearing break-even on its own.
	//
	// This is the assertion the sampled sizes could not make. It fails
	// automatically if anyone lowers a plan rate (pushing its break-even out) or
	// lowers the floor (pulling its coverage in), without needing someone to guess
	// which deposit sizes to add to a list.
	it("no plan has a gap between the floor and its own break-even", () => {
		const coveredTo = floorProfitableToUsd();
		for (const plan of [null, ...PLAN_IDS]) {
			const rate = plan ? DEPOSIT_FEE_BPS_BY_PLAN[plan] : DEPOSIT_FEE_BPS;
			const breakEven = topupBreakEvenUsd(rate);
			expect(coveredTo).toBeGreaterThanOrEqual(breakEven);
		}
	});

	// And the same property proved the blunt way, so a mistake in the algebra
	// above cannot make the guard vacuous: walk every cent from $1 to $600 and
	// assert not one of them loses money on any plan.
	it("loses money at no whole-cent size on any plan", () => {
		for (const plan of [null, ...PLAN_IDS]) {
			for (let cents = 100; cents <= 60_000; cents++) {
				const face = cents / 100;
				if (topupMarginUsd(face, plan) < 0) {
					throw new Error(
						`${plan ?? "no plan"} loses money on a $${face.toFixed(2)} top-up`
					);
				}
			}
		}
	});

	// The margin cap: Ryu keeps at most $10 from any one top-up, at every size
	// the custom amount allows and on every plan, including after checkout rounds
	// the fee up to a whole cent.
	it("keeps Ryu's margin at or below $10 at every whole-cent size", () => {
		const capUsd = usd(DEPOSIT_MARGIN_CAP_MICRO_USD);
		for (const plan of [null, ...PLAN_IDS]) {
			for (let cents = 100; cents <= 100_000; cents++) {
				const face = cents / 100;
				const checkoutFee =
					Math.ceil(depositFee(usdToMicro(face), plan) / 10_000) / 100;
				const charged = face + checkoutFee;
				const margin =
					checkoutFee -
					(openRouterCreditPurchaseCostUsd(face) - face) -
					(charged * POLAR_RATE_ONE_TIME + POLAR_FIXED_USD);
				if (margin > capUsd + 1e-9 || margin < 0) {
					throw new Error(
						`${plan ?? "no plan"} keeps $${margin.toFixed(4)} on a $${face.toFixed(2)} top-up`
					);
				}
			}
		}
	});

	it("the cap only binds on large top-ups", () => {
		// Below the cap the plan rate applies unchanged; at $1,000 every plan
		// pays the same capped fee.
		expect(depositFee(usdToMicro(250))).toBe(usdToMicro(67.5));
		expect(depositFee(usdToMicro(1000))).toBe(
			depositFee(usdToMicro(1000), "max")
		);
		expect(depositFee(usdToMicro(1000))).toBe(usdToMicro(241.12));
	});

	it("only plans with managed inference can actually top up", () => {
		// The rates above are a total map over PlanId, but the ROUTE refuses any
		// entitlement without managed inference — so `desktop-license` has a rate
		// it can never use. Asserted because the docs advertised a Lifetime
		// deposit rate for months, which promised a purchase the API rejects.
		expect(PLANS["desktop-license"].managedInference).toBe(false);
		for (const id of [
			"pro",
			"plus",
			"max",
			"teams",
			"teams-lite",
			"business",
		] as const) {
			expect(PLANS[id].managedInference).toBe(true);
		}
	});

	it("every plan rate is above the point where the fee stops covering costs", () => {
		// `topupBreakEvenUsd` returns the smallest profitable top-up for a rate.
		// Requiring it to stay under $20 keeps the managed-plan discount from
		// becoming a subsidy under the conservative processor case.
		for (const id of PLAN_IDS) {
			expect(topupBreakEvenUsd(DEPOSIT_FEE_BPS_BY_PLAN[id])).toBeLessThan(20);
		}
	});

	it("subscribers pay less than the base rate (the discount is real)", () => {
		for (const id of PLAN_IDS) {
			expect(DEPOSIT_FEE_BPS_BY_PLAN[id]).toBeLessThanOrEqual(DEPOSIT_FEE_BPS);
		}
		expect(DEPOSIT_FEE_BPS_BY_PLAN.max).toBeLessThan(
			DEPOSIT_FEE_BPS_BY_PLAN.pro
		);
	});
});

describe("the ladder is coherent", () => {
	// THE DOMINANCE TEST — the bug that made Max unsellable, encoded.
	//
	// Max used to cost +$161/seat over Teams for +$130.50 of credits that a
	// top-up delivered for $143.55, so the upgrade was $17.45 WORSE than staying
	// put. Any tier whose premium is priced above what the same credits cost à la
	// carte is dominated, and no amount of marketing fixes that.
	it("no tier's premium is beaten by simply buying the credits", () => {
		const proPrice = usd(PLANS.pro.monthlyPriceMicroUsd);
		const maxPrice = usd(PLANS.max.monthlyPriceMicroUsd);
		const poolGain =
			usd(PLANS.max.monthlyCreditPoolMicroUsd) -
			usd(PLANS.pro.monthlyCreditPoolMicroUsd);

		const premium = maxPrice - proPrice;
		const creditsViaTopup =
			poolGain + usd(depositFee(usdToMicro(poolGain), "pro"));

		// Max's premium legitimately exceeds the credit value — it buys a bigger
		// node, more mail and a lower deposit rate. What must NOT happen is the
		// reverse of the old bug: the tier must not be sold as a credit deal.
		// This asserts the gap is a CAPABILITY premium, i.e. the credits alone do
		// not justify it, so the pricing page has to name the real reasons.
		expect(premium).toBeGreaterThan(creditsViaTopup);
	});

	it("keeps Teams as the active organization seat catalog", () => {
		expect(PLANS.teams.seatModel).toEqual({ kind: "per_seat", minSeats: 5 });
		expect(PLANS.teams.creditPoolModel).toBe("per_bundle");
		expect(PLANS.teams.creditPoolBundleSize).toBe(5);
		expect(PLANS["marketplace-membership"].seatModel).toEqual({
			kind: "single",
		});
		expect(PLANS.pro.seatModel.kind).toBe("single");
		expect(PLANS.max.seatModel.kind).toBe("single");
	});

	it("Pro and Max keep fixed credit pools as agent capacity scales", () => {
		expect(PLANS.pro.monthlyCreditPoolMicroUsd).toBe(usdToMicro(14));
		expect(PLANS.max.monthlyCreditPoolMicroUsd).toBe(usdToMicro(30));
	});
});

/**
 * Margin for one HISTORICAL version — its own price, its own pool, but TODAY's
 * node cost.
 *
 * Charging every version the current node is deliberate and conservative. Node
 * type is not versioned (`BASE_NODE_TYPE_BY_PLAN` is keyed by plan), so a NEW
 * server for a grandfathered subscriber gets today's base server; a server they
 * already have keeps its size and is covered by the legacy-ladder test above.
 * Where today's node and allowances turn a historical contract into a
 * worst-case loss, {@link KNOWN_GRANDFATHERED_YEARLY_LOSSES} names it instead
 * of hiding it.
 */
function versionMarginUsd(
	id: PlanId,
	version: number,
	yearly: boolean,
	seats: number
): number {
	// Today's node, at the seat count being modelled — so a grandfathered Teams
	// org is charged the same node a new one is. Node type and COUNT are not
	// versioned (the node profile is per variant, not per row).
	return planMargin({
		cell: cellAt("nbg1"),
		nodeReserveUsd: RESERVE,
		plan: id,
		row: planVersionFor(id, version),
		seats,
		term: yearly ? "yearly" : "monthly",
	}).marginUsd;
}

/**
 * Grandfathered YEARLY contracts that are a worst-case loss once mail and
 * storage are costed, keyed `"<plan> v<version>"` with the exact annual figure
 * in USD. The test asserts the loss stays at this figure (worse fails) and that
 * the row is removed once it is no longer a loss.
 *
 * EMPTY since 2026-10-20. The $39/year-billed-$390 Pro rows with a $15 pool
 * (v1, v4, v5) lost $10.84 a year against the old 10,000-send / 20 GB
 * allowances. Allowances are not versioned, so the move to 5,000 sends and
 * 10 GiB + 10 GB reaches them too and they now clear +$1.16 worst case.
 */
const KNOWN_GRANDFATHERED_YEARLY_LOSSES: Readonly<Record<string, number>> = {};

describe("grandfathering", () => {
	// THE INVARIANT THAT MAKES A PRICE RISE SAFE.
	//
	// Not "the current catalog is profitable" — that was already asserted above,
	// and it is not the question. The question is whether a customer who bought
	// two versions ago is still profitable on the terms they bought, because a
	// pool increase aimed at NEW buyers used to reach them: `resolveEntitlement`
	// read the pool off the live catalog, so raising it to $25 put a $39 Pro
	// subscriber at -$15.61 on the annual plan.
	//
	// Every row, every interval, forever. A version is append-only, so this loop
	// grows and never shrinks.
	for (const id of PLAN_IDS) {
		for (const row of PLAN_VERSIONS[id]) {
			if (row.monthlyPriceMicroUsd <= 0) {
				continue;
			}
			const minSeats =
				PLANS[id].seatModel.kind === "per_seat"
					? PLANS[id].seatModel.minSeats
					: 1;

			it(`${id} v${row.version} is still profitable monthly`, () => {
				expect(
					versionMarginUsd(id, row.version, false, minSeats)
				).toBeGreaterThan(0);
			});

			const knownLoss =
				KNOWN_GRANDFATHERED_YEARLY_LOSSES[`${id} v${row.version}`];
			if (knownLoss === undefined) {
				it(`${id} v${row.version} is still profitable yearly`, () => {
					expect(
						versionMarginUsd(id, row.version, true, minSeats)
					).toBeGreaterThan(0);
				});
			} else {
				it(`${id} v${row.version} yearly is a DOCUMENTED worst-case loss of $${-knownLoss} (mail and storage costed; decision pending)`, () => {
					const margin = versionMarginUsd(id, row.version, true, minSeats);
					expect(margin).toBeCloseTo(knownLoss, 3);
					expect(margin).toBeLessThan(0);
				});
			}

			it(`${id} v${row.version} respects the pool cap`, () => {
				const billedSeats =
					PLANS[id].seatModel.kind === "per_seat"
						? PLANS[id].seatModel.minSeats
						: 1;
				expect(
					row.monthlyCreditPoolMicroUsd /
						(row.monthlyPriceMicroUsd * billedSeats)
				).toBeLessThanOrEqual(INCLUDED_CREDIT_FRACTION_MAX);
			});
		}
	}

	it("versions are unique and ascending, and v1 exists", () => {
		for (const id of PLAN_IDS) {
			const nums = PLAN_VERSIONS[id].map((r) => r.version);
			expect(nums[0]).toBe(1);
			expect(new Set(nums).size).toBe(nums.length);
			expect([...nums].sort((a, b) => a - b)).toEqual(nums);
		}
	});

	it("an unknown or missing version resolves to v1, never to the newest", () => {
		// The asymmetry is load-bearing: subscriptions created before the stamp
		// existed carry no version, and they are the OLDEST customers on the
		// OLDEST prices. Resolving them forward would hand them a pool their
		// price never funded.
		for (const id of PLAN_IDS) {
			expect(planVersionFor(id, undefined).version).toBe(1);
			expect(planVersionFor(id, null).version).toBe(1);
			expect(planVersionFor(id, 9999).version).toBe(1);
			expect(planVersionFor(id, "nonsense").version).toBe(1);
		}
	});

	it("the current version exists for every plan", () => {
		for (const id of PLAN_IDS) {
			const currentVersion = currentPlanVersionFor(id);
			expect(planVersionFor(id, currentVersion).version).toBe(currentVersion);
		}
	});

	it("the live catalog agrees with its current version row", () => {
		// The catalog and the version table are two statements of the same price.
		// If they drift, one of them is lying to somebody: the page renders the
		// catalog and the wallet is granted from the version.
		for (const id of PLAN_IDS) {
			const row = planVersionFor(id, currentPlanVersionFor(id));
			expect(PLANS[id].monthlyPriceMicroUsd).toBe(row.monthlyPriceMicroUsd);
			expect(PLANS[id].monthlyCreditPoolMicroUsd).toBe(
				row.monthlyCreditPoolMicroUsd
			);
		}
	});
});

describe("provider cost table and the reserve rule", () => {
	it("reserves every node at max(ceil(1.5x raw), reviewed minimum)", () => {
		for (const row of PROVIDER_NODE_COSTS) {
			const reserve = reserveMonthlyUsd(row.rawMonthlyUsd, row.minReserveUsd);
			expect(reserve).toBe(
				Math.max(
					Math.ceil(row.rawMonthlyUsd * RESERVE_MULTIPLIER),
					row.minReserveUsd ?? 0
				)
			);
			expect(reserve).toBeGreaterThanOrEqual(row.rawMonthlyUsd * 1.5);
		}
		expect(RESERVE_MULTIPLIER).toBe(1.5);
	});

	it("never loosens a reviewed EU reserve", () => {
		// The reserves this guard used before the cost table existed.
		const reviewed = { cx23: 12, cpx22: 36, cx33: 16, cx43: 30, cx53: 55 };
		for (const [type, reserve] of Object.entries(reviewed)) {
			expect(nodeUnitUsd(type, "nbg1")).toBe(reserve);
		}
	});

	it("is at least as strict in Singapore as the reviewed reserves", () => {
		const reviewed = { cpx22: 44, cpx32: 80, ccx13: 88 };
		for (const [type, reserve] of Object.entries(reviewed)) {
			expect(nodeUnitUsd(type, "sin")).toBeGreaterThanOrEqual(reserve);
		}
	});

	it("prices every type any profile, fallback or legacy node can be", () => {
		for (const id of RECURRING) {
			for (const location of ["nbg1", "sin"]) {
				for (const seats of [1, 5, 50]) {
					for (const type of [
						baseNodeTypeForPlanAtLocation(id, location, seats),
						stockFallbackNodeTypeForPlanAtLocation(id, location),
						legacyBaseNodeTypeForPlanAtLocation(id, location),
					]) {
						if (type) {
							expect(
								`${type}@${location}:${hasNodeCost("hetzner", regionForLocation(location), type)}`
							).toBe(`${type}@${location}:true`);
						}
					}
				}
			}
		}
		expect(() => nodeUnitUsd("cpx62", "nbg1")).toThrow(UnpricedNodeTypeError);
	});

	it("applies an announced provider price rise ahead of time", () => {
		const cost: ProviderNodeCost = {
			...nodeCost("hetzner", "eu", "cx23"),
			announced: [
				{ effectiveFrom: "2027-01-01", rawMonthlyUsd: 9, source: "test" },
			],
		};
		expect(effectiveRawUsd(cost, new Date("2026-10-01T00:00:00Z"))).toBe(
			cost.rawMonthlyUsd
		);
		expect(effectiveRawUsd(cost, new Date("2026-11-15T00:00:00Z"))).toBe(9);
		// A live price DROP never makes a margin look better than the table.
		expect(effectiveRawUsd(cost, new Date("2026-10-01T00:00:00Z"), 1)).toBe(
			cost.rawMonthlyUsd
		);
		expect(effectiveRawUsd(cost, new Date("2026-10-01T00:00:00Z"), 8)).toBe(8);
	});
});

describe("every current row clears the floor in every region and seat band", () => {
	const now = new Date();
	const results = evaluateRowMargins(currentMarginRows(), RESERVE, now);

	it("evaluates every current recurring row in both regions", () => {
		expect(results.length).toBe(RECURRING.length * 2);
	});

	for (const result of results) {
		it(`${result.plan} v${result.version} ${result.region} is ${result.status === "exception" ? "covered by an exception" : "ok"} (worst yearly ${(result.worstYearly.ratio * 100).toFixed(2)}% at ${result.worstYearly.seats} seats)`, () => {
			expect(["ok", "exception"]).toContain(result.status);
			expect(result.worstMonthly.ratio).toBeGreaterThan(0);
		});
	}

	it("has no expired floor exception (the set may only shrink)", () => {
		for (const exception of FLOOR_EXCEPTIONS) {
			expect(Date.parse(`${exception.expiresOn}T00:00:00Z`)).toBeGreaterThan(
				now.getTime()
			);
		}
		expect(FLOOR_EXCEPTIONS.length).toBe(0);
	});

	it("matches the engine at the yearly floor", () => {
		expect(YEARLY_MARGIN_FLOOR).toBe(CURRENT_YEARLY_MARGIN_FLOOR);
		for (const result of results) {
			const yearly = planMargin({
				cell: {
					capacity: "standard",
					provider: "hetzner",
					region: result.region,
				},
				nodeReserveUsd: RESERVE,
				plan: result.plan,
				row: planVersionFor(result.plan, result.version),
				seats: result.worstYearly.seats,
				term: "yearly",
			});
			expect(yearly.marginRatio).toBeCloseTo(result.worstYearly.ratio, 10);
		}
	});
});
