import { PLANS } from "./plan-catalog.ts";
import type { PlanId } from "./plan-core.ts";
import { planLimit } from "./plan-quotas.ts";
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
 * `ryu_flags`: `{ boxConcurrency, accountsPerProvider }`. Each number is left
 * out when it could not be read.
 *
 *  - `boxConcurrency` is the running-Box cap of the org the flags were
 *    evaluated for. Core parses it into `VerifiedLimits` and refuses a new
 *    session Box early when the owner is at the cap; the Box service enforces
 *    the same cap from the tenant token whatever Core does. Missing means
 *    "unknown", and Core falls through to the Box service's own limits.
 *  - `accountsPerProvider` is how many accounts (sign-ins or keys) one
 *    provider may hold on a node this user is signed in to:
 *    `planLimit(plan, "maxAccountsPerProvider")`. Core reads it in
 *    `apps/core/src/server/access_gate/plan_limits.rs`. Missing means Core keeps the number of
 *    the user's last token for a short while, then applies the free number.
 */
export const CORE_LIMITS_CLAIM = "ryu_limits" as const;

/** The claim's value. */
export interface CoreLimitsClaim {
	accountsPerProvider?: number;
	boxConcurrency?: number;
}

/**
 * The plan of an org, as `@ryu/api` resolves it. Registered at boot because
 * the resolver lives in `@ryu/api`, which depends on this package (the same
 * reason `registerCoreFlagClaimResolver` exists).
 */
export type CoreLimitsPlanResolver = (
	organizationId: string
) => Promise<Pick<Entitlement, "plan" | "seats" | "trialing">>;

/**
 * A person's own plan, as `@ryu/api` resolves it: an individual plan or the
 * one-time desktop license. Both are bought by the person, so an org's
 * entitlement does not carry them. It must REJECT when billing cannot be read:
 * a null plan means "free" and lowers the account limit.
 */
export type CoreLimitsUserPlanResolver = (
	userId: string
) => Promise<PlanId | null>;

let coreLimitsPlanResolver: CoreLimitsPlanResolver | null = null;
let coreLimitsUserPlanResolver: CoreLimitsUserPlanResolver | null = null;

/** Install the plan resolver for the `ryu_limits` claim. Single slot, last wins. */
export function registerCoreLimitsPlanResolver(
	implementation: CoreLimitsPlanResolver | null
): void {
	coreLimitsPlanResolver = implementation;
}

/** Install the resolver of a person's own plan. Single slot, last wins. */
export function registerCoreLimitsUserPlanResolver(
	implementation: CoreLimitsUserPlanResolver | null
): void {
	coreLimitsUserPlanResolver = implementation;
}

const CORE_LIMITS_TIMEOUT_MS = 2000;
/** A plan lookup that does not apply, failed or ran out of time. */
const CORE_LIMITS_UNKNOWN = Symbol("core-limits-claim-unknown");
type CoreLimitsUnknown = typeof CORE_LIMITS_UNKNOWN;

/** Run one plan lookup. Never throws and never rejects. */
async function coreLimitsLookup<T>(
	lookup: (() => Promise<T>) | null,
	timeoutMs: number
): Promise<T | CoreLimitsUnknown> {
	if (!lookup) {
		return CORE_LIMITS_UNKNOWN;
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			lookup(),
			new Promise<CoreLimitsUnknown>((resolve) => {
				timer = setTimeout(() => {
					console.error("[auth] core limits claim: plan lookup timed out");
					resolve(CORE_LIMITS_UNKNOWN);
				}, timeoutMs);
			}),
		]);
	} catch (error) {
		console.error("[auth] core limits claim: plan lookup failed:", error);
		return CORE_LIMITS_UNKNOWN;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * The account limit of the plans that were read: the highest one, so a member
 * of a paid org and a person with their own plan or license both get the paid
 * number. `undefined` when no plan was read, and when a number cannot be
 * signed (a plan with no row in `KERNEL_QUOTAS` is unbounded).
 */
function accountsPerProviderFor(
	plans: readonly (PlanId | null)[]
): number | undefined {
	if (plans.length === 0) {
		return;
	}
	const limit = Math.max(
		...plans.map((plan) => planLimit(plan, "maxAccountsPerProvider"))
	);
	return Number.isSafeInteger(limit) && limit > 0 ? limit : undefined;
}

/**
 * The `ryu_limits` claim for a token of `userId` whose flags were evaluated
 * for `organizationId`, or null when nothing could be read. NEVER THROWS AND
 * NEVER REJECTS: its caller mints every token, so a failure omits a number
 * rather than delaying or failing sign-in.
 *
 * `boxConcurrency` needs the org and its resolver. `accountsPerProvider` reads
 * the org's plan and the person's own plan, and is left out when a lookup that
 * applies failed, so a billing outage never signs the free number for a paying
 * user.
 */
export async function resolveCoreLimitsClaim(
	organizationId: string | null,
	timeoutMs: number = CORE_LIMITS_TIMEOUT_MS,
	userId: string | null = null
): Promise<CoreLimitsClaim | null> {
	const orgResolver = coreLimitsPlanResolver;
	const userResolver = coreLimitsUserPlanResolver;
	const orgLookup =
		organizationId && orgResolver ? () => orgResolver(organizationId) : null;
	const userLookup = userId && userResolver ? () => userResolver(userId) : null;
	const [entitlement, userPlan] = await Promise.all([
		coreLimitsLookup(orgLookup, timeoutMs),
		coreLimitsLookup(userLookup, timeoutMs),
	]);
	const claim: CoreLimitsClaim = {};
	const plans: (PlanId | null)[] = [];
	if (entitlement !== CORE_LIMITS_UNKNOWN) {
		claim.boxConcurrency = boxConcurrencyForEntitlement(entitlement).maxRunning;
		plans.push(entitlement.plan);
	}
	if (userPlan !== CORE_LIMITS_UNKNOWN) {
		plans.push(userPlan);
	}
	const everyLookupAnswered =
		(orgLookup === null || entitlement !== CORE_LIMITS_UNKNOWN) &&
		(userLookup === null || userPlan !== CORE_LIMITS_UNKNOWN);
	const accountsPerProvider = everyLookupAnswered
		? accountsPerProviderFor(plans)
		: undefined;
	if (accountsPerProvider !== undefined) {
		claim.accountsPerProvider = accountsPerProvider;
	}
	return Object.keys(claim).length > 0 ? claim : null;
}

/** Add the claim to a JWT payload; a null claim leaves the payload unchanged. */
export function withCoreLimitsClaim<T extends object>(
	payload: T,
	claim: CoreLimitsClaim | null
): T & { [CORE_LIMITS_CLAIM]?: CoreLimitsClaim } {
	if (!claim) {
		return payload;
	}
	const { accountsPerProvider, boxConcurrency } = claim;
	return {
		...payload,
		[CORE_LIMITS_CLAIM]: {
			...(accountsPerProvider === undefined ? {} : { accountsPerProvider }),
			...(boxConcurrency === undefined ? {} : { boxConcurrency }),
		},
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
