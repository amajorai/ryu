import type { PlanTier } from "@ryu/ui/components/plan-badge.tsx";
import type { SubscriptionStatus } from "./api/billing.ts";

/** The key used by plain-state org reads that still need an org identity. */
export function orgScopeKey(
	activeOrgId: string | null,
	fallbackOrgId: string | null
): string {
	return activeOrgId ?? fallbackOrgId ?? "unscoped";
}

/**
 * Accept a plan only when the status is describing an organization.
 *
 * Older control planes may omit `scope` or `organizationId`, so an explicit
 * user scope is the only response that must be rejected. When a server does
 * provide an organization id, it must agree with the active org before its
 * plan can be rendered beside that org.
 */
export function planTierForOrg(
	status: SubscriptionStatus | null | undefined,
	activeOrgId: string | null
): PlanTier | null {
	if (!status || (status.scope === "user" && !status.organizationId)) {
		return null;
	}
	if (
		status.organizationId &&
		activeOrgId &&
		status.organizationId !== activeOrgId
	) {
		return null;
	}
	const plan = status.plan ?? status.entitlement?.plan ?? null;
	return plan === "marketplace-membership" ? null : plan;
}
