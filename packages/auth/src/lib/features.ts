/**
 * Feature catalog — the single source of truth for which product features
 * exist, how they are unlocked (default / earned with points / paid), and the
 * authoritative `hasFeature` gate every surface reads (spec
 * `docs/profiles-usage-points-spec.md` §4.5, §6.3, §7.3).
 *
 * Same discipline as `plans.ts`: ONE `FEATURES` const, imported everywhere, so
 * the catalog can never drift from the code that gates on it. Three tiers:
 *  - `default`     — always on. Essential / first-run-critical function. NEVER
 *                    point-gated (spec §9 guardrail).
 *  - `progressive` — discretionary/advanced; earned by spending `pointsCost`
 *                    points (progressive disclosure to reduce first-run
 *                    overwhelm). The free-tier path to power features.
 *  - `paid`        — unlocked immediately for anyone whose plan lists the
 *                    feature in `requiresPlan` (the money fast-path), resolved
 *                    live via `resolveEntitlement`. Also backfilled into
 *                    `UserUnlocks` on the subscription webhook.
 */

import { UserUnlocks } from "@ryu/db/models/user-unlocks.model";
import {
	type LicenseView,
	type PlanId,
	resolveEntitlement,
	type SubscriptionView,
} from "./plans.ts";

/**
 * A catalog feature. `key` is the stable identifier consumed by the gating
 * checks — never rename one in flight (it is persisted in `UserUnlocks`).
 */
export interface FeatureDef {
	/** Optional level at which a `progressive` feature auto-reveals. */
	readonly autoUnlockAtLevel?: number;
	readonly description: string;
	readonly icon?: string;
	readonly key: string;
	/** Points spent to unlock a `progressive` feature. */
	readonly pointsCost?: number;
	/** Plans that unlock a `paid` feature immediately (money fast-path). */
	readonly requiresPlan?: PlanId[];
	readonly tier: "default" | "progressive" | "paid";
	readonly title: string;
}

/**
 * The catalog. Kept small but real. Point-gate ONLY discretionary/advanced
 * features (spec §9): chat and the core sidebar are `default` and can never be
 * locked; the advanced surfaces are progressive; team/managed capabilities are
 * paid.
 */
export const FEATURES: FeatureDef[] = [
	// --- default: always on, never gated ---
	{
		key: "chat",
		title: "Chat",
		description: "The core assistant. Always available, on every plan.",
		icon: "message-circle",
		tier: "default",
	},
	{
		key: "sidebar",
		title: "Sidebar",
		description: "Conversations, channels, and navigation.",
		icon: "panel-left",
		tier: "default",
	},
	{
		key: "command_palette",
		title: "Command palette",
		description: "Fast keyboard-driven navigation and actions.",
		icon: "command",
		tier: "default",
	},
	// --- progressive: earned with points (discretionary/advanced) ---
	{
		key: "island",
		title: "Island",
		description: "The floating quick-capture island for on-the-fly prompts.",
		icon: "sparkles",
		tier: "progressive",
		pointsCost: 200,
		autoUnlockAtLevel: 2,
	},
	{
		key: "predict",
		title: "Predictions",
		description: "Inline next-step suggestions as you work.",
		icon: "wand",
		tier: "progressive",
		pointsCost: 400,
		autoUnlockAtLevel: 3,
	},
	{
		key: "custom_agents",
		title: "Custom agents",
		description: "Build and save your own reusable agents.",
		icon: "bot",
		tier: "progressive",
		pointsCost: 800,
		autoUnlockAtLevel: 5,
	},
	// --- paid: unlocked immediately by the plan ---
	{
		key: "managed_inference",
		title: "Managed inference",
		description: "Ryu-hosted models with an included monthly credit pool.",
		icon: "server",
		tier: "paid",
		requiresPlan: ["pro", "max", "teams"],
	},
	{
		key: "team_workspace",
		title: "Team workspace",
		description: "Shared org workspace, seats, and pooled credits.",
		icon: "users",
		tier: "paid",
		requiresPlan: ["teams"],
	},
];

/** Index by key for O(1) lookups; the catalog never has duplicate keys. */
const FEATURE_BY_KEY = new Map(
	FEATURES.map((feature) => [feature.key, feature])
);

/** Look up a feature definition by key (undefined for an unknown key). */
export const featureByKey = (key: string): FeatureDef | undefined =>
	FEATURE_BY_KEY.get(key);

/** The persisted `UserUnlocks` shape this module reads (lean projection). */
interface UserUnlocksDoc {
	unlocked?: string[];
}

/**
 * Optional live billing context for the paid fast-path. When a caller in the
 * API layer has the user's Polar subscription/license mapped to the views
 * `resolveEntitlement` understands, pass them so a paid feature unlocks the
 * instant the plan is active — even before the webhook backfills `UserUnlocks`.
 * Omit to rely solely on the `UserUnlocks` backfill.
 */
export interface FeatureContext {
	readonly license?: LicenseView | null;
	readonly subscription?: SubscriptionView | null;
}

/**
 * Whether a user currently has `key`. The ONE authoritative gate (spec §7.3),
 * read by both surfaces and the server. Grants when ANY holds:
 *  1. the feature is `default` (essential — always on);
 *  2. it is in the user's `UserUnlocks.unlocked` (earned, milestone, or a
 *     previously-backfilled paid unlock);
 *  3. it is `paid` and the user's live entitlement plan lists it in
 *     `requiresPlan` (the money fast-path, via `resolveEntitlement`).
 * An unknown key is denied.
 */
export async function hasFeature(
	userId: string,
	key: string,
	context: FeatureContext = {}
): Promise<boolean> {
	const feature = FEATURE_BY_KEY.get(key);
	if (!feature) {
		return false;
	}

	// 1) Default-tier features are always on and never gated.
	if (feature.tier === "default") {
		return true;
	}

	// 2) Explicitly unlocked (points spend, milestone, or paid backfill).
	const doc = (await UserUnlocks.findById(userId)
		.lean()
		.exec()) as UserUnlocksDoc | null;
	if (doc?.unlocked?.includes(key)) {
		return true;
	}

	// 3) Paid fast-path: resolve the live entitlement and check the plan.
	if (feature.tier === "paid" && feature.requiresPlan?.length) {
		const { plan } = resolveEntitlement(
			context.subscription ?? null,
			context.license ?? null
		);
		if (plan && feature.requiresPlan.includes(plan)) {
			return true;
		}
	}

	return false;
}
