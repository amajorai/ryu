import { PLANS } from "./plan-catalog.ts";
import type { PlanId } from "./plan-core.ts";
import type { Entitlement } from "./plan-subscription.ts";

/** Plan catalog part: Gateway rate ceilings, Box concurrency and the Core limits claim. Re-exported by `plans.ts`. */

/**
 * Per-minute ceilings the hosted Gateway enforces on an organization's managed
 * traffic. Many organizations share one Gateway node, so an organization on a
 * free baseline, a desktop license, or promotional credit must not be able to
 * consume the shared provider capacity a paid plan relies on. Admin-authored
 * org caps can only narrow these ceilings, never raise them. `/gateway/resolve`
 * sends the ceiling as `planRateCeiling`, and only a Gateway that bills tenants
 * applies it: a self-hosted Gateway or an organization's own node serves its
 * own capacity and enforces the authored caps alone.
 */
export interface GatewayRateCeiling {
	readonly rpm: number;
	readonly tpm: number;
}

/** Organizations without a managed plan: free baseline, promo or prepaid credit. */
const UNMANAGED_GATEWAY_RATE_CEILING: GatewayRateCeiling = {
	rpm: 30,
	tpm: 60_000,
};

/** Ceilings per plan; per-seat plans scale by the billed seat count. */
const GATEWAY_RATE_CEILING_BY_PLAN: Record<PlanId, GatewayRateCeiling> = {
	"desktop-license": UNMANAGED_GATEWAY_RATE_CEILING,
	"marketplace-membership": UNMANAGED_GATEWAY_RATE_CEILING,
	plus: { rpm: 60, tpm: 200_000 },
	pro: { rpm: 120, tpm: 400_000 },
	max: { rpm: 300, tpm: 1_000_000 },
	"teams-lite": { rpm: 60, tpm: 200_000 },
	teams: { rpm: 120, tpm: 400_000 },
	business: { rpm: 120, tpm: 400_000 },
};

/** Upper bounds matching the org-limits store (`MAX_LIMIT_RPM` / `MAX_LIMIT_TPM`). */
const MAX_GATEWAY_RPM = 1_000_000;
const MAX_GATEWAY_TPM = 1_000_000_000;

/**
 * The hosted Gateway rate ceiling for an entitlement. `null` (the entitlement
 * could not be read) gets the unmanaged ceiling; `/gateway/resolve` passes null
 * only when it has no earlier successful read for the org to reuse.
 */
export const gatewayRateCeilingForEntitlement = (
	entitlement: Entitlement | null
): GatewayRateCeiling => {
	if (!(entitlement?.plan && entitlement.managedInference)) {
		return UNMANAGED_GATEWAY_RATE_CEILING;
	}
	const ceiling = GATEWAY_RATE_CEILING_BY_PLAN[entitlement.plan];
	const seats =
		PLANS[entitlement.plan].seatModel.kind === "per_seat"
			? Math.max(1, entitlement.seats)
			: 1;
	return {
		rpm: Math.min(ceiling.rpm * seats, MAX_GATEWAY_RPM),
		tpm: Math.min(ceiling.tpm * seats, MAX_GATEWAY_TPM),
	};
};

// The desktop trial/paywall gate, the Agent Inbox lifecycle and the lifetime
// updates window live in their own modules; re-exported so `lib/plans` stays
// the single import path for the plan catalog.

/* -------------------------------------------------------------------------- *
 * Box concurrency caps (docs/box-per-session-desktop.md §8.1)
 * -------------------------------------------------------------------------- */

/**
 * How many Ryu Boxes one organization may run and keep stored at once, by plan
 * (founder sign-off 2026-10-20, design §18 question 2).
 *
 * The control plane signs them into the org's `rbx1` Box tenant token, where
 * the Box service enforces them, and into Core's `ryu_limits` JWT claim, where
 * Core uses them for UX and early refusal.
 *
 *  - `running` counts Boxes that are provisioning, ready, running or stopping.
 *    It is one number for the whole organization, whatever its seat count.
 *  - `stored` counts stopped Boxes. A `storedPerSeat` row multiplies it by the
 *    plan's seat count.
 *  - `trial` is the row for an org with no paid managed plan (design §8.1:
 *    the credit-only baseline is the trial row, 1 running Box), and for plans
 *    that carry no managed capacity (the desktop license and A Major Pass).
 *    A paid plan whose subscription is still `trialing` also gets it, with
 *    the trial storage (10 GiB, nothing sold beyond it), until it converts.
 */
export const PLAN_BOX_CONCURRENCY = Object.freeze({
	trial: { running: 1, stored: 3, storedPerSeat: false },
	plus: { running: 2, stored: 10, storedPerSeat: false },
	pro: { running: 2, stored: 20, storedPerSeat: false },
	max: { running: 4, stored: 40, storedPerSeat: false },
	"teams-lite": { running: 10, stored: 10, storedPerSeat: true },
	teams: { running: 10, stored: 20, storedPerSeat: true },
	business: { running: 20, stored: 20, storedPerSeat: true },
} as const satisfies Record<
	string,
	{ running: number; stored: number; storedPerSeat: boolean }
>);

/** A row of {@link PLAN_BOX_CONCURRENCY}. */
export type BoxConcurrencyTier = keyof typeof PLAN_BOX_CONCURRENCY;

/** One org's Box admission caps, as the tenant token carries them. */
export interface BoxConcurrencyLimits {
	/** Always `2 × maxRunning` (design §8.1). */
	maxResourceUnits: number;
	maxRunning: number;
	/**
	 * The most Box storage (saved state plus named snapshots) the tenant may
	 * hold, in GiB. Set only on the trial row, where storage beyond the
	 * included amount is not available; absent, storage above the included
	 * amount is sold.
	 */
	maxStorageGib?: number;
	maxStored: number;
}

/**
 * The largest cap a Box tenant token may carry (`apps/box/src/tenants.ts`
 * refuses a larger claim as malformed). Resource units are twice the running
 * cap, so running is bounded at half of it.
 */
export const BOX_CONCURRENCY_CLAIM_MAX = 100_000;

const BOX_TIER_BY_PLAN = {
	"desktop-license": "trial",
	"marketplace-membership": "trial",
	plus: "plus",
	pro: "pro",
	max: "max",
	teams: "teams",
	"teams-lite": "teams-lite",
	business: "business",
} as const satisfies Record<PlanId, BoxConcurrencyTier>;

/**
 * The concurrency row for a plan; `null` (no plan) is the trial row, and so
 * is any plan while its subscription is still in its free trial
 * (`trialing`), until it converts.
 */
export function boxConcurrencyTier(
	plan: PlanId | null,
	trialing = false
): BoxConcurrencyTier {
	return plan && !trialing ? BOX_TIER_BY_PLAN[plan] : "trial";
}

/**
 * The Box caps for an org on `plan` with `seats` billed seats. The running
 * cap is the plan's, whatever the seats. A per-seat stored cap with no
 * reported seats counts one seat, so a seat lookup that failed never yields a
 * zero cap that would refuse every stop.
 */
export function boxConcurrencyFor(
	plan: PlanId | null,
	seats: number,
	trialing = false
): BoxConcurrencyLimits {
	const tier = boxConcurrencyTier(plan, trialing);
	const row: { running: number; stored: number; storedPerSeat: boolean } =
		PLAN_BOX_CONCURRENCY[tier];
	const seatCount =
		row.storedPerSeat && Number.isSafeInteger(seats) && seats > 0 ? seats : 1;
	const maxRunning = Math.min(
		row.running,
		Math.floor(BOX_CONCURRENCY_CLAIM_MAX / 2)
	);
	const maxStored = Math.min(row.stored * seatCount, BOX_CONCURRENCY_CLAIM_MAX);
	return {
		maxResourceUnits: 2 * maxRunning,
		maxRunning,
		maxStored,
		...(tier === "trial"
			? { maxStorageGib: BOX_INCLUDED_STORAGE_GIB.trial }
			: {}),
	};
}

/** The Box caps an entitlement grants. */
export function boxConcurrencyForEntitlement(
	entitlement: Pick<Entitlement, "plan" | "seats" | "trialing">
): BoxConcurrencyLimits {
	return boxConcurrencyFor(
		entitlement.plan,
		entitlement.seats,
		entitlement.trialing === true
	);
}

/* -------------------------------------------------------------------------- *
 * The signed `ryu_limits` Core claim
 * -------------------------------------------------------------------------- */

/**
 * JWT claim Better Auth's `definePayload` (`../index.ts`) adds beside
 * `ryu_flags`: `{ boxConcurrency }`, the running-Box cap of the org the flags
 * were evaluated for. Core parses it into `VerifiedLimits` and refuses a new
 * session Box early when the owner is at the cap; the Box service enforces the
 * same cap from the tenant token whatever Core does. A missing claim means
 * "unknown", and Core falls through to the Box service's own limits.
 */
export const CORE_LIMITS_CLAIM = "ryu_limits" as const;

/** The claim's value. */
export interface CoreLimitsClaim {
	boxConcurrency: number;
}

/**
 * The plan of an org, as `@ryu/api` resolves it. Registered at boot because
 * the resolver lives in `@ryu/api`, which depends on this package (the same
 * reason `registerCoreFlagClaimResolver` exists).
 */
export type CoreLimitsPlanResolver = (
	organizationId: string
) => Promise<Pick<Entitlement, "plan" | "seats" | "trialing">>;

let coreLimitsPlanResolver: CoreLimitsPlanResolver | null = null;

/** Install the plan resolver for the `ryu_limits` claim. Single slot, last wins. */
export function registerCoreLimitsPlanResolver(
	implementation: CoreLimitsPlanResolver | null
): void {
	coreLimitsPlanResolver = implementation;
}

const CORE_LIMITS_TIMEOUT_MS = 2000;
const CORE_LIMITS_TIMED_OUT = Symbol("core-limits-claim-timeout");

/**
 * The `ryu_limits` claim for `organizationId`, or null when there is no org,
 * no registered resolver, or the plan could not be read in time. NEVER THROWS
 * AND NEVER REJECTS: its caller mints every token, so a failure omits the
 * claim rather than delaying or failing sign-in.
 */
export async function resolveCoreLimitsClaim(
	organizationId: string | null,
	timeoutMs: number = CORE_LIMITS_TIMEOUT_MS
): Promise<CoreLimitsClaim | null> {
	const implementation = coreLimitsPlanResolver;
	if (!(organizationId && implementation)) {
		return null;
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const entitlement = await Promise.race([
			implementation(organizationId),
			new Promise<typeof CORE_LIMITS_TIMED_OUT>((resolve) => {
				timer = setTimeout(() => resolve(CORE_LIMITS_TIMED_OUT), timeoutMs);
			}),
		]);
		if (entitlement === CORE_LIMITS_TIMED_OUT) {
			console.error("[auth] core limits claim: plan lookup timed out");
			return null;
		}
		return {
			boxConcurrency: boxConcurrencyForEntitlement(entitlement).maxRunning,
		};
	} catch (error) {
		console.error("[auth] core limits claim: plan lookup failed:", error);
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** Add the claim to a JWT payload; a null claim leaves the payload unchanged. */
export function withCoreLimitsClaim<T extends object>(
	payload: T,
	claim: CoreLimitsClaim | null
): T & { [CORE_LIMITS_CLAIM]?: CoreLimitsClaim } {
	if (!claim) {
		return payload;
	}
	return {
		...payload,
		[CORE_LIMITS_CLAIM]: { boxConcurrency: claim.boxConcurrency },
	};
}

/** Box state and snapshot storage: $0.05 per GiB-month (30 days). */
export const BOX_STORAGE_MICRO_USD_PER_GIB_MONTH = 50_000;

/**
 * Box storage (saved state plus named snapshots) each organization stores
 * without charge, in GiB (docs/box-cloud-plan.md §8.2): 10 GiB without a paid
 * managed plan, 25 GiB on one. Storage above it is charged at
 * {@link BOX_STORAGE_MICRO_USD_PER_GIB_MONTH} for as long as it is stored.
 */
export const BOX_INCLUDED_STORAGE_GIB = Object.freeze({
	trial: 10,
	paid: 25,
} as const);

/**
 * The included Box storage of an org on `plan`. The plans without managed
 * capacity (the desktop license and A Major Pass), no plan, and a paid plan
 * still in its free trial get the trial allowance, as they get the trial
 * concurrency row.
 */
export function boxIncludedStorageGib(
	plan: PlanId | null,
	trialing = false
): number {
	return boxConcurrencyTier(plan, trialing) === "trial"
		? BOX_INCLUDED_STORAGE_GIB.trial
		: BOX_INCLUDED_STORAGE_GIB.paid;
}

/** How an org's Box storage (saved state and named snapshots) is sold. */
export interface BoxStoragePolicy {
	/**
	 * Whether storage above the included amount is sold, at
	 * {@link BOX_STORAGE_MICRO_USD_PER_GIB_MONTH}. False on the trial row:
	 * storage beyond the included 10 GiB is not available (the Box service
	 * refuses new Boxes, resumes and snapshots past it), so nothing above it
	 * is charged.
	 */
	beyondIncluded: boolean;
	includedGib: number;
}

/** The Box storage policy of an entitlement (docs/box-cloud-plan.md §8.2). */
export function boxStoragePolicyFor(
	entitlement: Pick<Entitlement, "plan" | "trialing">
): BoxStoragePolicy {
	const trial =
		boxConcurrencyTier(entitlement.plan, entitlement.trialing === true) ===
		"trial";
	return {
		beyondIncluded: !trial,
		includedGib: trial
			? BOX_INCLUDED_STORAGE_GIB.trial
			: BOX_INCLUDED_STORAGE_GIB.paid,
	};
}
