// The order of a provider's credentials, kept as the per-account priority of
// the account routing policy: the first row has priority 0, the next 1, and so
// on. Lower numbers are tried first, so the order on screen is the order Ryu
// uses.

import type {
	OAuthAccountPoolPolicy,
	OAuthAccountStrategy,
} from "@/src/lib/api/pi-config.ts";

/** Core accepts priorities from 0 to this value. */
export const MAX_PRIORITY = 100;

type Rules = OAuthAccountPoolPolicy["accounts"];

/**
 * Account ids sorted by saved priority, lowest first. Accounts with the same
 * priority, or with no saved rule (priority 0), keep the order they came in.
 */
export function orderByPriority(
	ids: readonly string[],
	rules: Rules
): string[] {
	return ids
		.map((id, index) => ({ id, index, priority: rules[id]?.priority ?? 0 }))
		.sort((a, b) => a.priority - b.priority || a.index - b.index)
		.map((entry) => entry.id);
}

/** Move `id` one place up (`-1`) or down (`1`). The ends stay where they are. */
export function moveBy(
	order: readonly string[],
	id: string,
	delta: -1 | 1
): string[] {
	const from = order.indexOf(id);
	const to = from + delta;
	if (from === -1 || to < 0 || to >= order.length) {
		return [...order];
	}
	const next = [...order];
	next.splice(from, 1);
	next.splice(to, 0, id);
	return next;
}

/**
 * Drop `dragging` on `target`: it lands after the target when it came from
 * above, and before it when it came from below.
 */
export function moveOnto(
	order: readonly string[],
	dragging: string,
	target: string
): string[] {
	const from = order.indexOf(dragging);
	const onto = order.indexOf(target);
	if (from === -1 || onto === -1 || from === onto) {
		return [...order];
	}
	const next = order.filter((id) => id !== dragging);
	const targetIndex = next.indexOf(target);
	next.splice(from < onto ? targetIndex + 1 : targetIndex, 0, dragging);
	return next;
}

/**
 * The strategy that follows the order. "manual" only ever uses the account the
 * user picked, so a new order under it would change nothing: move to
 * "fill_first" where the provider offers it, else to "round_robin".
 */
export function strategyThatFollowsOrder(
	current: OAuthAccountStrategy,
	offered: readonly OAuthAccountStrategy[]
): OAuthAccountStrategy {
	if (current !== "manual") {
		return current;
	}
	for (const candidate of ["fill_first", "round_robin"] as const) {
		if (offered.includes(candidate)) {
			return candidate;
		}
	}
	return current;
}

/**
 * Write `order` into the policy: each listed account gets its position as its
 * priority, keeping its other settings. Accounts that are not listed are left
 * as they are.
 */
export function applyOrder(
	policy: OAuthAccountPoolPolicy,
	order: readonly string[],
	offered: readonly OAuthAccountStrategy[]
): OAuthAccountPoolPolicy {
	const accounts: Rules = { ...policy.accounts };
	for (const [position, id] of order.entries()) {
		accounts[id] = {
			...accounts[id],
			enabled: accounts[id]?.enabled ?? true,
			priority: Math.min(position, MAX_PRIORITY),
		};
	}
	return {
		...policy,
		accounts,
		strategy: strategyThatFollowsOrder(policy.strategy, offered),
	};
}

/** Whether a reorder would also change the strategy (see above). */
export function reorderChangesStrategy(
	current: OAuthAccountStrategy,
	offered: readonly OAuthAccountStrategy[]
): boolean {
	return strategyThatFollowsOrder(current, offered) !== current;
}
