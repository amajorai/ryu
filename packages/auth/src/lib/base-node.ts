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
	"max",
	"teams",
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
 * The Hetzner type each plan's FREE node is provisioned at.
 *
 * Max gets a genuinely bigger machine — this is one of the things a top-up
 * cannot sell you, and therefore one of the reasons Max exists at all now that
 * it is no longer a credit pack. `cx33` is 4 vCPU · 8 GB · 80 GB against the
 * `cx23`'s 2 vCPU · 4 GB · 40 GB: double the compute and memory.
 *
 * NOT `cpx22`, which reads like the obvious upgrade and is a trap: Hetzner's
 * June 2026 repricing took it from €7.99 to **€19.49**, while `cx33` is €8.49
 * for twice the cores and twice the RAM. Always price the type against the live
 * catalog before promoting one into a plan — the intuition that "cpx > cx" has
 * not been true since that change.
 */
export const BASE_NODE_TYPE_BY_PLAN: Readonly<Record<string, string>> = {
	pro: "cx23",
	max: "cx33",
	teams: "cx23",
	business: "cpx32",
};

/**
 * Singapore's catalog does not offer the EU `cx23`, and its available shapes are
 * materially more expensive than the EU defaults. Teams and Business have
 * enough organization-seat margin to include their regional profiles. Pro and
 * Max do not: their global prices cannot safely absorb a Singapore node on the
 * annual term, so those customers can still choose Singapore through a priced
 * cloud-instance add-on but are not promised a free regional node.
 */
export const BASE_NODE_TYPE_BY_PLAN_IN_SINGAPORE: Readonly<
	Record<string, string>
> = {
	teams: "cpx22",
	business: "cpx32",
};

/**
 * The type a plan's included node is provisioned at, or null when it gets none.
 * Teams resolves through the seat ladder; Business has a fixed performance
 * profile and everything else is fixed per plan.
 */
export const baseNodeTypeForPlan = (
	plan: PlanId | null | undefined,
	seats = 1
): string | null => {
	if (!(plan && planIncludesBaseNode(plan))) {
		return null;
	}
	if (plan === "teams") {
		return teamsNodeTierForSeats(seats).type;
	}
	return BASE_NODE_TYPE_BY_PLAN[plan] ?? "cx23";
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
		if (plan === "teams") {
			return BASE_NODE_TYPE_BY_PLAN_IN_SINGAPORE.teams ?? "cpx22";
		}
		return BASE_NODE_TYPE_BY_PLAN_IN_SINGAPORE[plan] ?? null;
	}
	return baseNodeTypeForPlan(plan, seats);
};

/**
 * TEAMS COMPUTE SCALES WITH THE ORG — by SIZE, not by count.
 *
 * The first attempt granted "one `cx23` per 10 seats", which fixed the wrong
 * variable. Ten 2-vCPU boxes for a hundred people is ten small machines, not one
 * adequate one: a single node serves the org's shared agent traffic, so what a
 * bigger team needs is a bigger node, and only past a point a second one.
 *
 * The distinction that matters, because it is easy to conflate: a VM per SEAT is
 * not industry practice and mostly buys idle hardware — seats are human
 * licences. Capacity that scales with org size IS standard (Vercel, Databricks:
 * seats are licences, compute is sized separately). This ladder is the second
 * thing, not the first.
 *
 * The cost stays trivial against revenue — ~$77/mo of hardware at 100 seats
 * against $4,165 of subscription — and it is both cheaper AND more useful than
 * ten idle `cx23`s.
 *
 * REVERSIBILITY IS WHY THIS IS SAFE TO SCALE DOWN. Hetzner's `change_type` can
 * move a server between types in place, but a resize that GROWS THE DISK is
 * permanent — such a server can never be downgraded again. `resizeServerSEAM`
 * in `cloud-provision.ts` therefore always passes `upgrade_disk: false`, so the
 * disk stays at its original size and the CPU/RAM tier remains free to move in
 * both directions. Never change that flag to satisfy a disk request: growing a
 * disk is a separate, explicit, ONE-WAY decision, and folding it into an
 * automatic seat-driven resize would silently strand the org on its current tier
 * forever.
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
 * Ascending. Disk sizes are deliberately NOT part of the promise — see the
 * reversibility note above; a `cx23` resized up keeps its 40 GB.
 */
export const TEAMS_NODE_TIERS: readonly TeamsNodeTier[] = [
	{ minSeats: 5, type: "cx23", count: 1 },
	{ minSeats: 10, type: "cx33", count: 1 },
	{ minSeats: 25, type: "cpx32", count: 1 },
	{ minSeats: 50, type: "cpx32", count: 2 },
];

/** The Teams node tier in force at `seats` — the highest one reached. */
export const teamsNodeTierForSeats = (seats: number): TeamsNodeTier => {
	let tier = TEAMS_NODE_TIERS[0] as TeamsNodeTier;
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
 * Everything except Teams gets exactly one. Teams reaches two included nodes at
 * the 50-seat tier; the server route and the slot index both resolve that count
 * from this function so the declared capacity is provisioned and race-safe.
 */
export const baseNodeCountForPlan = (
	plan: PlanId | null | undefined,
	seats = 1
): number => {
	if (!(plan && planIncludesBaseNode(plan))) {
		return 0;
	}
	if (plan !== "teams") {
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
 */
export const BASE_NODE_PLANS_LABEL = "Pro, Max, Teams or Business";

/**
 * The same set in a conjunctive sentence position ("included with Pro, Max,
 * Teams and Business"). Two constants rather than one because English needs both and a
 * caller that picks the wrong one reads as a typo to a customer.
 */
export const BASE_NODE_PLANS_LABEL_ALL = "Pro, Max, Teams and Business";
