import {
	currentMarginRows,
	type MarginBreakdown,
	type MarginRowInput,
	type MarginTerm,
	planMargin,
	seatBandsFor,
} from "./plan-margin.ts";
import {
	type PlanId,
	rowRegions,
	rowVariant,
	TOPUP_POLAR_PROCESSING_BPS,
	TOPUP_POLAR_PROCESSING_FIXED_USD,
} from "./plans.ts";
import type { NodeReserveFn } from "./provider-node-costs.ts";

/**
 * The public LAUNCH30 code the landing-page scratch card reveals.
 *
 * WHY IT IS SCOPED. A plain Polar percentage code keeps the plan's full
 * included credit pool and node while collecting 70% of the price. Run through
 * the margin engine (`plan-margin.ts`), that LOSES money on every annual term
 * that sits near the 20% yearly floor: Plus about -$29, Pro about -$29, Max
 * about -$76 a year, and the Singapore Teams/Business rows about -$134. The
 * first MONTH of a monthly plan stays profitable for every plan, region and
 * self-serve seat band, so the code is limited to that: 30% off once, on the
 * current monthly products of {@link LAUNCH_PROMO_OFFER.planIds} only.
 * `launch-promo-economics.test.ts` holds every eligible discounted month to a
 * non-negative contribution and fails if an annual term would ever qualify.
 *
 * `scripts/polar/provision-launch-promo.ts` writes exactly this scope to Polar.
 */
export const LAUNCH_PROMO_OFFER = {
	code: "LAUNCH30",
	discountBasisPoints: 3000,
	duration: "once",
	interval: "monthly",
	planIds: [
		"plus",
		"pro",
		"max",
		"teams",
		"teams-lite",
		"business",
	] as const satisfies readonly PlanId[],
} as const;

/** Smallest contribution ratio a discounted launch month may keep. */
export const LAUNCH_PROMO_MIN_MARGIN_RATIO = 0;

/**
 * One billing period's margin with a percentage discount applied: revenue,
 * Polar processing and the publisher share scale with what is actually paid,
 * while credits, node and mail/storage are the list costs (the code does not
 * shrink what the plan delivers).
 */
export const discountedMargin = (
	list: MarginBreakdown,
	discountBasisPoints: number
): { marginRatio: number; marginUsd: number; revenueUsd: number } => {
	const kept = Math.min(1, Math.max(0, 1 - discountBasisPoints / 10_000));
	const revenueUsd = list.revenueUsd * kept;
	const polarFeeUsd =
		revenueUsd * (TOPUP_POLAR_PROCESSING_BPS / 10_000) +
		TOPUP_POLAR_PROCESSING_FIXED_USD;
	const marginUsd =
		revenueUsd -
		list.creditsUsd -
		list.nodeUsd -
		list.mailAndStorageUsd -
		polarFeeUsd -
		list.publisherUsd * kept;
	return {
		marginRatio: revenueUsd > 0 ? marginUsd / revenueUsd : 0,
		marginUsd,
		revenueUsd,
	};
};

export interface LaunchPromoCell {
	readonly marginRatio: number;
	readonly marginUsd: number;
	readonly plan: PlanId;
	readonly region: string;
	readonly seats: number;
	readonly version: number;
}

/** Current margin rows for the plans the code is scoped to. */
export const launchPromoRows = (): MarginRowInput[] => {
	const eligible = new Set<PlanId>(LAUNCH_PROMO_OFFER.planIds);
	return currentMarginRows().filter(({ plan }) => eligible.has(plan));
};

/**
 * The discounted period for every current row, region and seat band of the
 * given plans and term, worst first.
 */
export const launchPromoCells = (
	nodeReserveUsd: NodeReserveFn,
	term: MarginTerm = LAUNCH_PROMO_OFFER.interval,
	rows: readonly MarginRowInput[] = launchPromoRows()
): LaunchPromoCell[] => {
	const cells: LaunchPromoCell[] = [];
	for (const { plan, row } of rows) {
		const variant = rowVariant(row);
		for (const region of rowRegions(row)) {
			for (const seats of seatBandsFor(plan)) {
				const list = planMargin({
					cell: { ...variant, region },
					nodeReserveUsd,
					plan,
					row,
					seats,
					term,
				});
				const { marginRatio, marginUsd } = discountedMargin(
					list,
					LAUNCH_PROMO_OFFER.discountBasisPoints
				);
				cells.push({
					marginRatio,
					marginUsd,
					plan,
					region,
					seats,
					version: row.version,
				});
			}
		}
	}
	return cells.sort((left, right) => left.marginRatio - right.marginRatio);
};
