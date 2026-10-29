import type { Entitlement, PlanId } from "./plans.ts";

/* -------------------------------------------------------------------------- *
 * Desktop trial + paywall gate (epic #496, Unit C1).
 *
 * The desktop is a PAID product ($200 list / $129 launch one-time license or a
 * Plus/Pro/Max/Teams/Teams Lite/Business subscription),
 * but Ryu is open-core: BASIC local/free chat must stay usable forever. So the
 * gate covers only Pro features + managed inference; it never blocks the app
 * shell. A fresh install gets a 7-day trial of full access; after expiry, with
 * no active sub and no valid license key, the Pro-feature set is locked behind
 * a (dismissible) paywall, dropping the user into free local chat.
 *
 * NOTHING HARDCODED: the trial length, the offline-grace window, and the gated
 * feature set live ONLY here, as one config, never inlined across components.
 * -------------------------------------------------------------------------- */

/** One day in milliseconds; the unit the trial/grace windows are measured in. */
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The desktop gate's tunable windows. Defaults match the epic #496 pricing
 * decisions (7-day trial). The offline-grace window is how long a cached
 * last-good entitlement is honoured when the control plane is unreachable, so a
 * paying user is NOT falsely locked out by a flaky network.
 */
export interface DesktopGateConfig {
	/**
	 * OFF-BY-DEFAULT escape hatch: while true, the gate grants Pro features to
	 * every user (no trial clock, no paywall). This is NOT the shipped model —
	 * "free Pro forever" is wrong; the correct model is open-core (the desktop
	 * shell + local/BYOK chat are ALWAYS free — the paywall is dismissible into
	 * free local chat) PLUS a 7-day full trial of Pro that then upsells. So the
	 * default is `false`: new installs get the 7-day trial, then the paywall.
	 * Keep this flag only as a break-glass to re-open everything (e.g. an
	 * incident); flipping it ships as a normal release, delivered through the
	 * user-controlled auto-updater.
	 * It always withholds managed inference (real cloud spend) and never
	 * overrides a real paying subscription/license.
	 */
	readonly betaFree: boolean;
	/** How long a cached entitlement is trusted while offline, in days. */
	readonly offlineGraceDays: number;
	/** Free-trial length from first launch, in days. */
	readonly trialDays: number;
}

/**
 * What the free trial is a trial OF — and it is NOT Pro.
 *
 * The trial branch of {@link decideDesktopAccess} returns
 * `proUnlocked: true, managedInference: false`. That is Band 2 and only Band 2:
 * the numeric desktop allowances a one-time **Lifetime Desktop license** unlocks
 * forever. Local power features remain free after the trial. The trial grants
 * no managed inference, credits, or cloud node; those require paid managed access.
 *
 * Calling it a "Pro trial" therefore oversold it in both directions: it promised
 * credits and a server the trial never grants, and it hid that what the user is
 * actually sampling is the Lifetime Desktop product. A trialist who then bought
 * Pro expecting the same thing plus a bill is a support ticket; one who assumed
 * the trial included managed inference is a refund.
 *
 * Single source of truth so the name cannot drift across the desktop, the web
 * pricing page and the docs the way "Pro trial" did.
 */
export const DESKTOP_TRIAL_LABEL = "Lifetime Desktop trial";

/**
 * One line for "what does the trial actually include", for any surface that
 * needs to say so. Names the exclusions explicitly, because the exclusions are
 * the part that was previously misrepresented.
 */
export const DESKTOP_TRIAL_INCLUDES =
	"Full desktop app access. Managed inference, credits and cloud nodes are not included.";

/** The single default gate config (swappable; never inlined per-component). */
export const DESKTOP_GATE: DesktopGateConfig = {
	// Open-core + a 7-day LIFETIME DESKTOP trial → upsell is the shipped model
	// (see `DESKTOP_TRIAL_LABEL` for why it is not a "Pro" trial). `betaFree` is a
	// break-glass escape hatch only (see the field doc); the default is OFF so a
	// fresh install gets the trial, then the paywall — not free Pro forever.
	betaFree: false,
	trialDays: 7,
	offlineGraceDays: 7,
};

/**
 * The gate config for a client that has resolved the `billing.desktop_trial`
 * rollout flag. Trial off turns on `betaFree`, so the desktop is free and
 * uncapped (no trial clock, no paywall) while real subscriptions and licences
 * still win in {@link decideDesktopAccess}.
 */
export const desktopGateConfig = (
	trialEnabled: boolean,
	base: DesktopGateConfig = DESKTOP_GATE
): DesktopGateConfig => (trialEnabled ? base : { ...base, betaFree: true });

/**
 * Local/BYOK chat, agents, tools, MCP, skills, workflows, Prompt Studio, evals,
 * GraphRAG, Companion, and Gateway governance UI are free desktop features.
 * They are absent from the paid capability map by construction. The desktop
 * license lifts separate numeric caps; managed services require paid access.
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

/** Why access is currently granted (or why it is not). */
export type AccessReason =
	| "subscription" // an active Plus/Pro/Max/Teams/Teams Lite/Business subscription
	| "license" // a valid desktop license key
	| "beta" // free-during-beta flag is on (no trial clock, no paywall)
	| "trial" // still inside the 7-day trial window
	| "offline-grace" // live check failed; riding a cached last-good entitlement
	| "trial-expired" // trial over, no sub/license, online (locked)
	| "locked"; // no entitlement and grace exhausted (locked)

/**
 * A cached last-good entitlement, persisted locally so a paying user is not
 * locked out when the control plane is briefly unreachable. `proUnlocked` is
 * the resolved Pro state at the time it was cached; `cachedAtMs` anchors the
 * offline-grace window.
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
	/** First-launch timestamp (server-authoritative when available). */
	readonly firstLaunchMs: number | null;
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
	/** Days remaining in the trial (0 once expired); for the countdown UI. */
	readonly daysLeftInTrial: number;
	/** True when managed inference is available (sub with the pool, not trial). */
	readonly managedInference: boolean;
	/** Whether the resolved state can use supported paid Marketplace apps. */
	readonly marketplaceApps: boolean;
	/**
	 * True when the user is on the FREE band only (no Lifetime license, no active
	 * subscription, trial expired). Under the soft paywall this NEVER blanks the
	 * app shell — it drives the dismissible upsell modal and pauses always-on
	 * background automation (a Band-2 feature). Band 1 local chat stays usable.
	 */
	readonly paywalled: boolean;
	/** The effective plan id, or null. */
	readonly plan: PlanId | null;
	/** True when Pro features are unlocked (sub / license / trial / grace). */
	readonly proUnlocked: boolean;
	readonly reason: AccessReason;
}

const daysLeft = (firstLaunchMs: number, nowMs: number, trialDays: number) => {
	const elapsedMs = nowMs - firstLaunchMs;
	const remainingMs = trialDays * MS_PER_DAY - elapsedMs;
	if (remainingMs <= 0) {
		return 0;
	}
	return Math.ceil(remainingMs / MS_PER_DAY);
};

// A null first-launch (server unreachable / never anchored) is treated as a
// FRESH trial, never an expired one — so a new or offline install is granted
// the trial rather than falsely locked out before its anchor is known.
const inTrial = (firstLaunchMs: number | null, nowMs: number, days: number) =>
	firstLaunchMs === null || nowMs - firstLaunchMs < days * MS_PER_DAY;

const cacheIsFresh = (cached: CachedEntitlement, nowMs: number, days: number) =>
	nowMs - cached.cachedAtMs < days * MS_PER_DAY;

/** The offline-grace verdict: the live check failed and a fresh Pro cache exists. */
const offlineGraceVerdict = (
	{ liveEntitlement, cached, nowMs }: DesktopGateInput,
	config: DesktopGateConfig,
	daysLeftInTrial: number
): DesktopGateVerdict | null => {
	if (
		liveEntitlement !== null ||
		!cached?.proUnlocked ||
		!cacheIsFresh(cached, nowMs, config.offlineGraceDays)
	) {
		return null;
	}
	return {
		proUnlocked: true,
		marketplaceApps: cached.marketplaceApps,
		managedInference: cached.managedInference,
		plan: cached.plan,
		paywalled: false,
		reason: "offline-grace",
		daysLeftInTrial,
	};
};

/**
 * Decide desktop access from first-launch, the live entitlement, a license
 * check, and a cached last-good entitlement. Pure and deterministic (inject
 * `nowMs`): the sole unit-test surface and the only verification available
 * without a Tauri runtime.
 *
 * Precedence:
 *  1. Active subscription (live)        → Pro unlocked, managed-inference per plan.
 *  2. Valid desktop license (live)      → Pro unlocked, no managed inference.
 *  3. Free-during-beta flag on          → Pro unlocked (beta), no managed pool,
 *                                         unless offline with a fresh cached paid
 *                                         plan, which keeps that plan (as step 5).
 *  4. Inside the 7-day trial            → Pro unlocked (trial), no managed pool.
 *  5. Live check FAILED + fresh cache   → ride the cached last-good entitlement
 *                                         (offline grace) so no false lockout.
 *  6. Otherwise                         → locked (paywall); free local chat stays.
 *
 * Note open-core: a locked verdict NEVER blocks the app shell — the caller gates
 * only {@link GATED_CAPABILITIES}, and the paywall is dismissible into free chat.
 */
export const decideDesktopAccess = (
	input: DesktopGateInput,
	config: DesktopGateConfig = DESKTOP_GATE
): DesktopGateVerdict => {
	const { liveEntitlement, licenseActive, firstLaunchMs, nowMs } = input;
	const trialDaysLeft = firstLaunchMs
		? daysLeft(firstLaunchMs, nowMs, config.trialDays)
		: config.trialDays;

	// 1) A successful live check with an entitling subscription/license.
	if (liveEntitlement?.desktopAccess) {
		const reason: AccessReason =
			liveEntitlement.plan === "desktop-license" ? "license" : "subscription";
		return {
			proUnlocked: true,
			marketplaceApps: liveEntitlement.marketplaceApps,
			managedInference: liveEntitlement.managedInference,
			plan: liveEntitlement.plan,
			paywalled: false,
			reason,
			daysLeftInTrial: trialDaysLeft,
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
			paywalled: false,
			reason: "license",
			daysLeftInTrial: trialDaysLeft,
		};
	}

	// 3) Free-during-beta flag: with no real subscription/license (those win
	//    above, keeping a paying user's managed inference), grant Pro features to
	//    everyone — no trial clock, no paywall. Managed inference stays withheld
	//    (it bills real cloud spend); flip `betaFree` off to enable the paid gate.
	if (config.betaFree) {
		// A subscriber whose live check failed keeps the cached paid plan (and its
		// managed inference) instead of dropping to the beta's free tier.
		const grace = offlineGraceVerdict(input, config, trialDaysLeft);
		if (grace?.plan) {
			return grace;
		}
		return {
			proUnlocked: true,
			marketplaceApps: false,
			managedInference: false,
			plan: null,
			paywalled: false,
			reason: "beta",
			daysLeftInTrial: 0,
		};
	}

	// 4) Inside the trial window.
	if (inTrial(firstLaunchMs, nowMs, config.trialDays)) {
		return {
			proUnlocked: true,
			marketplaceApps: false,
			managedInference: false,
			plan: null,
			paywalled: false,
			reason: "trial",
			daysLeftInTrial: trialDaysLeft,
		};
	}

	// 5) Live check failed (offline) but we have a fresh, Pro last-good cache:
	//    ride the grace window rather than falsely locking a paying user out.
	const grace = offlineGraceVerdict(input, config, trialDaysLeft);
	if (grace) {
		return grace;
	}

	// 6) Locked. Free local chat stays usable; the paywall gates Pro features.
	return {
		proUnlocked: false,
		marketplaceApps: false,
		managedInference: false,
		plan: null,
		paywalled: true,
		reason:
			firstLaunchMs !== null && nowMs - firstLaunchMs >= 0
				? "trial-expired"
				: "locked",
		daysLeftInTrial: 0,
	};
};
