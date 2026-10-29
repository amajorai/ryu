import type { PlanId } from "./plans.ts";

/**
 * WHICH PLANS INCLUDE THE FREE BASE CLOUD NODE — the single source of truth.
 *
 * The included plan node is sized by the active recurring plan. The node is NOT included with
 * the one-time `desktop-license` (Lifetime), which grants no managed inference,
 * no credit pool and no cloud node, and obviously not with the free baseline.
 * There is no separate Polar product for it — holding a qualifying subscription
 * is what grants it; any larger instance is an ad-hoc paid cloud-instance
 * subscription on top.
 *
 * This replaces the old `MAX_INCLUDES_BASE_CLOUD` boolean in `plans.ts`, which
 * was never referenced by anything: the entitlement gate in the servers router
 * and the auto-provision gate in the Polar webhook each hardcoded the literal
 * `"max"` independently, so the two could (and did) drift silently — a customer
 * is the only one who ever sees "the webhook provisioned a node the dashboard
 * refuses to re-create". Both now route through {@link planIncludesBaseNode},
 * and every user-visible string names the tiers through
 * {@link BASE_NODE_PLANS_LABEL} rather than spelling out one plan.
 *
 * DELIBERATELY A SIBLING MODULE, not part of `plans.ts`. The public pricing page
 * and the org dashboard are `"use client"` React trees; importing `plans.ts`
 * from them would ship the whole control-plane catalog (every Polar product id
 * and env-var name) to the browser to read one predicate. The only import here
 * is a TYPE, which is erased at compile time — keep it that way.
 */
export const PLANS_INCLUDING_BASE_NODE: readonly PlanId[] = [
	"pro",
	"plus",
	"max",
	"teams",
	"teams-lite",
	"business",
];

/**
 * Whether a resolved plan grants the free base cloud node. A null plan (the
 * un-entitled free baseline) never does. Single predicate for BOTH gates — the
 * manual provision gate (`assertEntitledForInstance`) and the auto-provision
 * gate in the Polar webhook — so a tier can never be entitled on one path and
 * refused on the other.
 */
export const planIncludesBaseNode = (
	plan: PlanId | null | undefined
): boolean => Boolean(plan && PLANS_INCLUDING_BASE_NODE.includes(plan));

/**
 * The Hetzner type each plan's FREE node is provisioned at: ONE BASE SERVER.
 *
 * Founder decision of 2026-10-19: every plan includes the same always-on base
 * server, the cost-optimized `cx23`, at any seat count. The included node is a
 * home for the org's agents, not where heavy or parallel work runs: that goes
 * to Ryu Boxes, paid from credits. One shape for every plan is also what lets a
 * sold-out larger type stop mattering: there is only one type to find.
 *
 * Plans used to step up (Max `cx33`, Teams `cx43`, Business `cx53`). Servers
 * created on that ladder are GRANDFATHERED, never resized by a renewal, a seat
 * change or a plan upgrade; see {@link LEGACY_BASE_NODE_TYPE_BY_PLAN}.
 */
export const BASE_NODE_TYPE_BY_PLAN = {
	pro: "cx23",
	plus: "cx23",
	max: "cx23",
	teams: "cx23",
	"teams-lite": "cx23",
	business: "cx23",
};

/**
 * The same-price stock fallback for the ORGANIZATION plans in the EU.
 *
 * `cpx22` is NOT an upgrade: it has the same 2 vCPU and 4 GB as `cx23` and
 * costs Ryu roughly three times as much (Hetzner's June 2026 repricing took it
 * from €7.99 to €19.49). It exists only so that a Teams, Teams Lite or Business
 * buyer still gets a server when `cx23` is out of stock in every EU region, at
 * the same price. The margin guard costs those plans on `cpx22` (the worst
 * case), and their seat revenue absorbs it. Plus, Pro and Max cannot, so they
 * are sold out instead.
 *
 * The node keeps whichever type it was created on: it is never moved between
 * `cx23` and `cpx22` later.
 */
export const ORG_PLAN_STOCK_FALLBACK_NODE_TYPE = "cpx22";

const ORG_PLANS_WITH_STOCK_FALLBACK: readonly PlanId[] = [
	"teams",
	"teams-lite",
	"business",
];

/**
 * The type that may stand in for a plan's base node when the base type is out
 * of stock in every region the node may go, or null when the plan has none (it
 * is sold out instead). EU only: Singapore has its own single type per plan.
 */
export const stockFallbackNodeTypeForPlanAtLocation = (
	plan: PlanId | null | undefined,
	location: string | null | undefined
): string | null => {
	if (!(plan && ORG_PLANS_WITH_STOCK_FALLBACK.includes(plan))) {
		return null;
	}
	if (location?.trim().toLowerCase() === "sin") {
		return null;
	}
	return ORG_PLAN_STOCK_FALLBACK_NODE_TYPE;
};

/**
 * Singapore's catalog does not offer the EU `cx23`, and its available shapes are
 * materially more expensive than the EU defaults. The organization plans have
 * enough seat margin to include `cpx22` there. Plus, Pro and Max do not: their
 * global prices cannot safely absorb a Singapore node on the annual term, so
 * those customers can still choose Singapore through a priced cloud-instance
 * add-on but are not promised a free regional node.
 */
export const BASE_NODE_TYPE_BY_PLAN_IN_SINGAPORE = {
	teams: "cpx22",
	"teams-lite": "cpx22",
	business: "cpx22",
};

/**
 * FROZEN: the included types plans provisioned before the 2026-10-19 one-base-
 * server decision. Never read it to size a new node.
 *
 * It answers one question about a GRANDFATHERED node: is it larger than the plan
 * it is now on would ever have given it? A Business node is `cx53` because it was
 * provisioned for Business, so a Business renewal must leave it alone, while a
 * change to Pro (whose node was `cx23`) is a downgrade. The subscription event
 * does not say which plan came before, but the node's own legacy size does. See
 * `includedNodeResizeOnPlanChange` in the API's `plan-node-downgrade.ts`.
 */
export const LEGACY_BASE_NODE_TYPE_BY_PLAN = {
	pro: "cx23",
	plus: "cx23",
	max: "cx33",
	teams: "cx43",
	"teams-lite": "cx43",
	business: "cx53",
};

/** {@link LEGACY_BASE_NODE_TYPE_BY_PLAN} for Singapore (Business was `cpx32`). */
export const LEGACY_BASE_NODE_TYPE_BY_PLAN_IN_SINGAPORE = {
	teams: "cpx22",
	"teams-lite": "cpx22",
	business: "cpx32",
};

/** The seat count at which the legacy Teams ladder granted a second node. */
export const LEGACY_TEAMS_SECOND_NODE_MIN_SEATS = 50;

/**
 * The type a plan's included node used to be provisioned at in `location`, or
 * null when the plan included none there. FROZEN; see
 * {@link LEGACY_BASE_NODE_TYPE_BY_PLAN}.
 */
export const legacyBaseNodeTypeForPlanAtLocation = (
	plan: PlanId | null | undefined,
	location: string | null | undefined
): string | null => {
	if (!(plan && planIncludesBaseNode(plan))) {
		return null;
	}
	const table =
		location?.trim().toLowerCase() === "sin"
			? LEGACY_BASE_NODE_TYPE_BY_PLAN_IN_SINGAPORE
			: LEGACY_BASE_NODE_TYPE_BY_PLAN;
	return new Map<string, string>(Object.entries(table)).get(plan) ?? null;
};

/**
 * How many included nodes the legacy ladder granted (Teams and Teams Lite had
 * a second node from 50 seats). A node it created is kept while the org still
 * qualifies for it; it is never created any more. FROZEN.
 */
export const legacyBaseNodeCountForPlanAtLocation = (
	plan: PlanId | null | undefined,
	location: string | null | undefined,
	seats = 1
): number => {
	if (legacyBaseNodeTypeForPlanAtLocation(plan, location) === null) {
		return 0;
	}
	return (plan === "teams" || plan === "teams-lite") &&
		seats >= LEGACY_TEAMS_SECOND_NODE_MIN_SEATS
		? 2
		: 1;
};

/**
 * The type a plan's included node is provisioned at, or null when it gets none.
 * Teams and Teams Lite resolve through {@link TEAMS_NODE_TIERS}, which today is
 * one base server at every seat count.
 */
export const baseNodeTypeForPlan = (
	plan: PlanId | null | undefined,
	seats = 1
): string | null => {
	if (!(plan && planIncludesBaseNode(plan))) {
		return null;
	}
	if (plan === "teams" || plan === "teams-lite") {
		return teamsNodeTierForSeats(seats).type;
	}
	return new Map(Object.entries(BASE_NODE_TYPE_BY_PLAN)).get(plan) ?? "cx23";
};

/** Resolve the included node type for a plan in a specific Hetzner location. */
export const baseNodeTypeForPlanAtLocation = (
	plan: PlanId | null | undefined,
	location: string | null | undefined,
	seats = 1
): string | null => {
	if (!(plan && planIncludesBaseNode(plan))) {
		return null;
	}
	if (location?.trim().toLowerCase() === "sin") {
		return (
			new Map(Object.entries(BASE_NODE_TYPE_BY_PLAN_IN_SINGAPORE)).get(plan) ??
			null
		);
	}
	return baseNodeTypeForPlan(plan, seats);
};

/**
 * TEAMS COMPUTE: ONE BASE SERVER, AT EVERY SEAT COUNT.
 *
 * The ladder used to scale the node with the org (one `cx43` through 49 seats,
 * two from 50). Since 2026-10-19 the shared node is the same base server every
 * plan gets, and capacity that scales with the org is bought as Ryu Boxes from
 * credits instead: seats are licences, compute is sized separately. The tier
 * shape stays so a future band is one row here, and so the margin guard and the
 * provisioner keep resolving the node through the same function.
 *
 * REVERSIBILITY. Hetzner's `change_type` can move a server between types in
 * place, but a resize that GROWS THE DISK is permanent: such a server can never
 * be made smaller again. Every resize goes through `changeInstance` →
 * `hetznerChangeServerType` in `cloud-provision.ts`, which always passes
 * `upgrade_disk: false`, so the disk stays at the size the server was created
 * with. That is also why a grandfathered node can only be shrunk back to the
 * base server when it was created on a type whose disk fits the base server's
 * (`includedNodeResizeOnPlanChange`); a server created natively on a bigger type
 * has a bigger disk and keeps its size. Never change that flag to satisfy a
 * disk request: growing a disk is a separate, explicit, ONE-WAY decision.
 */
export interface TeamsNodeTier {
	/** How many nodes at this tier. */
	readonly count: number;
	/** Seat count at which this tier starts. */
	readonly minSeats: number;
	/** Hetzner type. */
	readonly type: string;
}

/**
 * Ascending. Disk sizes are deliberately NOT part of the promise; see the
 * reversibility note above.
 */
export const TEAMS_NODE_TIERS = [
	{ minSeats: 5, type: "cx23", count: 1 },
] satisfies readonly [TeamsNodeTier, ...TeamsNodeTier[]];

/** The Teams node tier in force at `seats` — the highest one reached. */
export const teamsNodeTierForSeats = (seats: number): TeamsNodeTier => {
	let tier: TeamsNodeTier = TEAMS_NODE_TIERS[0];
	for (const candidate of TEAMS_NODE_TIERS) {
		if (seats >= candidate.minSeats) {
			tier = candidate;
		}
	}
	return tier;
};

/**
 * How many free nodes a plan grants at `seats`.
 *
 * Every plan gets exactly one today; Teams and Teams Lite resolve through
 * {@link TEAMS_NODE_TIERS} so a future band needs no second code path. The
 * server route and the slot index both resolve the count from this function so
 * the declared capacity is provisioned and race-safe.
 */
export const baseNodeCountForPlan = (
	plan: PlanId | null | undefined,
	seats = 1
): number => {
	if (!(plan && planIncludesBaseNode(plan))) {
		return 0;
	}
	if (plan !== "teams" && plan !== "teams-lite") {
		return 1;
	}
	return teamsNodeTierForSeats(seats).count;
};

/**
 * How many included nodes a plan grants in a specific region. A null regional
 * type means the plan has no included node there and the customer must use a
 * priced cloud-instance add-on.
 */
export const baseNodeCountForPlanAtLocation = (
	plan: PlanId | null | undefined,
	location: string | null | undefined,
	seats = 1
): number =>
	baseNodeTypeForPlanAtLocation(plan, location, seats) === null
		? 0
		: baseNodeCountForPlan(plan, seats);

/**
 * How the qualifying plans are NAMED in customer-facing copy ("…is included
 * with Pro, Max, Teams or Business"). Presentational only — never parse it. Every string
 * that used to hardcode "Max" reads this, so widening or narrowing the set is
 * one edit here plus {@link PLANS_INCLUDING_BASE_NODE}, not a nine-file sed.
 *
 * Names only the PUBLICLY offered tiers. Plus and Teams Lite also include a node
 * (see {@link PLANS_INCLUDING_BASE_NODE}) but are private offers, so their names
 * stay out of public strings; their holders still get the node.
 */
export const BASE_NODE_PLANS_LABEL = "Pro, Max, Teams or Business";
