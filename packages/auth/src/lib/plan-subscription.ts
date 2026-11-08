import { z } from "zod";
import { ALL_PLANS, PLANS } from "./plan-catalog.ts";
import {
	type BillingInterval,
	PLAN_IDS,
	type Plan,
	type PlanId,
	type PolarBinding,
	resolveProductId,
} from "./plan-core.ts";
import {
	type PlanVariant,
	type PlanVariantCell,
	parseCellKey,
} from "./plan-variants.ts";
import {
	PLAN_VERSIONS,
	type PlanVersion,
	type PlanVersionCatalog,
} from "./plan-version-catalog.ts";
import {
	LEGACY_SHARED_PRODUCT_MAX_VERSION,
	monthlyCreditPoolMicroUsdForSeats,
	planVersionFor,
	planVersionInputSchema,
	rowRegions,
	rowVariant,
} from "./plan-version-rows.ts";

/** Plan catalog part: Polar product resolution, subscription rows and entitlements. Re-exported by `plans.ts`. */

const billingIntervalSchema = z.enum(["one_time", "monthly", "yearly"]);

/** The Polar product a row sells on for `interval`, or null when it sells none. */
export const bindingFor = (
	plan: PlanId,
	row: PlanVersion,
	interval: BillingInterval
): PolarBinding | null => {
	const own = row.bindings?.[interval];
	if (own) {
		return own;
	}
	if (row.version <= LEGACY_SHARED_PRODUCT_MAX_VERSION[plan]) {
		return PLANS[plan].bindings[interval] ?? null;
	}
	return null;
};

/**
 * What a Polar product id sells. `kind: "row"` is a product one version row
 * owns (authoritative); `kind: "legacy"` is a plan-level product shared by
 * every row up to {@link LEGACY_SHARED_PRODUCT_MAX_VERSION}, told apart by the
 * `planVersion` checkout stamp.
 */
export interface ProductIndexEntry {
	readonly interval: BillingInterval;
	readonly kind: "row" | "legacy";
	readonly plan: Plan;
	readonly rows: readonly PlanVersion[];
}

/** Index every product id the catalog sells (env-aware; re-read per call). */
export const planProductIndex = (
	read: (key: string) => string | undefined = (k) => process.env[k],
	versions: PlanVersionCatalog = PLAN_VERSIONS
): Map<string, ProductIndexEntry> => {
	const index = new Map<string, ProductIndexEntry>();
	for (const plan of ALL_PLANS) {
		const legacyRows = versions[plan.id].filter(
			(row) => row.version <= LEGACY_SHARED_PRODUCT_MAX_VERSION[plan.id]
		);
		for (const [interval, binding] of Object.entries(plan.bindings)) {
			index.set(resolveProductId(binding, read), {
				interval: billingIntervalSchema.parse(interval),
				kind: "legacy",
				plan,
				rows: legacyRows,
			});
		}
		for (const row of versions[plan.id]) {
			for (const [interval, binding] of Object.entries(row.bindings ?? {})) {
				index.set(resolveProductId(binding, read), {
					interval: billingIntervalSchema.parse(interval),
					kind: "row",
					plan,
					rows: [row],
				});
			}
		}
	}
	return index;
};

/**
 * Index from Polar product id → { plan, interval }. Built lazily from the
 * resolved (env-aware) ids so a subscription's `productId` can be mapped to a
 * plan. Re-reads env on each call so test/process env changes are honoured.
 * Includes the products a version row owns.
 */
export const planByProductId = (
	read: (key: string) => string | undefined = (k) => process.env[k]
): Map<string, { plan: Plan; interval: BillingInterval }> => {
	const index = new Map<string, { plan: Plan; interval: BillingInterval }>();
	for (const [productId, entry] of planProductIndex(read)) {
		index.set(productId, { plan: entry.plan, interval: entry.interval });
	}
	return index;
};

const PLAN_STAMP_INTERVAL_SUFFIX = /-(monthly|yearly|one_time)$/;

/**
 * The plan a checkout's `metadata.plan` stamp names. Checkout stamps the
 * product SLUG (`pro-monthly`, `teams-yearly`) and onboarding stamps the bare
 * plan id, so both forms resolve; anything else is no stamp at all.
 */
export const planIdFromStamp = (stamp: unknown): PlanId | null => {
	if (typeof stamp !== "string") {
		return null;
	}
	const raw = stamp.trim().toLowerCase();
	const bare = raw.replace(PLAN_STAMP_INTERVAL_SUFFIX, "");
	return PLAN_IDS.find((id) => id === raw || id === bare) ?? null;
};

/** How {@link resolveSubscriptionRow} chose a row. */
export type ResolveSource =
	| "product"
	| "metadata"
	| "foreign_stamp"
	| "fallback";

/** The version row one subscription is billed and entitled against. */
export interface ResolvedPlanRow {
	readonly cell: PlanVariantCell | null;
	readonly interval: BillingInterval;
	readonly plan: Plan;
	readonly row: PlanVersion;
	readonly source: ResolveSource;
	readonly variant: PlanVariant;
}

/** The subscription facts the row resolver reads. */
export interface SubscriptionRowInput {
	/** Stamped `metadata.plan`, when the checkout wrote one. */
	readonly planStamp?: string | null;
	/** Stamped `metadata.planVersion`. */
	readonly planVersion?: z.input<typeof planVersionInputSchema>;
	readonly productId?: string | null;
	/** Stamped `metadata.variant` (a cell key). */
	readonly variantStamp?: unknown;
}

/**
 * THE ONE SEAM that maps a subscription to its version row.
 *
 *  1. Unknown product: null (no entitlement, as before).
 *  2. A product a row owns: that row, whatever the metadata says. This is what
 *     makes a price migration work: Polar cannot re-stamp metadata, but the
 *     product changes, and the product is authoritative.
 *  3. A shared (legacy) product: the stamped version when it is one of that
 *     product's rows. A stamp from ANOTHER plan (the customer changed plan
 *     onto this product and kept their first plan's stamp) resolves to the
 *     newest legacy row and is reported as `foreign_stamp`, so a migration can
 *     refuse to act on a guessed row. Anything else falls back to the OLDEST
 *     row, exactly like {@link planVersionFor}.
 *
 * When no plan stamp is passed the result equals `planVersionFor(plan,
 * planVersion)` for every shared product (proven by test), so callers that do
 * not read the stamp keep today's behaviour.
 */
export const resolveSubscriptionRow = (
	sub: SubscriptionRowInput,
	read: (key: string) => string | undefined = (k) => process.env[k],
	versions: PlanVersionCatalog = PLAN_VERSIONS
): ResolvedPlanRow | null => {
	const productId = sub.productId ?? null;
	if (!productId) {
		return null;
	}
	const entry = planProductIndex(read, versions).get(productId);
	if (!entry) {
		return null;
	}
	let row: PlanVersion;
	let source: ResolveSource;
	const [ownRow] = entry.rows;
	if (entry.kind === "row" && ownRow) {
		row = ownRow;
		source = "product";
	} else {
		const stampPlan = planIdFromStamp(sub.planStamp);
		const wanted = planVersionInputSchema.parse(sub.planVersion);
		const stamped = entry.rows.find(
			(candidate) => candidate.version === wanted
		);
		const newest = entry.rows.at(-1);
		const oldest = entry.rows[0];
		if (stampPlan && stampPlan !== entry.plan.id && newest) {
			row = newest;
			source = "foreign_stamp";
		} else if (stamped) {
			row = stamped;
			source = "metadata";
		} else {
			// Restricted to this product's own rows: an unknown stamp never
			// resolves to a row sold on a different product.
			row = oldest ?? planVersionFor(entry.plan.id, sub.planVersion);
			source = "fallback";
		}
	}
	const variant = rowVariant(row);
	const stampedCell = parseCellKey(sub.variantStamp);
	const cell =
		stampedCell &&
		stampedCell.provider === variant.provider &&
		stampedCell.capacity === variant.capacity &&
		rowRegions(row).includes(stampedCell.region)
			? stampedCell
			: null;
	return {
		cell,
		interval: entry.interval,
		plan: entry.plan,
		row,
		source,
		variant,
	};
};

/**
 * A minimal, transport-agnostic view of a Polar subscription. Mirrors the
 * fields the billing router already reads off the Polar SDK object; kept loose
 * so callers don't need the full SDK type.
 */
export interface SubscriptionView {
	/**
	 * The plan stamped into SERVER-SET checkout metadata (`metadata.plan`). A
	 * plan change swaps only the Polar product and keeps the first plan's
	 * metadata, so this is what tells {@link resolveSubscriptionRow} that the
	 * `planVersion` stamp belongs to ANOTHER plan and must not pick a row.
	 */
	readonly planStamp?: string | null;
	/**
	 * The plan version stamped into SERVER-SET checkout metadata at purchase
	 * (`planVersion`). Absent on every subscription created before versioning
	 * existed, which {@link planVersionFor} resolves to v1 — the correct answer
	 * for them, since they are the oldest customers on the oldest prices.
	 */
	readonly planVersion?: z.input<typeof planVersionInputSchema>;
	/** The Polar product id the subscription is for. */
	readonly productId?: string | null;
	readonly quantity?: number | null;
	/** Seat count for per-seat (Teams/Business) subscriptions, when present. */
	readonly seats?: number | null;
	/** Polar status, e.g. "active" | "trialing" | "canceled". */
	readonly status?: string | null;
}

/**
 * A minimal view of a desktop license entitlement (the Polar license-key
 * benefit). `active` is the resolved validity (not expired / not revoked).
 */
export interface LicenseView {
	readonly active?: boolean | null;
	readonly productId?: string | null;
}

/** What a user is entitled to, resolved from their subscription + license. */
export interface Entitlement {
	readonly desktopAccess: boolean;
	readonly managedInference: boolean;
	/** Whether the resolved plan unlocks supported paid Marketplace apps. */
	readonly marketplaceApps: boolean;
	/** Total included credit pool after the plan's fixed/per-seat model is applied. */
	readonly monthlyCreditPoolMicroUsd: number;
	/** The effective plan, or null when un-entitled (free baseline). */
	readonly plan: PlanId | null;
	/** Effective seat count (1 for single plans). */
	readonly seats: number;
	/**
	 * The subscription is in its free trial (Polar `trialing`). It has the
	 * plan's features, but Box capacity and storage stay on the trial row
	 * (1 running Box, 10 GiB of storage) until it converts: a free trial is not
	 * a paid managed plan. Absent when false.
	 */
	readonly trialing?: boolean;
}

/**
 * Number of external channel users an entitlement may configure for hosted bots.
 * Only managed-inference plans may use hosted bots. Personal managed plans
 * resolve to one seat; Teams, Teams Lite, and Business resolve to the billed seat count.
 * A Major Pass has Marketplace access only and therefore has no allowance.
 */
export const channelUserLimitForEntitlement = (
	entitlement: Entitlement
): number =>
	entitlement.managedInference && entitlement.plan ? entitlement.seats : 0;

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"]);

const isActiveSubscription = (sub: SubscriptionView): boolean =>
	ACTIVE_SUBSCRIPTION_STATUSES.has((sub.status ?? "").toLowerCase());

const seatsFor = (plan: Plan, sub: SubscriptionView): number => {
	if (plan.seatModel.kind === "single") {
		return 1;
	}
	const requested = sub.seats ?? sub.quantity ?? plan.seatModel.minSeats;
	return Math.max(requested, plan.seatModel.minSeats);
};

const ENTITLEMENT_NONE: Entitlement = {
	plan: null,
	desktopAccess: false,
	marketplaceApps: false,
	managedInference: false,
	monthlyCreditPoolMicroUsd: 0,
	seats: 0,
};

/**
 * Resolve a user's entitlement from their active Polar subscription and/or a
 * desktop license. An active subscription (including the apps-only A Major Pass)
 * takes precedence over a license; managed plans additionally grant inference,
 * while A Major Pass grants Marketplace access only. A desktop license alone
 * grants desktop access with no credit pool. Returns the un-entitled baseline
 * when neither is present/active.
 *
 * Pure and env-injectable: pass `read` to map product ids without touching
 * `process.env` (used by the tests).
 */
export const resolveEntitlement = (
	subscription: SubscriptionView | null | undefined,
	license: LicenseView | null | undefined,
	read: (key: string) => string | undefined = (k) => process.env[k]
): Entitlement => {
	const index = planByProductId(read);

	// 1) An active subscription wins (A Major Pass or a managed plan).
	if (subscription?.productId && isActiveSubscription(subscription)) {
		const match = index.get(subscription.productId);
		if (match) {
			const { plan } = match;
			const seats = seatsFor(plan, subscription);
			// The POOL comes from the subscription's version, never from the live
			// catalog — that is what makes a future pool increase unable to reach a
			// customer still paying an older price. A product a version row owns
			// (a migrated subscription) resolves to that row through the product.
			const versioned =
				resolveSubscriptionRow(
					{
						planStamp: subscription.planStamp,
						productId: subscription.productId,
						planVersion: subscription.planVersion,
					},
					read
				)?.row ?? planVersionFor(plan.id, subscription.planVersion);
			const pool = monthlyCreditPoolMicroUsdForSeats({
				plan,
				seats,
				version: versioned,
			});
			const trialing = (subscription.status ?? "").toLowerCase() === "trialing";
			return {
				plan: plan.id,
				desktopAccess: plan.desktopAccess,
				marketplaceApps: plan.marketplaceApps,
				managedInference: plan.managedInference,
				monthlyCreditPoolMicroUsd: pool,
				seats,
				...(trialing ? { trialing: true } : {}),
			};
		}
	}

	// 2) Fall back to a desktop license (one-time purchase, no managed pool).
	if (license?.active) {
		const desktop = PLANS["desktop-license"];
		return {
			plan: desktop.id,
			desktopAccess: desktop.desktopAccess,
			marketplaceApps: desktop.marketplaceApps,
			managedInference: desktop.managedInference,
			monthlyCreditPoolMicroUsd: desktop.monthlyCreditPoolMicroUsd,
			seats: 1,
		};
	}

	// 3) No entitlement.
	return ENTITLEMENT_NONE;
};

/**
 * Whether managed inference is available now: an active subscription with
 * included credits OR any positive prepaid wallet balance. A balance is the
 * paid standalone entitlement, so no managed plan, desktop license, or Ryu
 * cloud node is required. Requests still pass the existing pool and spend gates.
 */
export const managedInferenceAvailable = (
	entitlement: Entitlement,
	balanceMicroUsd: number
): boolean => entitlement.managedInference || balanceMicroUsd > 0;
