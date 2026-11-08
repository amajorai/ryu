import {
	type BillingInterval,
	type CreditPoolModel,
	type PlanId,
	type PolarBinding,
	usdToMicro,
} from "./plan-core.ts";
import {
	BUSINESS_SEAT_PRICE_TIERS,
	type PlanSeatPriceTier,
	TEAMS_LITE_SEAT_PRICE_TIERS,
} from "./plan-seat-pricing.ts";
import type { IsoDate, PlanRegion, PlanVariant } from "./plan-variants.ts";

/** Plan catalog part: The append-only pricing version rows (`PLAN_VERSIONS`). Re-exported by `plans.ts`. */

/**
 * The map keyed by plan → recurring list price (micro-USD): per month for single
 * plans, per SEAT per month for Teams, Teams Lite, and Business. The one-time desktop license has no
 * recurring price (0). These are the ONLY plan-price figures in the codebase;
 * the included credit grant is DERIVED from them by
 * {@link includedCreditPoolMicroUsd}, never hand-typed per row.
 */
export const PLAN_MONTHLY_PRICE_MICRO_USD = {
	"desktop-license": 0, // one-time list price; no recurring price
	"marketplace-membership": usdToMicro(20),
	plus: usdToMicro(39),
	pro: usdToMicro(49),
	max: usdToMicro(99),
	// Per-seat list price. Five Teams seats therefore start at $250/mo.
	teams: usdToMicro(50),
	// Teams Lite charges $30 per seat for the first five seats, so its floor is $150/mo.
	"teams-lite": usdToMicro(30),
	// Business's first graduated band is $60/seat for five seats ($300/mo);
	// subsequent seats use the tiered price recorded below.
	business: usdToMicro(60),
} satisfies Record<PlanId, number>;

/* -------------------------------------------------------------------------- *
 * PLAN VERSIONS — what a subscriber bought, not what we sell today.
 * -------------------------------------------------------------------------- */

/** One historical (price, pool) pairing for a plan. Append-only. */
export interface PlanVersion {
	/** Marginal price after the version's base seat count, when graduated. */
	readonly additionalSeatPriceMicroUsd?: number;
	/** Total price at the version's minimum seat count, when graduated. */
	readonly baseMonthlyPriceMicroUsd?: number;
	/**
	 * The Polar products this row OWNS, per interval. Absent on every row up to
	 * {@link LEGACY_SHARED_PRODUCT_MAX_VERSION}: those sell on the plan-level
	 * `PLANS[plan].bindings`, shared across versions and told apart by the
	 * `planVersion` checkout stamp. Every later row must own its products, so the
	 * product id alone identifies the row (a migration changes the product, and
	 * Polar cannot re-stamp metadata). `money-path-invariants.test.ts` enforces it.
	 */
	readonly bindings?: Partial<Record<BillingInterval, PolarBinding>>;
	/** Bundle size for a bundled historical pool. */
	readonly creditPoolBundleSize?: number;
	/** Historical pool scaling, when it differs from the current plan model. */
	readonly creditPoolModel?: CreditPoolModel;
	/** Included pool per month; scaling is controlled by this row or the live plan. */
	readonly monthlyCreditPoolMicroUsd: number;
	/** List price when this version was sold, per month / per seat. */
	readonly monthlyPriceMicroUsd: number;
	/** Pricing regions this row's price applies in. Absent: every region. */
	readonly regions?: readonly PlanRegion[];
	/** Graduated seat prices for this historical/current version, when any. */
	readonly seatPriceTiers?: readonly PlanSeatPriceTier[];
	/** Release date, required for rows after the legacy shared-product max. */
	readonly shippedOn?: IsoDate;
	/**
	 * The promise this row was SOLD under. Absent means `"pinned"`: the public
	 * billing docs say existing contracted organizations keep their contracted
	 * price and pool, so every row sold so far was sold pinned, and an adverse
	 * migration of it needs an explicit, reviewed override in
	 * `plan-grandfathering.ts`. `"notice_may_change"` is only valid for rows
	 * shipped on or after {@link GRANDFATHER_PROMISE_CHANGED_ON}.
	 */
	readonly soldUnder?: ContractPromise;
	/** What the row is sold on. Absent: {@link DEFAULT_VARIANT}. */
	readonly variant?: PlanVariant;
	/** Monotonic; 1 is the original. */
	readonly version: number;
}

/** The price promise a row was sold under. See {@link PlanVersion.soldUnder}. */
export type ContractPromise = "pinned" | "notice_may_change";

/**
 * THE GRANDFATHERING TABLE, and the reason it has to exist.
 *
 * Polar already grandfathers the PRICE: a checkout pins the amount onto the
 * subscription, so changing a product's price never touches anyone who already
 * bought. That half is free and always worked.
 *
 * The POOL was not grandfathered at all. `resolveEntitlement` read
 * `plan.monthlyCreditPoolMicroUsd` off the live catalog on every call, keyed
 * only by product id, so the moment the pool was raised for new buyers it rose
 * for EVERY existing subscriber — including the ones still paying the old, lower
 * price. That is the exact inverse of grandfathering, and it is a loss, not a
 * trimmed margin: a $39 Pro subscriber handed a $25 pool clears $4.54/mo and
 * **−$15.61 on the annual plan**.
 *
 * So a version records the pair. A subscription carries its version in
 * server-set Polar checkout metadata, and its entitlement resolves from THAT
 * row. Raising the pool in v2 then cannot reach a v1 subscriber.
 *
 * NOTHING IS BEING MIGRATED HERE. Production had zero subscriptions of any
 * status when this shipped, so v1 is not a legacy population to protect — it is
 * the cohort we START accumulating today, and every one of them is stamped at
 * checkout. The machinery is inert until v2 exists; that is the point of adding
 * it before the price rise rather than during it.
 *
 * APPEND ONLY. Never edit a shipped row — someone is still being billed against
 * it, and rewriting history is how a grandfathered customer silently starts
 * losing money. To change pricing, push a new row that OWNS its Polar products
 * (`bindings`), point {@link CURRENT_PLAN_ROWS} at it, and declare every
 * superseded row's fate in `GRANDFATHERING_DECISIONS` (`plan-grandfathering.ts`):
 * kept forever, kept until a date, or moved at a renewal with at least 30 days'
 * notice. Moves are run by the migration job only after an admin arms them;
 * never `--reprice` a Polar product that still has subscribers. See
 * `docs/pricing-versioning.md`.
 *
 * NOT YET POSSIBLE: making a row-owned row CURRENT. Checkout, plan change and
 * the org-subscription lookup (`billing.ts`) still sell and recognise the
 * plan-level `PLANS[plan].bindings` and stamp the current version, so a
 * current row above {@link LEGACY_SHARED_PRODUCT_MAX_VERSION} would be sold
 * the shared product with a stamp none of its rows has and resolve to the
 * OLDEST row. Route those through `bindingFor(plan, currentRowFor(...))` and
 * {@link planProductIndex} first; `money-path-invariants.test.ts` ("resolves
 * the product checkout sells to the current row") fails until then.
 *
 * NODE TYPE IS DELIBERATELY NOT VERSIONED (the node profile is per variant,
 * not per row). `BASE_NODE_TYPE_BY_PLAN` is keyed by
 * plan: a NEW server for any subscriber gets today's base server, while a
 * server that already exists keeps the size it was created with (never resized
 * by a renewal, seat change or upgrade; see `base-node.ts`). The margin model
 * in `plan-economics.test.ts` charges every version the current node cost and
 * separately checks the grandfathered legacy sizes.
 */
/** Every supported plan has at least one historical commercial version. */
export type PlanVersionCatalog = {
	readonly [Id in PlanId]: readonly [PlanVersion, ...PlanVersion[]];
};
export const PLAN_VERSIONS: PlanVersionCatalog = {
	"desktop-license": [
		{ version: 1, monthlyPriceMicroUsd: 0, monthlyCreditPoolMicroUsd: 0 },
		{ version: 2, monthlyPriceMicroUsd: 0, monthlyCreditPoolMicroUsd: 0 },
		{ version: 3, monthlyPriceMicroUsd: 0, monthlyCreditPoolMicroUsd: 0 },
		{ version: 4, monthlyPriceMicroUsd: 0, monthlyCreditPoolMicroUsd: 0 },
		{ version: 5, monthlyPriceMicroUsd: 0, monthlyCreditPoolMicroUsd: 0 },
	],
	"marketplace-membership": [
		{
			version: 1,
			monthlyPriceMicroUsd: usdToMicro(9.99),
			monthlyCreditPoolMicroUsd: 0,
		},
		{
			version: 2,
			monthlyPriceMicroUsd: usdToMicro(9.99),
			monthlyCreditPoolMicroUsd: 0,
		},
		{
			version: 3,
			monthlyPriceMicroUsd: usdToMicro(9.99),
			monthlyCreditPoolMicroUsd: 0,
		},
		{
			version: 4,
			monthlyPriceMicroUsd: usdToMicro(9.99),
			monthlyCreditPoolMicroUsd: 0,
		},
		{
			version: 5,
			monthlyPriceMicroUsd: usdToMicro(9.99),
			monthlyCreditPoolMicroUsd: 0,
		},
		{
			// A Major Pass launch price. Earlier subscribers stay on their
			// immutable $9.99 snapshots.
			version: 6,
			monthlyPriceMicroUsd: usdToMicro(20),
			monthlyCreditPoolMicroUsd: 0,
		},
	],
	plus: [
		{
			// Never sold to a subscriber, so it takes the margin-safe $9 pool of v2
			// (its $10 pool sat at 17.15% yearly, under the 20% floor).
			version: 1,
			monthlyPriceMicroUsd: usdToMicro(39),
			monthlyCreditPoolMicroUsd: usdToMicro(9),
			creditPoolModel: "fixed",
		},
		{
			// Founder decision 2026-10-20: same $39 price, $9 pool, so the yearly
			// term clears the 20% worst-case floor with 5,000 sends and 10 GiB of
			// mail and Space storage costed.
			version: 2,
			monthlyPriceMicroUsd: usdToMicro(39),
			monthlyCreditPoolMicroUsd: usdToMicro(9),
			creditPoolModel: "fixed",
		},
	],
	pro: [
		{
			// Never sold to a subscriber, so it takes the margin-safe $9 pool of the
			// $39 Plus row (its $15 pool left 0.30% yearly).
			version: 1,
			monthlyPriceMicroUsd: usdToMicro(39),
			monthlyCreditPoolMicroUsd: usdToMicro(9),
		},
		{
			version: 2,
			monthlyPriceMicroUsd: usdToMicro(250),
			monthlyCreditPoolMicroUsd: usdToMicro(50),
		},
		{
			version: 3,
			monthlyPriceMicroUsd: usdToMicro(250),
			monthlyCreditPoolMicroUsd: usdToMicro(50),
		},
		{
			// Never sold to a subscriber, so it takes the margin-safe $9 pool of the
			// $39 Plus row (its $15 pool left 0.30% yearly).
			version: 4,
			monthlyPriceMicroUsd: usdToMicro(39),
			monthlyCreditPoolMicroUsd: usdToMicro(9),
		},
		{
			// Never sold to a subscriber, so it takes the margin-safe $9 pool of the
			// $39 Plus row (its $15 pool left 0.30% yearly).
			version: 5,
			monthlyPriceMicroUsd: usdToMicro(39),
			monthlyCreditPoolMicroUsd: usdToMicro(9),
		},
		{
			// The $49/$490 ladder. Never sold to a subscriber, so it takes the margin-safe
			// $14 pool of v7 (its $15 pool left 19.32% yearly).
			version: 6,
			monthlyPriceMicroUsd: usdToMicro(49),
			monthlyCreditPoolMicroUsd: usdToMicro(14),
		},
		{
			// Founder decision 2026-10-20: same $49 price, $14 pool, so the yearly
			// term clears the 20% worst-case floor with 5,000 sends and 10 GiB of
			// mail and Space storage costed.
			version: 7,
			monthlyPriceMicroUsd: usdToMicro(49),
			monthlyCreditPoolMicroUsd: usdToMicro(14),
		},
	],
	max: [
		{
			version: 1,
			monthlyPriceMicroUsd: usdToMicro(99),
			monthlyCreditPoolMicroUsd: usdToMicro(30),
		},
		{
			version: 2,
			monthlyPriceMicroUsd: usdToMicro(2500),
			monthlyCreditPoolMicroUsd: usdToMicro(250),
		},
		{
			version: 3,
			monthlyPriceMicroUsd: usdToMicro(2500),
			monthlyCreditPoolMicroUsd: usdToMicro(250),
		},
		{
			version: 4,
			monthlyPriceMicroUsd: usdToMicro(99),
			monthlyCreditPoolMicroUsd: usdToMicro(30),
		},
		{
			version: 5,
			monthlyPriceMicroUsd: usdToMicro(99),
			monthlyCreditPoolMicroUsd: usdToMicro(30),
		},
	],
	teams: [
		{
			version: 1,
			monthlyPriceMicroUsd: usdToMicro(49),
			monthlyCreditPoolMicroUsd: usdToMicro(15),
			creditPoolModel: "fixed",
		},
		{
			version: 2,
			monthlyPriceMicroUsd: usdToMicro(49),
			monthlyCreditPoolMicroUsd: usdToMicro(15),
			creditPoolModel: "fixed",
		},
		{
			version: 3,
			monthlyPriceMicroUsd: usdToMicro(49),
			monthlyCreditPoolMicroUsd: usdToMicro(15),
			creditPoolModel: "fixed",
		},
		{
			version: 4,
			monthlyPriceMicroUsd: usdToMicro(250),
			monthlyCreditPoolMicroUsd: usdToMicro(50),
			creditPoolModel: "fixed",
		},
		{
			version: 5,
			monthlyPriceMicroUsd: usdToMicro(50),
			monthlyCreditPoolMicroUsd: usdToMicro(50),
			creditPoolModel: "per_bundle",
			creditPoolBundleSize: 5,
		},
	],
	"teams-lite": [
		{
			version: 1,
			monthlyPriceMicroUsd: usdToMicro(30),
			monthlyCreditPoolMicroUsd: usdToMicro(20),
			creditPoolModel: "per_bundle",
			creditPoolBundleSize: 5,
			seatPriceTiers: TEAMS_LITE_SEAT_PRICE_TIERS,
			baseMonthlyPriceMicroUsd: usdToMicro(150),
			additionalSeatPriceMicroUsd: usdToMicro(50),
		},
	],
	business: [
		{
			// v1 originally granted a pool per STARTED five-seat bundle (6 seats
			// received $200 on a $350 month, a loss). It was never sold to a
			// subscriber, so it takes v2's completed-bundle pool instead of
			// keeping terms nobody holds.
			version: 1,
			monthlyPriceMicroUsd: usdToMicro(60),
			monthlyCreditPoolMicroUsd: usdToMicro(100),
			creditPoolModel: "per_completed_bundle",
			creditPoolBundleSize: 5,
			seatPriceTiers: BUSINESS_SEAT_PRICE_TIERS,
			baseMonthlyPriceMicroUsd: usdToMicro(300),
			additionalSeatPriceMicroUsd: usdToMicro(50),
		},
		{
			// Current Business contracts grant one pool for each COMPLETED
			// five-seat bundle: 5–9 seats receive $100, 10–14 receive $200.
			version: 2,
			monthlyPriceMicroUsd: usdToMicro(60),
			monthlyCreditPoolMicroUsd: usdToMicro(100),
			creditPoolModel: "per_completed_bundle",
			creditPoolBundleSize: 5,
			seatPriceTiers: BUSINESS_SEAT_PRICE_TIERS,
			baseMonthlyPriceMicroUsd: usdToMicro(300),
			additionalSeatPriceMicroUsd: usdToMicro(50),
		},
	],
};
