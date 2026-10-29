import {
	baseNodeCountForPlanAtLocation,
	baseNodeTypeForPlanAtLocation,
	legacyBaseNodeCountForPlanAtLocation,
	legacyBaseNodeTypeForPlanAtLocation,
	stockFallbackNodeTypeForPlanAtLocation,
} from "./base-node.ts";
import { DEFAULT_MARKETPLACE_MEMBERSHIP_PUBLISHER_SHARE_BPS } from "./marketplace-membership.ts";
import {
	type IsoDate,
	type PlanRegion,
	type PlanVariantCell,
	type PlanVariantKey,
	representativeLocationForRegion,
	variantKey,
} from "./plan-variants.ts";
import {
	CURRENT_PLAN_ROWS,
	emailQuotaForPlan,
	monthlyCreditPoolMicroUsdForSeats,
	monthlyPriceMicroUsdForSeats,
	openRouterCreditPurchaseCostUsd,
	PLAN_IDS,
	PLAN_VERSIONS,
	PLANS,
	type PlanId,
	type PlanVersion,
	planLimit,
	rowRegions,
	rowVariant,
	TOPUP_POLAR_PROCESSING_BPS,
	TOPUP_POLAR_PROCESSING_FIXED_USD,
} from "./plans.ts";
import type { NodeReserveFn } from "./provider-node-costs.ts";
import { SELF_SERVE_MAX_SEATS } from "./seat-tiers.ts";

/**
 * THE PLAN MARGIN ENGINE — one formula for the CI guard and the live check.
 *
 * `plan-economics.test.ts` used to own this formula privately, so the only time
 * anyone learned a plan had stopped making money was when someone changed the
 * catalog and ran the tests. A provider price rise changes no file in this
 * repo, so it could never trip that guard. The formula now lives here, pure,
 * and is run both by the test (against the cost table) and by the API's
 * scheduled margin check (against the live provider catalog), which alerts the
 * admins when a row drops under the floor.
 *
 * Worst case by construction: it assumes the subscriber spends 100% of the
 * pool, and costs the node at the DEARER of the plan's base server and its
 * stock fallback, because which one a buyer gets depends on stock at purchase.
 *
 * LEGACY NODES. A subscriber whose server was created by the old per-plan
 * ladder keeps it (Max `cx33`, Teams `cx43`, Business `cx53`, Business `cpx32`
 * in Singapore): servers are never resized up or down by renewals, seat
 * changes or upgrades. A grandfathered row is therefore costed on the dearer
 * of today's node and that legacy node. A current row is held to the floor on
 * today's node (new buyers get it) but reports a LOSS when a legacy node would
 * make it lose money, so a provider price rise on a legacy type is seen.
 */

/** The yearly contribution floor every CURRENT row must clear. */
export const YEARLY_MARGIN_FLOOR = 0.2;

/** Annual terms bill 10 months and serve 12 ("two months free"). */
export const YEARLY_MONTHS_BILLED = 10;
export const YEARLY_MONTHS_SERVED = 12;

const usd = (micro: number): number => micro / 1_000_000;

/**
 * Amazon SES outbound rate: $0.10 per 1,000 emails, where SES counts each
 * recipient as one email (the same unit `emailMonthlySendLimit` counts).
 * Source: https://aws.amazon.com/ses/pricing/ (outbound email, no free tier
 * assumed). Attachment data ($0.12/GB) and inbound receiving are not modelled.
 */
export const SES_USD_PER_1000_EMAILS = 0.1;
/**
 * Stored mail lives in S3 (`packages/mail`). S3 Standard in ap-southeast-1,
 * first 50 TB/month: $0.025 per GB-month. Source:
 * https://aws.amazon.com/s3/pricing/. Space storage is costed at the same rate:
 * that is a conservative stand-in, not a statement of where Spaces are stored.
 * Request and egress charges are not modelled.
 */
export const STORAGE_USD_PER_GB_MONTH = 0.025;
const BYTES_PER_GIB = 1024 ** 3;

/**
 * What a plan's mail and storage allowances cost Ryu per month, worst case: the
 * whole send allowance is used and both storage caps are full. Resolved through
 * the enforced quotas (`emailQuotaForPlan`, `planLimit`), so a plan on the free
 * mail baseline is costed at that baseline and an unbounded cap is a hard
 * failure, never a silent $0. Allowances are not versioned, so every row of a
 * plan is charged today's allowances.
 */
export const mailAndStorageUsdPerMonth = (id: PlanId): number => {
	const mail = emailQuotaForPlan(id);
	const mailGb = mail.storageLimitBytes / BYTES_PER_GIB;
	const spaceGb = planLimit(id, "spaceStorageLimitGb");
	if (
		!(
			Number.isFinite(mail.monthlySendLimit) &&
			Number.isFinite(mailGb) &&
			Number.isFinite(spaceGb)
		)
	) {
		throw new Error(
			`${id} has an unbounded mail or storage allowance; the margin model cannot price it`
		);
	}
	return (
		(mail.monthlySendLimit / 1000) * SES_USD_PER_1000_EMAILS +
		(mailGb + spaceGb) * STORAGE_USD_PER_GB_MONTH
	);
};

export type MarginTerm = "monthly" | "yearly";

export interface MarginInput {
	readonly cell: PlanVariantCell;
	/** Also cost the node the legacy ladder gave this plan (see the header). */
	readonly legacyNode?: boolean;
	readonly nodeReserveUsd: NodeReserveFn;
	readonly plan: PlanId;
	readonly row: PlanVersion;
	readonly seats: number;
	readonly term: MarginTerm;
}

export interface MarginBreakdown {
	readonly creditsUsd: number;
	readonly mailAndStorageUsd: number;
	readonly marginRatio: number;
	readonly marginUsd: number;
	readonly nodeCount: number;
	readonly nodeType: string | null;
	readonly nodeUsd: number;
	readonly polarFeeUsd: number;
	readonly publisherUsd: number;
	readonly revenueUsd: number;
}

/**
 * The included node(s) a plan is costed on in a region: the dearer of the base
 * server and its stock fallback, times the count. With `legacyNode`, the
 * dearer (in total) of that and the node(s) the legacy ladder provisioned.
 * Throws on an unpriced type (via `nodeReserveUsd`): silently costing a band
 * $0 is how an unprofitable tier would slip through.
 */
export const marginNodeFor = (
	plan: PlanId,
	cell: PlanVariantCell,
	seats: number,
	nodeReserveUsd: NodeReserveFn,
	options: { legacyNode?: boolean } = {}
): { count: number; type: string | null; unitUsd: number } => {
	const location = representativeLocationForRegion(cell.region);
	const base = baseNodeTypeForPlanAtLocation(plan, location, seats);
	let node: { count: number; type: string | null; unitUsd: number } = {
		count: 0,
		type: null,
		unitUsd: 0,
	};
	if (base) {
		const fallback = stockFallbackNodeTypeForPlanAtLocation(plan, location);
		const baseUsd = nodeReserveUsd(cell.provider, cell.region, base);
		const fallbackUsd = fallback
			? nodeReserveUsd(cell.provider, cell.region, fallback)
			: 0;
		node = {
			count: baseNodeCountForPlanAtLocation(plan, location, seats),
			type: fallback && fallbackUsd > baseUsd ? fallback : base,
			unitUsd: Math.max(baseUsd, fallbackUsd),
		};
	}
	const legacy = options.legacyNode
		? legacyBaseNodeTypeForPlanAtLocation(plan, location)
		: null;
	if (!legacy) {
		return node;
	}
	const legacyUnitUsd = nodeReserveUsd(cell.provider, cell.region, legacy);
	const legacyCount = legacyBaseNodeCountForPlanAtLocation(
		plan,
		location,
		seats
	);
	return legacyUnitUsd * legacyCount > node.unitUsd * node.count
		? { count: legacyCount, type: legacy, unitUsd: legacyUnitUsd }
		: node;
};

/** Whether the plan's legacy ladder provisioned a node in the cell's region. */
export const hasLegacyNode = (plan: PlanId, cell: PlanVariantCell): boolean =>
	legacyBaseNodeTypeForPlanAtLocation(
		plan,
		representativeLocationForRegion(cell.region)
	) !== null;

/** Margin on one billing period, with every real cost subtracted. */
export const planMargin = (input: MarginInput): MarginBreakdown => {
	const plan = PLANS[input.plan];
	const yearly = input.term === "yearly";
	const billedSeats = plan.seatModel.kind === "per_seat" ? input.seats : 1;
	const monthsBilled = yearly ? YEARLY_MONTHS_BILLED : 1;
	const monthsServed = yearly ? YEARLY_MONTHS_SERVED : 1;
	const revenueUsd =
		usd(
			monthlyPriceMicroUsdForSeats({
				plan,
				seats: billedSeats,
				version: input.row,
			})
		) * monthsBilled;
	const poolUsd = usd(
		monthlyCreditPoolMicroUsdForSeats({
			plan,
			seats: billedSeats,
			version: input.row,
		})
	);
	const creditsUsd = openRouterCreditPurchaseCostUsd(poolUsd) * monthsServed;
	const node = marginNodeFor(
		input.plan,
		input.cell,
		input.seats,
		input.nodeReserveUsd,
		{ legacyNode: input.legacyNode }
	);
	const nodeUsd = node.unitUsd * node.count * monthsServed;
	const mailAndStorageUsd =
		mailAndStorageUsdPerMonth(input.plan) * monthsServed;
	const polarFeeUsd =
		revenueUsd * (TOPUP_POLAR_PROCESSING_BPS / 10_000) +
		TOPUP_POLAR_PROCESSING_FIXED_USD;
	const publisherUsd = plan.marketplacePublisherPool
		? (revenueUsd * DEFAULT_MARKETPLACE_MEMBERSHIP_PUBLISHER_SHARE_BPS) / 10_000
		: 0;
	const marginUsd =
		revenueUsd -
		creditsUsd -
		nodeUsd -
		mailAndStorageUsd -
		polarFeeUsd -
		publisherUsd;
	return {
		creditsUsd,
		mailAndStorageUsd,
		marginRatio: revenueUsd > 0 ? marginUsd / revenueUsd : 0,
		marginUsd,
		nodeCount: node.count,
		nodeType: node.type,
		nodeUsd,
		polarFeeUsd,
		publisherUsd,
		revenueUsd,
	};
};

/** Every seat count a plan can be bought at self-serve (one for single plans). */
export const seatBandsFor = (plan: PlanId): number[] => {
	const model = PLANS[plan].seatModel;
	if (model.kind !== "per_seat") {
		return [1];
	}
	const bands: number[] = [];
	for (let seats = model.minSeats; seats <= SELF_SERVE_MAX_SEATS; seats++) {
		bands.push(seats);
	}
	return bands;
};

/**
 * A current row allowed under the yearly floor for a bounded time. The set may
 * only shrink; an entry past `expiresOn` fails CI, which forces a decision
 * (reprice, accept and extend with a new review, or stop selling). Empty: on
 * the one-base-server catalog every current row clears the floor in every
 * region and seat band.
 */
export interface FloorException {
	readonly approvedBy: string;
	readonly expiresOn: IsoDate;
	readonly plan: PlanId;
	readonly reason: string;
	readonly region: PlanRegion;
	readonly seats: readonly [number, number];
	readonly version: number;
}
export const FLOOR_EXCEPTIONS: readonly FloorException[] = [];

export type RowMarginStatus =
	| "ok"
	| "floor"
	| "grandfathered_floor"
	| "loss"
	| "exception";

export interface RowMarginResult {
	readonly current: boolean;
	/**
	 * The worst yearly margin with the legacy ladder's node, when the plan had
	 * one in this region (null otherwise). For a grandfathered row it is folded
	 * into `worstYearly`; for a current row it only decides `loss`.
	 */
	readonly legacyNodeWorstYearly: {
		readonly ratio: number;
		readonly seats: number;
	} | null;
	readonly plan: PlanId;
	readonly region: PlanRegion;
	readonly status: RowMarginStatus;
	readonly variantKey: PlanVariantKey;
	readonly version: number;
	readonly worstMonthly: { readonly ratio: number; readonly seats: number };
	readonly worstYearly: { readonly ratio: number; readonly seats: number };
}

/** A row the engine evaluates. */
export interface MarginRowInput {
	readonly current: boolean;
	readonly plan: PlanId;
	readonly row: PlanVersion;
}

/** Plans with a recurring price: the only ones a margin describes. */
export const RECURRING_PLAN_IDS: readonly PlanId[] = PLAN_IDS.filter(
	(id) => PLANS[id].monthlyPriceMicroUsd > 0
);

/** Every current recurring row (one per plan and variant). */
export const currentMarginRows = (): MarginRowInput[] => {
	const rows: MarginRowInput[] = [];
	for (const plan of RECURRING_PLAN_IDS) {
		const current: Partial<Record<PlanVariantKey, number>> =
			CURRENT_PLAN_ROWS[plan];
		for (const version of Object.values(current)) {
			const row = PLAN_VERSIONS[plan].find(
				(candidate) => candidate.version === version
			);
			if (row) {
				rows.push({ current: true, plan, row });
			}
		}
	}
	return rows;
};

/** Every recurring row, current or grandfathered. */
export const allMarginRows = (): MarginRowInput[] => {
	const rows: MarginRowInput[] = [];
	for (const plan of RECURRING_PLAN_IDS) {
		const current: Partial<Record<PlanVariantKey, number>> =
			CURRENT_PLAN_ROWS[plan];
		for (const row of PLAN_VERSIONS[plan]) {
			rows.push({
				current: current[variantKey(rowVariant(row))] === row.version,
				plan,
				row,
			});
		}
	}
	return rows;
};

/** The unexpired exception covering one band, if any. */
export const floorExceptionFor = (
	input: { plan: PlanId; region: PlanRegion; seats: number; version: number },
	now: Date,
	exceptions: readonly FloorException[] = FLOOR_EXCEPTIONS
): FloorException | null =>
	exceptions.find(
		(entry) =>
			entry.plan === input.plan &&
			entry.version === input.version &&
			entry.region === input.region &&
			input.seats >= entry.seats[0] &&
			input.seats <= entry.seats[1] &&
			Date.parse(`${entry.expiresOn}T00:00:00Z`) > now.getTime()
	) ?? null;

/**
 * Evaluate every row in every region it is sold in, at every seat band, on
 * both terms. Throws when a node type has no cost: the caller records a failed
 * run, never a $0 node.
 */
export const evaluateRowMargins = (
	rows: readonly MarginRowInput[],
	nodeReserveUsd: NodeReserveFn,
	now: Date,
	exceptions: readonly FloorException[] = FLOOR_EXCEPTIONS
): RowMarginResult[] => {
	const results: RowMarginResult[] = [];
	for (const { current, plan, row } of rows) {
		const variant = rowVariant(row);
		for (const region of rowRegions(row)) {
			const cell: PlanVariantCell = { ...variant, region };
			let worstYearly = { ratio: Number.POSITIVE_INFINITY, seats: 0 };
			let worstMonthly = { ratio: Number.POSITIVE_INFINITY, seats: 0 };
			let legacyWorst: { ratio: number; seats: number } | null = null;
			let anyLoss = false;
			let uncoveredFloor = false;
			let coveredFloor = false;
			const legacy = hasLegacyNode(plan, cell);
			for (const seats of seatBandsFor(plan)) {
				const at = (term: MarginTerm, legacyNode: boolean) =>
					planMargin({
						cell,
						legacyNode,
						nodeReserveUsd,
						plan,
						row,
						seats,
						term,
					});
				// A grandfathered row is costed on the legacy node throughout; a
				// current row is held to the floor on today's node only.
				const yearly = at("yearly", legacy && !current);
				const monthly = at("monthly", legacy && !current);
				if (legacy) {
					const legacyYearly = current ? at("yearly", true) : yearly;
					const legacyMonthly = current ? at("monthly", true) : monthly;
					if (!legacyWorst || legacyYearly.marginRatio < legacyWorst.ratio) {
						legacyWorst = { ratio: legacyYearly.marginRatio, seats };
					}
					if (legacyYearly.marginUsd < 0 || legacyMonthly.marginUsd < 0) {
						anyLoss = true;
					}
				}
				if (yearly.marginRatio < worstYearly.ratio) {
					worstYearly = { ratio: yearly.marginRatio, seats };
				}
				if (monthly.marginRatio < worstMonthly.ratio) {
					worstMonthly = { ratio: monthly.marginRatio, seats };
				}
				if (yearly.marginUsd < 0 || monthly.marginUsd < 0) {
					anyLoss = true;
				}
				if (yearly.marginRatio < YEARLY_MARGIN_FLOOR) {
					const exception = floorExceptionFor(
						{ plan, region, seats, version: row.version },
						now,
						exceptions
					);
					if (exception) {
						coveredFloor = true;
					} else {
						uncoveredFloor = true;
					}
				}
			}
			let status: RowMarginStatus = "ok";
			if (anyLoss) {
				status = "loss";
			} else if (!current && (uncoveredFloor || coveredFloor)) {
				status = "grandfathered_floor";
			} else if (uncoveredFloor) {
				status = "floor";
			} else if (coveredFloor) {
				status = "exception";
			}
			results.push({
				current,
				legacyNodeWorstYearly: legacyWorst,
				plan,
				region,
				status,
				variantKey: variantKey(variant),
				version: row.version,
				worstMonthly,
				worstYearly,
			});
		}
	}
	return results;
};
