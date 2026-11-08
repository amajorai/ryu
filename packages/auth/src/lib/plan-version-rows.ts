import { z } from "zod";
import type { CreditPoolModel, Plan, PlanId } from "./plan-core.ts";
import { seatPriceMicroUsdForSeats } from "./plan-seat-pricing.ts";
import {
	DEFAULT_VARIANT,
	type IsoDate,
	LEGACY_REGIONS,
	type PlanRegion,
	type PlanVariant,
	type PlanVariantCell,
	type PlanVariantKey,
	variantKey,
} from "./plan-variants.ts";
import { PLAN_VERSIONS, type PlanVersion } from "./plan-version-catalog.ts";

/** Plan catalog part: Current rows per plan and variant, and per-version price and pool math. Re-exported by `plans.ts`. */

/** The version a NEW checkout is stamped with. Bump when adding a row. */
export const CURRENT_PLAN_VERSION = 5;

/** Current immutable pricing snapshot per recurring plan. */
export const CURRENT_PLAN_VERSION_BY_PLAN = {
	"desktop-license": 4,
	"marketplace-membership": 6,
	plus: 2,
	pro: 7,
	max: 4,
	teams: 5,
	"teams-lite": 1,
	business: 2,
} satisfies Record<PlanId, number>;

export const currentPlanVersionFor = (plan: PlanId): number =>
	CURRENT_PLAN_VERSION_BY_PLAN[plan];

/**
 * The newest version per plan at the time row-owned products were introduced:
 * every row up to and including this one sells on the plan-level (shared)
 * `PLANS[plan].bindings`. FROZEN by `money-path-invariants.test.ts`; every row
 * after it must carry its own `bindings`. Verified against `PLAN_VERSIONS` on
 * 2026-10-21 (Plus v2 and Pro v7 are the $9 and $14 pool rows; checkout still
 * sells the shared Plus and Pro products, so they sit inside this bound; note `max` and `desktop-license` have a v5 that is not their
 * current row: both repeat v4's terms and are kept append-only).
 */
export const LEGACY_SHARED_PRODUCT_MAX_VERSION = {
	"desktop-license": 5,
	"marketplace-membership": 6,
	plus: 2,
	pro: 7,
	max: 5,
	teams: 5,
	"teams-lite": 1,
	business: 2,
} satisfies Record<PlanId, number>;

/**
 * The day the public billing docs started describing per-version
 * grandfathering policies instead of "existing customers keep their price".
 * NULL until legal sign-off ships that text (see `docs/pricing-versioning.md`);
 * while it is null no row may be sold under `"notice_may_change"`.
 */
export const GRANDFATHER_PROMISE_CHANGED_ON: IsoDate | null = null;

/**
 * The row SOLD today per plan and variant. One capacity and one provider today,
 * so this is {@link CURRENT_PLAN_VERSION_BY_PLAN} keyed by `hetzner:standard`;
 * a provider or capacity offer adds a key here, never a second current row for
 * the same key.
 */
export const CURRENT_PLAN_ROWS: {
	readonly [Id in PlanId]: Partial<Record<PlanVariantKey, number>> & {
		readonly "hetzner:standard": number;
	};
} = {
	"desktop-license": {
		"hetzner:standard": CURRENT_PLAN_VERSION_BY_PLAN["desktop-license"],
	},
	"marketplace-membership": {
		"hetzner:standard": CURRENT_PLAN_VERSION_BY_PLAN["marketplace-membership"],
	},
	plus: { "hetzner:standard": CURRENT_PLAN_VERSION_BY_PLAN.plus },
	pro: { "hetzner:standard": CURRENT_PLAN_VERSION_BY_PLAN.pro },
	max: { "hetzner:standard": CURRENT_PLAN_VERSION_BY_PLAN.max },
	teams: { "hetzner:standard": CURRENT_PLAN_VERSION_BY_PLAN.teams },
	"teams-lite": {
		"hetzner:standard": CURRENT_PLAN_VERSION_BY_PLAN["teams-lite"],
	},
	business: { "hetzner:standard": CURRENT_PLAN_VERSION_BY_PLAN.business },
};

/** The variant a row is sold on. */
export const rowVariant = (row: PlanVersion): PlanVariant =>
	row.variant ?? DEFAULT_VARIANT;

/** The pricing regions a row's price applies in. */
export const rowRegions = (row: PlanVersion): readonly PlanRegion[] =>
	row.regions ?? LEGACY_REGIONS;

/** Whether `row` is the row currently sold for its plan and variant. */
export const isCurrentRow = (plan: PlanId, row: PlanVersion): boolean => {
	const current: Partial<Record<PlanVariantKey, number>> =
		CURRENT_PLAN_ROWS[plan];
	return current[variantKey(rowVariant(row))] === row.version;
};

/** The row sold today in `cell`, or null when the plan is not sold there. */
export const currentRowFor = (
	plan: PlanId,
	cell: PlanVariantCell
): PlanVersion | null => {
	const current: Partial<Record<PlanVariantKey, number>> =
		CURRENT_PLAN_ROWS[plan];
	const version = current[variantKey(cell)];
	const row = PLAN_VERSIONS[plan].find(
		(candidate) => candidate.version === version
	);
	return row && rowRegions(row).includes(cell.region) ? row : null;
};

/** Decode a provider's legacy version marker with native Number semantics.
 * Unknown versions still fall back to the oldest row; symbols retain their
 * native conversion error. JSON arrays and booleans were accepted by this
 * lookup before provider metadata gained an explicit input contract.
 */
export const planVersionInputSchema = z
	.unknown()
	.transform((value) => Number(value));

/**
 * The version row for `plan`, or the OLDEST row when the version is unknown.
 *
 * Falling back to v1 rather than the newest is a FAIL-SAFE, not a migration
 * path: no unstamped subscription has ever existed (production was empty when
 * versioning shipped, and every checkout has stamped since). It matters only if
 * metadata is ever lost or a subscription arrives from a path that forgets to
 * stamp — and in that case the cheap answer is the safe one, because handing out
 * the NEWEST pool to a subscription of unknown vintage is how a grandfathered
 * customer silently starts losing money.
 */
export const planVersionFor = (
	plan: PlanId,
	version?: z.input<typeof planVersionInputSchema>
): PlanVersion => {
	const rows = PLAN_VERSIONS[plan];
	const wanted = planVersionInputSchema.parse(version);
	if (Number.isFinite(wanted)) {
		const hit = rows.find((r) => r.version === wanted);
		if (hit) {
			return hit;
		}
	}
	return rows[0];
};

/** Resolve the historical/current pool model for one plan version. */
export const creditPoolModelForVersion = (
	plan: Plan,
	version: PlanVersion
): CreditPoolModel => version.creditPoolModel ?? plan.creditPoolModel;

/**
 * Calculate the monthly included pool for a plan at a billed seat count.
 *
 * Teams v5 uses a five-seat bundle: five billed seats receive $50, ten receive
 * $100, and so on. Current Business uses completed bundles: five through nine
 * billed seats receive $100, ten through fourteen receive $200, and so on. The
 * version row owns the scaling rule so older contracts remain grandfathered
 * when the public offer changes.
 */
export const monthlyCreditPoolMicroUsdForSeats = (input: {
	plan: Plan;
	version: PlanVersion;
	seats: number;
}): number => {
	const seats = Number.isFinite(input.seats)
		? Math.max(1, Math.floor(input.seats))
		: 1;
	const model = creditPoolModelForVersion(input.plan, input.version);
	if (model === "fixed") {
		return input.version.monthlyCreditPoolMicroUsd;
	}
	if (model === "per_seat") {
		return input.version.monthlyCreditPoolMicroUsd * seats;
	}
	const bundleSize = Math.max(
		1,
		Math.floor(
			input.version.creditPoolBundleSize ??
				input.plan.creditPoolBundleSize ??
				(input.plan.seatModel.kind === "per_seat"
					? input.plan.seatModel.minSeats
					: 1)
		)
	);
	const bundleCount =
		model === "per_completed_bundle"
			? Math.max(1, Math.floor(seats / bundleSize))
			: Math.ceil(seats / bundleSize);
	return input.version.monthlyCreditPoolMicroUsd * bundleCount;
};

/** Calculate the actual recurring price for one plan at one billed seat count. */
export const monthlyPriceMicroUsdForSeats = (input: {
	plan: Plan;
	version?: PlanVersion;
	seats: number;
}): number => {
	const minimum =
		input.plan.seatModel.kind === "per_seat"
			? input.plan.seatModel.minSeats
			: 1;
	const seats = Number.isFinite(input.seats)
		? Math.max(minimum, Math.floor(input.seats))
		: minimum;
	const tiers = input.version?.seatPriceTiers ?? input.plan.seatPriceTiers;
	if (tiers) {
		return seatPriceMicroUsdForSeats(tiers, seats);
	}
	const monthlyPriceMicroUsd =
		input.version?.monthlyPriceMicroUsd ?? input.plan.monthlyPriceMicroUsd;
	if (input.plan.seatModel.kind === "per_seat") {
		return monthlyPriceMicroUsd * seats;
	}
	return monthlyPriceMicroUsd;
};

/**
 * The free managed cloud node is included with every recurring managed plan
 * in a supported/default region: one base server, `cx23` in the EU for every
 * plan (Teams, Teams Lite and Business may get the same-price `cpx22` when
 * `cx23` is sold out). Plus, Pro and Max do not promise a free regional node in
 * Singapore because its shapes exceed their safe annual cost envelope; Teams,
 * Teams Lite, and Business use `cpx22` there. The server-side location resolver owns that exception. The node's
 * compute cost is absorbed into the plan price; there is no separate Polar
 * product for an included node, so holding a qualifying subscription is what
 * grants it. Any other instance is a dynamically-priced, ad-hoc paid
 * cloud-instance subscription on top, gated by `hasActiveCloudInstanceSub` in
 * `plan-entitlement.ts`.
 *
 * The set + predicate live in the client-safe sibling `./base-node.ts`
 * (`PLANS_INCLUDING_BASE_NODE` / `planIncludesBaseNode` / the copy label). They
 * are NOT here on purpose: the pricing page and org dashboard are client trees
 * and must not pull this catalog — every Polar product id and env-var name —
 * into the browser to read one predicate. This replaced a
 * `MAX_INCLUDES_BASE_CLOUD = true` constant that nothing ever imported, while
 * two separate call sites hardcoded the literal `"max"` and drifted apart.
 */
