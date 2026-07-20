// apps/desktop/src/lib/gating/planCapBridge.ts
//
// Numeric-cap (Bucket 3) enforcement primitives shared by the desktop
// entity-creation stores and flows (free-tier gating plan, 2026-07-11).
//
// Open-core rule: these caps live ONLY in the closed desktop layer, never in
// `apps/core`/`apps/gateway` source. They are SYMBOLIC and MANAGED-PATH-ONLY —
// a self-hoster who never signs in to the control plane (no billing auth) stays
// completely uncapped by design.
//
// Most call sites are React and read the entitlement straight from
// `useEntitlementContext` via `useEntityCap`. This module additionally exposes a
// tiny module-singleton so the NON-React `useNodeStore` (a zustand store with no
// access to React context) can enforce a cap and surface the upgrade modal. The
// React layer keeps the singleton in sync each render (`syncPlanCapState`); when
// it has not been synced yet the caps FAIL OPEN so a payer is never falsely
// blocked before the entitlement resolves.

import {
	type DesktopGateVerdict,
	type PlanId,
	type PlanLimitField,
	planLimit,
} from "@ryu/auth/lib/plans";
import { hasBillingAuth } from "@/src/lib/api/billing.ts";

/**
 * The effective plan for numeric caps. Trial and one-time Lifetime (license)
 * users have `proUnlocked` true but no PURCHASED plan (`plan === null`); band
 * them into `"pro"` so they get the paid (uncapped) limits, matching the plan's
 * "Trial = Pro" and "Lifetime gets all pro" rules. A signed-in free / paywalled
 * user (`proUnlocked` false, `plan` null) keeps the FREE caps. `"pro"` is
 * equivalent to `"desktop-license"` for every capped field, so we do not need to
 * distinguish the two here.
 */
export function effectivePlan(
	verdict: DesktopGateVerdict | null
): PlanId | null {
	if (!verdict) {
		return null;
	}
	return verdict.plan ?? (verdict.proUnlocked ? "pro" : null);
}

interface PlanCapState {
	/** `undefined` until the React layer first syncs → treat as unknown. */
	plan: PlanId | null | undefined;
	requestUpgrade: (() => void) | null;
}

const state: PlanCapState = { plan: undefined, requestUpgrade: null };

/** Keep the non-React singleton in sync with the resolved entitlement. */
export function syncPlanCapState(
	plan: PlanId | null,
	requestUpgrade: () => void
): void {
	state.plan = plan;
	state.requestUpgrade = requestUpgrade;
}

/**
 * The effective numeric limit for `field` on the MANAGED path. Off the managed
 * path (not signed in to the control plane) everything is uncapped — self-host /
 * local-Core-without-billing stays free of caps by design. When the plan has not
 * been resolved yet, fail open ({@link Number.POSITIVE_INFINITY}).
 */
export function resolveCapLimit(field: PlanLimitField): number {
	if (!hasBillingAuth()) {
		return Number.POSITIVE_INFINITY;
	}
	if (state.plan === undefined) {
		return Number.POSITIVE_INFINITY;
	}
	return planLimit(state.plan, field);
}

/** Thrown by {@link enforcePlanCap} when a create would exceed a numeric cap. */
export class PlanCapError extends Error {
	readonly field: PlanLimitField;
	readonly limit: number;
	constructor(field: PlanLimitField, limit: number) {
		super(`Plan limit reached for ${field} (${limit}).`);
		this.name = "PlanCapError";
		this.field = field;
		this.limit = limit;
	}
}

/**
 * Enforce a numeric cap from a NON-React store/creator: opens the upgrade modal
 * (when a requester is registered) and throws {@link PlanCapError} when creating
 * one more (given `currentCount`) would exceed the cap. A no-op under the cap or
 * off the managed path. The throw guarantees the cap holds even if the modal
 * requester has not been registered yet.
 */
export function enforcePlanCap(
	field: PlanLimitField,
	currentCount: number
): void {
	const limit = resolveCapLimit(field);
	if (currentCount >= limit) {
		state.requestUpgrade?.();
		throw new PlanCapError(field, limit);
	}
}
