// apps/desktop/src/lib/gating/useEntityCap.ts
//
// React hook for enforcing Bucket-3 numeric caps at entity-creation flows
// (free-tier gating plan, 2026-07-11). Reads the resolved desktop entitlement
// from `useEntitlementContext`, resolves the effective plan, and returns a
// `guard(field, currentCount)` a create handler calls before it mutates.
//
// Managed-path only: off the managed path (not signed in to the control plane)
// every limit is Infinity, so self-host / local-Core-without-billing stays
// uncapped. Any mounted consumer of this hook also keeps the non-React
// `planCapBridge` singleton in sync so the zustand `useNodeStore` can enforce its
// own cap and open the same upgrade modal.

import { type PlanLimitField, planLimit } from "@ryu/auth/lib/plans";
import { useCallback, useEffect } from "react";
import { useEntitlementContext } from "@/src/contexts/entitlement-context.tsx";
import { hasBillingAuth } from "@/src/lib/api/billing.ts";
import { effectivePlan, syncPlanCapState } from "./planCapBridge.ts";

export interface EntityCapGuard {
	/**
	 * True when creating one more of `field` is allowed. When the cap is reached
	 * it opens the upgrade modal (`requestUpgrade`) and returns false so the
	 * caller can abort the create.
	 */
	guard: (field: PlanLimitField, currentCount: number) => boolean;
	/** The effective numeric limit for `field` (Infinity off the managed path). */
	limitFor: (field: PlanLimitField) => number;
}

/** Resolve the numeric-cap guard for the current desktop entitlement. */
export function useEntityCap(): EntityCapGuard {
	const { verdict, requestUpgrade } = useEntitlementContext();
	const plan = effectivePlan(verdict);

	// Keep the non-React bridge (used by the zustand node store) in sync so it can
	// enforce its cap and surface the same upgrade modal.
	useEffect(() => {
		syncPlanCapState(plan, requestUpgrade);
	}, [plan, requestUpgrade]);

	const limitFor = useCallback(
		(field: PlanLimitField): number =>
			hasBillingAuth() ? planLimit(plan, field) : Number.POSITIVE_INFINITY,
		[plan]
	);

	const guard = useCallback(
		(field: PlanLimitField, currentCount: number): boolean => {
			if (currentCount >= limitFor(field)) {
				requestUpgrade();
				return false;
			}
			return true;
		},
		[limitFor, requestUpgrade]
	);

	return { guard, limitFor };
}
