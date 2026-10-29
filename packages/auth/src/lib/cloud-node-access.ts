import type { PlanId } from "./plans.ts";

/**
 * Self-serve plans that may buy additional managed servers or resize one of
 * their included servers. Enterprise is intentionally not in this list: it is
 * a separate organization-level contract entitlement, resolved server-side.
 */
export const CLOUD_NODE_CHANGE_PLAN_IDS = [
	"teams",
	"teams-lite",
	"business",
] as const satisfies readonly PlanId[];

/**
 * Customer-facing list for the managed-server plan gate. Names only the
 * publicly offered plans: Teams Lite stays in `CLOUD_NODE_CHANGE_PLAN_IDS` but
 * is a private offer, so it is never named in customer-facing copy.
 */
export const CLOUD_NODE_CHANGE_PLANS_LABEL = "Business, Teams, or Enterprise";

/** The plan half of the managed-server purchase/resize authorization rule. */
export function planAllowsCloudNodeChanges(
	plan: PlanId | null | undefined
): boolean {
	return Boolean(plan && new Set<PlanId>(CLOUD_NODE_CHANGE_PLAN_IDS).has(plan));
}

/** Public, non-sensitive projection returned with an organization catalog. */
export interface CloudNodeActionAccess {
	canBuyAdditionalNodes: boolean;
	canUpgradeIncludedNode: boolean;
	enterprise: boolean;
	plan: PlanId | null;
}

/** Internal policy projection with the seat input used by Teams' node ladder. */
export interface CloudNodeEntitlement extends CloudNodeActionAccess {
	seats: number;
}

/**
 * Resolve the pure plan/contract policy. Enterprise is a separate organization
 * entitlement, so the API resolver supplies its active state explicitly.
 */
export function cloudNodeEntitlementFor(input: {
	enterpriseActive: boolean;
	plan: PlanId | null | undefined;
	seats?: number;
}): CloudNodeEntitlement {
	const enterprise = input.enterpriseActive;
	const plan = input.plan ?? null;
	const allowed = enterprise || planAllowsCloudNodeChanges(plan);
	return {
		canBuyAdditionalNodes: allowed,
		canUpgradeIncludedNode: allowed,
		enterprise,
		plan,
		seats:
			input.seats !== undefined && Number.isFinite(input.seats)
				? Math.max(1, Math.floor(input.seats))
				: 1,
	};
}
