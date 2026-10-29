/**
 * Rewards store catalog — the single source of truth for what a user can buy
 * with points, and how much each item costs.
 *
 * THIS IS THE THING THE POINTS ECONOMY EXISTS FOR. The points earned by usage,
 * streaks, milestones and quests are spendable currency; this catalog is the
 * store they're spent in. It deliberately SUPERSEDES the feature-unlock sink
 * (`features.ts`'s progressive tier): instead of spending points to switch on
 * cosmetic settings, points now buy real value — provider credits, desktop
 * access, plan time, nodes. The feature-unlock rows are not deleted here (they
 * stay for users who already spent there), but every NEW earning surface
 * advertises this store as where points go.
 *
 * SAME DISCIPLINE AS `plans.ts` / `features.ts`: ONE const, imported
 * everywhere. `key` is stable and persisted in `PointsRedemption` rows; never
 * rename in flight.
 *
 * ITEM KINDS AND THEIR FULFILMENT. The router that serves this catalog decides
 * how each kind materializes, and the kinds are the contract it switches on:
 *  - `credit` — a pool-restricted `CreditGrant` into the wallet of an org the
 *    user chooses at redemption time (the same reward-received dialog quests
 *    use). Fulfilled automatically.
 *  - `plan_time` / `desktop_access` — a non-renewing personal plan window
 *    (`desktop_access` is the cheapest plan that includes the desktop app, Plus).
 *    The redemption row itself carries the window, and entitlement resolution
 *    overlays it exactly like a redeemed subscription gift. Fulfilled
 *    automatically.
 *  - `node_time` — a managed node provisioned into an org the user chooses,
 *    scheduled for removal when the window ends. Fulfilled automatically.
 */

import type { CreditPoolId } from "./credit-pools.ts";
import type { PlanId } from "./plans.ts";

/** What a store item grants when redeemed. */
export type StoreRewardKind =
	| {
			kind: "credit";
			/** Micro-USD of pool-restricted credit granted. */
			creditMicroUsd: number;
			pool: CreditPoolId;
	  }
	| { kind: "desktop_access"; months: number }
	| { kind: "node_time"; months: number }
	| { kind: "plan_time"; months: number; plan: PlanId };

/** One store item. `costPoints` is what the user pays. */
export interface StoreItemDef {
	readonly costPoints: number;
	readonly description: string;
	readonly icon?: string;
	readonly key: string;
	readonly reward: StoreRewardKind;
	readonly title: string;
}

/** Micro-USD per dollar, so prices are written in readable dollars. */
const usd = (dollars: number): number => Math.round(dollars * 1_000_000);

/**
 * The catalog. Provider credits are cheap-ish so there's always something
 * reachable; the entitlement items are deliberately expensive — the user said
 * plans and nodes "must have a lot of credits".
 */
export const REWARDS_STORE: readonly StoreItemDef[] = [
	{
		key: "credit-5",
		title: "$5 provider credits",
		description:
			"$5 of Ryu Credits, spendable on Ryu's cloud models. The everyday redemption.",
		icon: "coins",
		costPoints: 500,
		reward: { kind: "credit", creditMicroUsd: usd(5), pool: "cloudflare" },
	},
	{
		key: "credit-25",
		title: "$25 provider credits",
		description: "$25 of Ryu Credits, spendable on Ryu's cloud models.",
		icon: "coins",
		costPoints: 2200,
		reward: { kind: "credit", creditMicroUsd: usd(25), pool: "cloudflare" },
	},
	{
		key: "desktop-1m",
		title: "1 month desktop access",
		description:
			"One month of the entry personal plan on your account, which includes the desktop app.",
		icon: "laptop",
		costPoints: 3000,
		reward: { kind: "desktop_access", months: 1 },
	},
	{
		key: "pro-1m",
		title: "1 month Ryu Pro",
		description:
			"One month of Ryu Pro — managed inference, advanced features, everything Pro unlocks.",
		icon: "zap",
		costPoints: 8000,
		reward: { kind: "plan_time", months: 1, plan: "pro" },
	},
	{
		key: "max-1m",
		title: "1 month Ryu Max",
		description:
			"One month of Ryu Max — the top tier, with the full managed-inference allowance.",
		icon: "star",
		costPoints: 15_000,
		reward: { kind: "plan_time", months: 1, plan: "max" },
	},
	{
		key: "node-1m",
		title: "1 month node time",
		description:
			"One month of managed node time — a provisioned cloud node, billed through Ryu.",
		icon: "server",
		costPoints: 25_000,
		reward: { kind: "node_time", months: 1 },
	},
];

/** Index by key for O(1) lookups; the catalog never has duplicate keys. */
const STORE_BY_KEY = new Map(REWARDS_STORE.map((item) => [item.key, item]));

/** Look up a store item by key (undefined for an unknown key). */
export const storeItemByKey = (key: string): StoreItemDef | undefined =>
	STORE_BY_KEY.get(key);

/** The credit value of a store item, or null when it is not a credit item. */
export function storeCreditReward(
	item: StoreItemDef
): { creditMicroUsd: number; pool: CreditPoolId } | null {
	return item.reward.kind === "credit"
		? { creditMicroUsd: item.reward.creditMicroUsd, pool: item.reward.pool }
		: null;
}

/** The plan that `desktop_access` grants: the cheapest plan with the desktop app. */
export const DESKTOP_ACCESS_PLAN = "plus" as const;

/** The entitlement a non-credit store item grants, or null for credit items. */
export type StoreEntitlementReward =
	| { kind: "plan"; months: number; plan: PlanId }
	| { kind: "node"; months: number };

export function storeEntitlementReward(
	item: StoreItemDef
): StoreEntitlementReward | null {
	switch (item.reward.kind) {
		case "plan_time":
			return {
				kind: "plan",
				months: item.reward.months,
				plan: item.reward.plan,
			};
		case "desktop_access":
			return {
				kind: "plan",
				months: item.reward.months,
				plan: DESKTOP_ACCESS_PLAN,
			};
		case "node_time":
			return { kind: "node", months: item.reward.months };
		default:
			return null;
	}
}
