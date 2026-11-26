import type { Entitlement, PlanId } from "./plans.ts";

/* -------------------------------------------------------------------------- *
 * Desktop access (personal use is free).
 *
 * Every feature that runs on the user's own computer or with their own keys is
 * free: there is no trial clock, no paywall and no numeric desktop cap. The only
 * gated capabilities are the ones Ryu pays for per user (managed inference,
 * cloud sync, cloud nodes, hosted bots, team seats, agent mail); they need an
 * active subscription and are listed in CAPABILITY_TIERS below.
 *
 * A subscription or a desktop license key still resolves as before, so an
 * existing license holder keeps their state. The offline-grace window keeps a
 * paying user's plan when the control plane is briefly unreachable.
 * -------------------------------------------------------------------------- */

/** One day in milliseconds; the unit the offline-grace window is measured in. */
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The desktop gate's tunable windows. */
export interface DesktopGateConfig {
	/** How long a cached entitlement is trusted while offline, in days. */
	readonly offlineGraceDays: number;
	/**
	 * Retired: the desktop has no trial and {@link decideDesktopAccess} never
	 * reads this. It stays only because the public pricing text still prints it;
	 * remove it together with that line.
	 */
	readonly trialDays: number;
}

/** The single default gate config (swappable; never inlined per-component). */
export const DESKTOP_GATE: DesktopGateConfig = {
	trialDays: 7,
	offlineGraceDays: 7,
};

/**
 * Local/BYOK chat, agents, tools, MCP, skills, workflows, Prompt Studio, evals,
 * GraphRAG, Companion, and Gateway governance UI are free desktop features.
 * They are absent from the paid capability map by construction. Managed
 * services require paid access.
 * The legacy "pro" tier remains available for compatibility with band helpers.
 */
export type CapabilityTier = "pro" | "subscription";

/** Each gated capability and the entitlement tier it requires. */
export const CAPABILITY_TIERS = {
	// Band 3 — Ryu pays a recurring bill; an ACTIVE subscription only.
	"managed-inference": "subscription",
	"cloud-sync": "subscription",
	"cloud-node": "subscription",
	"hosted-bots": "subscription",
	"team-seats": "subscription",
	"agent-mail": "subscription",
} as const satisfies Record<string, CapabilityTier>;

export type GatedCapability = keyof typeof CAPABILITY_TIERS;

/** Every gated capability (Band 1 free features are absent by construction). */
export const GATED_CAPABILITIES = Object.keys(CAPABILITY_TIERS).filter(
	(key): key is GatedCapability => Object.hasOwn(CAPABILITY_TIERS, key)
);

/** The entitlement tier a capability requires. */
export const capabilityTier = (cap: GatedCapability): CapabilityTier =>
	CAPABILITY_TIERS[cap];

/** Why the desktop resolved to this access state. */
export type AccessReason =
	| "subscription" // an active Plus/Pro/Max/Teams/Teams Lite/Business subscription
	| "license" // a valid desktop license key
	| "offline-grace" // live check failed; riding a cached last-good paid plan
	| "free"; // personal use: every local feature, no managed services

/**
 * A cached last-good entitlement, persisted locally so a paying user does not
 * lose their plan when the control plane is briefly unreachable. `proUnlocked`
 * is the resolved desktop access at the time it was cached; `cachedAtMs`
 * anchors the offline-grace window.
 */
export interface CachedEntitlement {
	readonly cachedAtMs: number;
	readonly managedInference: boolean;
	/** Whether the cached recurring entitlement included Marketplace apps. */
	readonly marketplaceApps: boolean;
	readonly plan: PlanId | null;
	readonly proUnlocked: boolean;
}

/** Inputs to the pure desktop-access decision. All times are epoch ms. */
export interface DesktopGateInput {
	/** Last-good cached entitlement, or null when none has ever been cached. */
	readonly cached?: CachedEntitlement | null;
	/**
	 * Whether a desktop license key validated as active on this device. Resolved
	 * by the client from the validate endpoint; folded into the verdict here so
	 * the decision stays in one pure place.
	 */
	readonly licenseActive: boolean;
	/**
	 * The freshly-fetched entitlement, or null when the live check FAILED
	 * (offline / server error). A successful check that returns the un-entitled
	 * baseline is a non-null Entitlement with `plan: null`.
	 */
	readonly liveEntitlement: Entitlement | null;
	/** Now, in epoch ms. Injected so the decision is deterministic in tests. */
	readonly nowMs: number;
}

/** The resolved desktop-access verdict. */
export interface DesktopGateVerdict {
	/** True when managed inference is available (a subscription with the pool). */
	readonly managedInference: boolean;
	/** Whether the resolved state can use supported paid Marketplace apps. */
	readonly marketplaceApps: boolean;
	/** The effective plan id, or null. */
	readonly plan: PlanId | null;
	/**
	 * Whether every local desktop feature is available. Always true: personal
	 * use is free. Kept so plan-band helpers and stored entitlements keep their
	 * shape.
	 */
	readonly proUnlocked: boolean;
	readonly reason: AccessReason;
}

const cacheIsFresh = (cached: CachedEntitlement, nowMs: number, days: number) =>
	nowMs - cached.cachedAtMs < days * MS_PER_DAY;

/** The offline-grace verdict: the live check failed and a fresh paid cache exists. */
const offlineGraceVerdict = (
	{ liveEntitlement, cached, nowMs }: DesktopGateInput,
	config: DesktopGateConfig
): DesktopGateVerdict | null => {
	if (
		liveEntitlement !== null ||
		!cached?.proUnlocked ||
		!cached.plan ||
		!cacheIsFresh(cached, nowMs, config.offlineGraceDays)
	) {
		return null;
	}
	return {
		proUnlocked: true,
		marketplaceApps: cached.marketplaceApps,
		managedInference: cached.managedInference,
		plan: cached.plan,
		reason: "offline-grace",
	};
};

/**
 * Decide desktop access from the live entitlement, a license check, and a
 * cached last-good entitlement. Pure and deterministic (inject `nowMs`).
 *
 * Precedence:
 *  1. Active subscription or license (live): that plan, managed inference per plan.
 *  2. Valid desktop license key: license, no managed inference.
 *  3. Live check FAILED with a fresh paid cache: ride the cached plan (offline
 *     grace).
 *  4. Otherwise: free. Every local feature, no managed services.
 *
 * No branch locks the desktop. The caller gates only {@link GATED_CAPABILITIES}.
 */
export const decideDesktopAccess = (
	input: DesktopGateInput,
	config: DesktopGateConfig = DESKTOP_GATE
): DesktopGateVerdict => {
	const { liveEntitlement, licenseActive } = input;

	// 1) A successful live check with an entitling subscription/license.
	if (liveEntitlement?.desktopAccess) {
		const reason: AccessReason =
			liveEntitlement.plan === "desktop-license" ? "license" : "subscription";
		return {
			proUnlocked: true,
			marketplaceApps: liveEntitlement.marketplaceApps,
			managedInference: liveEntitlement.managedInference,
			plan: liveEntitlement.plan,
			reason,
		};
	}

	// 2) A validated desktop license key (the live entitlement may lag the
	//    just-entered key; the explicit license flag wins).
	if (licenseActive) {
		return {
			proUnlocked: true,
			marketplaceApps: false,
			managedInference: false,
			plan: "desktop-license",
			reason: "license",
		};
	}

	// 3) A subscriber whose live check failed keeps the cached paid plan (and its
	//    managed inference) for the grace window.
	const grace = offlineGraceVerdict(input, config);
	if (grace) {
		return grace;
	}

	// 4) Personal use is free. Managed inference stays withheld because it bills
	//    real cloud spend; the server and the gateway gate it either way.
	return {
		proUnlocked: true,
		marketplaceApps: false,
		managedInference: false,
		plan: null,
		reason: "free",
	};
};
