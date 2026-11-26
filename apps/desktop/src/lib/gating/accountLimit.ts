// apps/desktop/src/lib/gating/accountLimit.ts
//
// What the desktop shows about the limit on connected accounts per provider.
//
// Core decides. It refuses a new account with `409 provider_account_limit` and
// the body `{ provider, limit, count }` (apps/core/src/server/access_gate/
// plan_limits.rs). The desktop only shows where the person stands before they
// try, and explains the refusal when it comes.
//
// The number shown before a refusal is the one the control plane signs into
// the user's token for Core: `planLimit(plan, "maxAccountsPerProvider")` over
// the purchased plan. A trial, the beta and a signed-out desktop have no
// purchased plan, so they show the free number, as Core applies it. When Core
// answers with another number (a node another licensed person uses, an older
// token), the refusal's own `limit` and `count` are shown instead.

import {
	type DesktopGateVerdict,
	type PlanId,
	planLimit,
} from "@ryu/auth/lib/plans";
import { ApiError } from "@/src/lib/api/client-api-error.ts";

/** The `code` of Core's refusal. */
export const ACCOUNT_LIMIT_CODE = "provider_account_limit";

/** Accounts one provider may hold on `plan` (null is the free plan). */
export function accountLimitForPlan(plan: PlanId | null): number {
	return planLimit(plan, "maxAccountsPerProvider");
}

/** Accounts one provider may hold with a desktop license or any paid plan. */
export const LICENSED_ACCOUNT_LIMIT = accountLimitForPlan("desktop-license");

/**
 * The limit for the entitlement this desktop resolved. Only a purchased plan
 * raises it; an unresolved verdict counts as free, because that is what Core
 * applies when it has seen no token.
 */
export function accountLimitForVerdict(
	verdict: Pick<DesktopGateVerdict, "plan"> | null | undefined
): number {
	return accountLimitForPlan(verdict?.plan ?? null);
}

export interface AccountLimitStanding {
	/** Accounts the provider holds now. */
	count: number;
	/** Accounts to remove before a new one fits. Zero below the limit. */
	extra: number;
	/** Whether a license or plan would raise this limit. */
	liftable: boolean;
	limit: number;
	/** `below` shows the count only; the other two explain why an add fails. */
	state: "below" | "full" | "over";
}

/** Where a provider with `count` accounts stands against `limit`. */
export function accountLimitStanding(
	count: number,
	limit: number
): AccountLimitStanding {
	const liftable = limit < LICENSED_ACCOUNT_LIMIT;
	if (count < limit) {
		return { count, extra: 0, liftable, limit, state: "below" };
	}
	return {
		count,
		extra: count - limit + 1,
		liftable,
		limit,
		state: count === limit ? "full" : "over",
	};
}

export interface AccountLimitRefusal {
	count: number;
	limit: number;
	provider: string | null;
}

function wholeNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value >= 0
		? value
		: null;
}

function field(body: unknown, name: string): unknown {
	return typeof body === "object" && body !== null && !Array.isArray(body)
		? Reflect.get(body, name)
		: undefined;
}

/**
 * Core's refusal of a new account, or null when `failure` is anything else.
 * The provider and Gateway routes answer with the fields at the top level, the
 * plan account routes nest them under `error`; both are read.
 */
export function accountLimitRefusal(
	failure: unknown
): AccountLimitRefusal | null {
	if (!(failure instanceof ApiError) || failure.code !== ACCOUNT_LIMIT_CODE) {
		return null;
	}
	const nested = field(failure.body, "error");
	const source = field(nested, "limit") === undefined ? failure.body : nested;
	const limit = wholeNumber(field(source, "limit"));
	const count = wholeNumber(field(source, "count"));
	if (limit === null || count === null) {
		return null;
	}
	const provider = field(source, "provider");
	return {
		count,
		limit,
		provider: typeof provider === "string" ? provider : null,
	};
}
