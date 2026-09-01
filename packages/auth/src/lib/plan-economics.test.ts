import { describe, expect, it } from "bun:test";
import {
	baseNodeCountForPlanAtLocation,
	baseNodeTypeForPlanAtLocation,
	TEAMS_NODE_TIERS,
} from "./base-node.ts";
import { DEFAULT_MARKETPLACE_MEMBERSHIP_PUBLISHER_SHARE_BPS } from "./marketplace-membership.ts";
import {
	currentPlanVersionFor,
	DEPOSIT_FEE_BPS,
	DEPOSIT_FEE_BPS_BY_PLAN,
	DEPOSIT_FEE_FIXED_MICRO_USD,
	depositFee,
	INCLUDED_CREDIT_FRACTION_MAX,
	monthlyCreditPoolMicroUsdForSeats,
	monthlyPriceMicroUsdForSeats,
	PLAN_IDS,
	PLAN_VERSIONS,
	PLANS,
	type PlanId,
	planVersionFor,
	TOPUP_OPENROUTER_FEE_BPS,
	TOPUP_OPENROUTER_MINIMUM_USD,
	TOPUP_POLAR_PROCESSING_BPS,
	TOPUP_POLAR_PROCESSING_FIXED_USD,
	topupBreakEvenUsd,
	usdToMicro,
} from "./plans.ts";

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
 * were invisible because the one cost that makes them losses is not in this
 * repo: OpenRouter charges 5.5% to buy the credits we grant at cost.
 *
 * Every constant that cost model depends on is named here rather than imported,
 * because they are EXTERNAL rates. When one moves, this file is the place the
 * move is felt — a test failure naming the plan that no longer works, instead of
 * a slow bleed nobody reads.
 */

/** OpenRouter's fee to BUY the credits we then meter at cost (5.5%). */
const OPENROUTER_CREDIT_FEE = TOPUP_OPENROUTER_FEE_BPS / 10_000;
/** OpenRouter's current minimum fee when buying a small credit balance. */
const OPENROUTER_CREDIT_MINIMUM_USD = TOPUP_OPENROUTER_MINIMUM_USD;
/** Conservative Polar Starter plus international-card processing case. */
const POLAR_RATE_ONE_TIME = TOPUP_POLAR_PROCESSING_BPS / 10_000;
const POLAR_RATE_SUBSCRIPTION = TOPUP_POLAR_PROCESSING_BPS / 10_000;
const POLAR_FIXED_USD = TOPUP_POLAR_PROCESSING_FIXED_USD;
/**
 * Conservative USD planning reserves by server type. These use the current
 * German gross price + one IPv4, the 2026-08-19 ECB EUR/USD reference rate,
 * a 25% infrastructure buffer, and a final round-up for ordinary drift.
 *
 * NOT one number any more. The free node is sized by PLAN, and for Teams by SEAT
 * COUNT — Max runs a `cx33`, and Teams climbs `cx23` → `cx33` → `cpx32` → 2 ×
 * `cpx32` as the org grows. Charging every plan a flat `cx23` (which this file
 * did until the seat ladder shipped) understates the node cost by up to 13× at
 * the top band, so the margin guard would have passed a band that lost money.
 *
 * `nodeUsdPerMonth` resolves through the SAME `baseNodeTypeForPlan` /
 * `baseNodeCountForPlan` the provisioner uses, so a new band cannot be added to
 * the ladder without this guard re-pricing it.
 */
const NODE_USD_PER_MONTH: Readonly<Record<string, number>> = {
	cx23: 12,
	cx33: 16,
	cpx32: 63,
	ccx13: 80,
};
const NODE_USD_PER_MONTH_SINGAPORE: Readonly<Record<string, number>> = {
	cpx22: 44,
	cpx32: 80,
	ccx13: 88,
};
/** Annual terms bill 10 months and serve 12 ("two months free"). */
const YEARLY_MONTHS_BILLED = 10;
const YEARLY_MONTHS_SERVED = 12;
const CURRENT_YEARLY_MARGIN_FLOOR = 0.2;

const usd = (micro: number): number => micro / 1_000_000;

/** Cost of funding one non-zero included monthly pool through OpenRouter. */
function fundedPoolUsd(poolUsd: number): number {
	if (poolUsd <= 0) {
		return 0;
	}
	return (
		poolUsd +
		Math.max(poolUsd * OPENROUTER_CREDIT_FEE, OPENROUTER_CREDIT_MINIMUM_USD)
	);
}

/** Plans with a recurring price — the only ones this model describes. */
const RECURRING: PlanId[] = PLAN_IDS.filter(
	(id) => PLANS[id].monthlyPriceMicroUsd > 0
);

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
	it("keeps the EU defaults while selecting Singapore's available shapes", () => {
		expect(baseNodeTypeForPlanAtLocation("pro", "nbg1")).toBe("cx23");
		expect(baseNodeTypeForPlanAtLocation("pro", "sin")).toBeNull();
		expect(baseNodeTypeForPlanAtLocation("max", "sin")).toBeNull();
		expect(baseNodeTypeForPlanAtLocation("teams", "sin", 20)).toBe("cpx22");
		expect(baseNodeTypeForPlanAtLocation("business", "sin", 20)).toBe("cpx32");
		expect(baseNodeCountForPlanAtLocation("pro", "sin")).toBe(0);
		expect(baseNodeCountForPlanAtLocation("max", "sin")).toBe(0);
		expect(baseNodeCountForPlanAtLocation("teams", "sin", 50)).toBe(2);
		expect(baseNodeCountForPlanAtLocation("business", "sin", 50)).toBe(1);
	});
});

/**
 * What the free node(s) for `plan` at `seats` cost Ryu per month.
 *
 * Resolves through the shipped ladder rather than restating it, so the guard
 * cannot drift from the provisioner. An unpriced type is a hard failure, not a
 * zero: silently costing a band $0 is precisely how an unprofitable tier would
 * slip through.
 */
function nodeUsdPerMonth(id: PlanId, seats: number, location = "nbg1"): number {
	const type = baseNodeTypeForPlanAtLocation(id, location, seats);
	if (!type) {
		return 0;
	}
	const unit =
		location === "sin"
			? NODE_USD_PER_MONTH_SINGAPORE[type]
			: NODE_USD_PER_MONTH[type];
	if (unit === undefined) {
		throw new Error(
			`no monthly cost known for Hetzner type "${type}" — add it to NODE_USD_PER_MONTH before shipping a plan that provisions it`
		);
	}
	return unit * baseNodeCountForPlanAtLocation(id, location, seats);
}

/**
 * Margin on one billing period, in USD, with every real cost subtracted.
 *
 * Worst case by construction: it assumes the subscriber spends 100% of the
 * pool. The subscription bucket is RESET each period and never rolls over, so
 * unspent credit only ever makes the true figure better — which is what makes a
 * pass here a floor rather than an average.
 */
function periodMarginUsd(
	id: PlanId,
	yearly: boolean,
	seats: number,
	location = "nbg1"
): number {
	const plan = PLANS[id];
	const billedSeats = plan.seatModel.kind === "per_seat" ? seats : 1;
	const currentVersion = planVersionFor(id, currentPlanVersionFor(id));
	const monthsBilled = yearly ? YEARLY_MONTHS_BILLED : 1;
	const monthsServed = yearly ? YEARLY_MONTHS_SERVED : 1;
	const revenue =
		usd(
			monthlyPriceMicroUsdForSeats({
				plan,
				seats: billedSeats,
				version: currentVersion,
			})
		) * monthsBilled;
	const monthlyPoolUsd = usd(
		monthlyCreditPoolMicroUsdForSeats({
			plan,
			seats: billedSeats,
			version: currentVersion,
		})
	);
	const credits = fundedPoolUsd(monthlyPoolUsd) * monthsServed;
	const node = nodeUsdPerMonth(id, seats, location) * monthsServed;
	const fee = revenue * POLAR_RATE_SUBSCRIPTION + POLAR_FIXED_USD;
	const publisherPool = plan.marketplacePublisherPool
		? (revenue * DEFAULT_MARKETPLACE_MEMBERSHIP_PUBLISHER_SHARE_BPS) / 10_000
		: 0;

	return revenue - credits - node - fee - publisherPool;
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

	// EVERY BAND OF THE TEAMS LADDER, not just the minimum. The node is the only
	// cost that steps rather than scaling with revenue, so the binding case is
	// always the seat count just past a band boundary — where the org has paid for
	// one more seat and Ryu has just bought a whole extra tier of hardware. A test
	// at `minSeats` alone would never have seen the 50-seat band double the node.
	for (const tier of TEAMS_NODE_TIERS) {
		for (const yearly of [false, true]) {
			const term = yearly ? "yearly" : "monthly";
			it(`teams ${term} is profitable at the ${tier.minSeats}-seat band (${tier.count}x ${tier.type})`, () => {
				const margin = periodMarginUsd("teams", yearly, tier.minSeats);
				expect(margin).toBeGreaterThan(0);
			});
		}
	}

	for (const seats of [5, 6, 10, 25, 50]) {
		for (const yearly of [false, true]) {
			const term = yearly ? "yearly" : "monthly";
			it(`business ${term} is profitable at ${seats} seats`, () => {
				expect(periodMarginUsd("business", yearly, seats)).toBeGreaterThan(0);
			});
		}
	}

	it("prices every node type the ladder can provision", () => {
		// `nodeUsdPerMonth` throws on an unpriced type. Adding a band with a type
		// nobody costed must fail HERE, naming the type, rather than quietly
		// costing that band $0 and passing every margin test above.
		for (const tier of TEAMS_NODE_TIERS) {
			expect(() => nodeUsdPerMonth("teams", tier.minSeats)).not.toThrow();
		}
		for (const id of RECURRING) {
			expect(() => nodeUsdPerMonth(id, 1)).not.toThrow();
		}
	});

	it("max yearly is comfortably profitable, not marginal", () => {
		// Named explicitly because this is the plan that was NEGATIVE. A bare
		// "> 0" would have passed at $71.60 on $2000 (3.6%) too, which is not a
		// business — it is a rounding error waiting for a discount to erase it.
		const margin = periodMarginUsd("max", true, 1);
		const revenue = usd(PLANS.max.monthlyPriceMicroUsd) * YEARLY_MONTHS_BILLED;
		expect(margin / revenue).toBeGreaterThan(0.2);
	});
});

describe("current pricing margin floor", () => {
	for (const id of RECURRING) {
		const minSeats =
			PLANS[id].seatModel.kind === "per_seat"
				? PLANS[id].seatModel.minSeats
				: 1;

		it(
			id +
				" yearly clears the " +
				CURRENT_YEARLY_MARGIN_FLOOR * 100 +
				"% contribution floor",
			() => {
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
				expect(
					periodMarginUsd(id, true, minSeats) / revenue
				).toBeGreaterThanOrEqual(CURRENT_YEARLY_MARGIN_FLOOR);
			}
		);
	}
});

describe("current pricing worksheet", () => {
	const cases = [
		["marketplace-membership", 1, false, 4.2, 0.21],
		["marketplace-membership", 1, true, 46.5, 0.2325],
		["pro", 1, false, 17.49, 0.3569],
		["pro", 1, true, 123.75, 0.2526],
		["max", 1, false, 44.415, 0.4486],
		["max", 1, true, 353.35, 0.3569],
		["teams", 5, false, 168.5, 0.674],
		["teams", 5, true, 1560, 0.624],
		["business", 5, false, 111.5, 0.3717],
		["business", 5, true, 782.5, 0.2608],
		["business", 25, false, 624.5, 0.4804],
		["business", 25, true, 5068.5, 0.3899],
		["business", 50, false, 1265.75, 0.4964],
		["business", 50, true, 10_426, 0.4089],
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

	for (const seats of [5, 10, 25, 50]) {
		it(`Teams Singapore ${seats}-seat band has a priced node reserve`, () => {
			expect(periodMarginUsd("teams", true, seats, "sin")).toBeGreaterThan(0);
		});
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
		Math.max(faceUsd * OPENROUTER_CREDIT_FEE, OPENROUTER_CREDIT_MINIMUM_USD) -
		(charged * POLAR_RATE_ONE_TIME + POLAR_FIXED_USD)
	);
}

describe("deposit fee", () => {
	// A top-up must not lose money at ANY plausible size.
	//
	// These stay as a readable canary; the exhaustive whole-cent assertion below is
	// the actual guard against a loss band.
	const SIZES = [5, 10, 12.5, 15, 20, 50, 100, 500];

	/**
	 * The largest face value at which the FIXED floor still covers its own costs.
	 *
	 * At the floor/percentage join, OpenRouter is above its $0.80 minimum. A flat
	 * fee `F` nets `F − 0.055·face − (face + F)·0.065 − 0.50`; derive the coverage
	 * point from the constants rather than writing it down.
	 */
	const floorProfitableToUsd = (): number => {
		const floor = usd(DEPOSIT_FEE_FIXED_MICRO_USD);
		return (
			(floor * (1 - POLAR_RATE_ONE_TIME) - POLAR_FIXED_USD) /
			(OPENROUTER_CREDIT_FEE + POLAR_RATE_ONE_TIME)
		);
	};

	it("the base rate clears break-even", () => {
		// The 17% base rate leaves room for the current processor schedule.
		expect(DEPOSIT_FEE_BPS).toBeGreaterThan(1600);
		expect(topupBreakEvenUsd(DEPOSIT_FEE_BPS)).toBeCloseTo(13.84, 2);
		expect(topupBreakEvenUsd(DEPOSIT_FEE_BPS_BY_PLAN.max)).toBeCloseTo(
			16.89,
			2
		);
	});

	for (const plan of [null, ...PLAN_IDS] as (PlanId | null)[]) {
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
		for (const plan of [null, ...PLAN_IDS] as (PlanId | null)[]) {
			const rate = plan ? DEPOSIT_FEE_BPS_BY_PLAN[plan] : DEPOSIT_FEE_BPS;
			const breakEven = topupBreakEvenUsd(rate);
			expect(coveredTo).toBeGreaterThanOrEqual(breakEven);
		}
	});

	// And the same property proved the blunt way, so a mistake in the algebra
	// above cannot make the guard vacuous: walk every cent from $1 to $600 and
	// assert not one of them loses money on any plan.
	it("loses money at no whole-cent size on any plan", () => {
		for (const plan of [null, ...PLAN_IDS] as (PlanId | null)[]) {
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

	it("only plans with managed inference can actually top up", () => {
		// The rates above are a total map over PlanId, but the ROUTE refuses any
		// entitlement without managed inference — so `desktop-license` has a rate
		// it can never use. Asserted because the docs advertised a Lifetime
		// deposit rate for months, which promised a purchase the API rejects.
		expect(PLANS["desktop-license"].managedInference).toBe(false);
		for (const id of ["pro", "max", "teams", "business"] as PlanId[]) {
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
		expect(PLANS.pro.monthlyCreditPoolMicroUsd).toBe(usdToMicro(15));
		expect(PLANS.max.monthlyCreditPoolMicroUsd).toBe(usdToMicro(30));
	});
});

/**
 * Margin for one HISTORICAL version — its own price, its own pool, but TODAY's
 * node cost.
 *
 * Charging every version the current node is deliberate and conservative. Node
 * type is not versioned (`BASE_NODE_TYPE_BY_PLAN` is keyed by plan), so
 * upgrading a plan's machine upgrades it for grandfathered subscribers too. That
 * is a benefit we choose to give away. The old $99 Max v1 is the one known
 * exception: a current dedicated node can make that historical contract a
 * bounded subsidy, which this suite names instead of hiding.
 */
function versionMarginUsd(
	id: PlanId,
	version: number,
	yearly: boolean,
	seats: number
): number {
	const row = planVersionFor(id, version);
	const monthsBilled = yearly ? YEARLY_MONTHS_BILLED : 1;
	const monthsServed = yearly ? YEARLY_MONTHS_SERVED : 1;

	const billedSeats = PLANS[id].seatModel.kind === "per_seat" ? seats : 1;
	const revenue =
		usd(
			monthlyPriceMicroUsdForSeats({
				plan: PLANS[id],
				seats: billedSeats,
				version: row,
			})
		) * monthsBilled;
	const monthlyPoolUsd = usd(
		monthlyCreditPoolMicroUsdForSeats({
			plan: PLANS[id],
			seats: billedSeats,
			version: row,
		})
	);
	const credits = fundedPoolUsd(monthlyPoolUsd) * monthsServed;
	// Today's node, at the seat count being modelled — so a grandfathered Teams
	// org is charged the same ladder a new one is. Node type and COUNT are not
	// versioned, which means a seat-band upgrade reaches old subscribers too.
	const node = nodeUsdPerMonth(id, seats) * monthsServed;
	const fee = revenue * POLAR_RATE_SUBSCRIPTION + POLAR_FIXED_USD;
	const publisherPool = PLANS[id].marketplacePublisherPool
		? (revenue * DEFAULT_MARKETPLACE_MEMBERSHIP_PUBLISHER_SHARE_BPS) / 10_000
		: 0;

	return revenue - credits - node - fee - publisherPool;
}

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

			it(`${id} v${row.version} is still profitable yearly`, () => {
				expect(
					versionMarginUsd(id, row.version, true, minSeats)
				).toBeGreaterThan(0);
			});

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
