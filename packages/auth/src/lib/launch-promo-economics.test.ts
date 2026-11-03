import { describe, expect, it } from "bun:test";
import {
	discountedMargin,
	LAUNCH_PROMO_MIN_MARGIN_RATIO,
	LAUNCH_PROMO_OFFER,
	launchPromoCells,
	launchPromoRows,
} from "./launch-promo.ts";
import type { MarginBreakdown } from "./plan-margin.ts";
import { nodeReserveFn } from "./provider-node-costs.ts";

/**
 * THE ECONOMICS GUARD for the public LAUNCH30 code.
 *
 * `plan-economics.test.ts` proves the list catalog makes money. A public
 * percentage code cuts revenue while the plan still grants its full pool and
 * provisions its node, so every period the code can discount is held here to
 * `LAUNCH_PROMO_MIN_MARGIN_RATIO` with the same worst-case engine.
 */

const RESERVE = nodeReserveFn(new Date());

const breakdown = (fields: Partial<MarginBreakdown>): MarginBreakdown => ({
	creditsUsd: 0,
	mailAndStorageUsd: 0,
	marginRatio: 0,
	marginUsd: 0,
	nodeCount: 0,
	nodeType: null,
	nodeUsd: 0,
	polarFeeUsd: 0,
	publisherUsd: 0,
	revenueUsd: 0,
	...fields,
});

describe("LAUNCH30 scope", () => {
	it("is 30% off the first monthly period only", () => {
		expect(LAUNCH_PROMO_OFFER.code).toBe("LAUNCH30");
		expect(LAUNCH_PROMO_OFFER.discountBasisPoints).toBe(3000);
		expect(LAUNCH_PROMO_OFFER.duration).toBe("once");
		expect(LAUNCH_PROMO_OFFER.interval).toBe("monthly");
	});

	it("covers a current row for every eligible plan", () => {
		const plans = new Set(launchPromoRows().map(({ plan }) => plan));
		for (const plan of LAUNCH_PROMO_OFFER.planIds) {
			expect(plans.has(plan)).toBe(true);
		}
	});
});

describe("LAUNCH30 discounted month economics", () => {
	const cells = launchPromoCells(RESERVE);

	it("prices every plan, region and seat band", () => {
		expect(cells.length).toBeGreaterThanOrEqual(
			LAUNCH_PROMO_OFFER.planIds.length
		);
	});

	it("keeps every discounted monthly period at or above the floor", () => {
		const losses = cells
			.filter((cell) => cell.marginRatio < LAUNCH_PROMO_MIN_MARGIN_RATIO)
			.map(
				(cell) =>
					`${cell.plan} v${cell.version} ${cell.region} ${cell.seats} seats: ${cell.marginUsd.toFixed(2)} USD`
			);
		expect(losses).toEqual([]);
	});
});

describe("LAUNCH30 never applies to annual terms", () => {
	it("would lose money on at least one annual term (the regression this guards)", () => {
		const yearly = launchPromoCells(RESERVE, "yearly");
		expect(yearly[0]?.marginUsd ?? 0).toBeLessThan(0);
	});
});

describe("discountedMargin", () => {
	it("scales revenue, Polar and publisher costs but keeps delivery costs", () => {
		const list = breakdown({
			creditsUsd: 10,
			mailAndStorageUsd: 1,
			nodeUsd: 12,
			publisherUsd: 10,
			revenueUsd: 100,
		});
		const result = discountedMargin(list, 3000);
		expect(result.revenueUsd).toBeCloseTo(70, 10);
		// 70 revenue - 23 delivery - 7 publisher - Polar on 70.
		expect(result.marginUsd).toBeLessThan(70 - 23 - 7);
		expect(result.marginUsd).toBeGreaterThan(70 - 23 - 7 - 10);
	});

	it("treats a 100% discount as zero revenue", () => {
		const result = discountedMargin(breakdown({ revenueUsd: 50 }), 10_000);
		expect(result.revenueUsd).toBe(0);
		expect(result.marginRatio).toBe(0);
	});
});
