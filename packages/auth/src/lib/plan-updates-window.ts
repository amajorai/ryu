import { MS_PER_DAY } from "./plan-desktop-gate.ts";
import type { PlanId } from "./plans.ts";

/* -------------------------------------------------------------------------- *
 * Lifetime updates window (which BUILDS a desktop-license owner is offered).
 *
 * A desktop licence is PERPETUAL. Buying it grants the app forever; what a
 * purchase buys a YEAR of is UPDATES — the JetBrains / Sublime model. So this
 * window governs exactly one thing: which releases are OFFERED and INSTALLED.
 * It never revokes access, never flips an entitlement, and deliberately does not
 * appear anywhere in `decideDesktopAccess`, `DesktopGateVerdict` or
 * `CachedEntitlement` (all in `plan-desktop-gate.ts`). A lapsed owner keeps every feature they have; they
 * simply stop being handed builds published after their window closed.
 *
 * Be as candid about the posture as the `CAPABILITY_TIERS` doc
 * (`plan-desktop-gate.ts`) is:
 * enforcement is ADVISORY. The desktop asks Core to withhold newer releases, but
 * Core's update endpoint is unauthenticated, the cutoff lives in the user's own
 * storage, and the installers sit on a public GitHub release page. This is an
 * honour system, not a gate — it can decline to OFFER a build, it cannot prevent
 * one. Anything stronger would mean DRM on a perpetual licence.
 *
 * Both the control plane (which mints the window from Polar orders) and the
 * desktop (which compares a release against it) call THESE functions, so the
 * arithmetic, the grace and the "who does this apply to" rule exist once.
 * -------------------------------------------------------------------------- */

/** The updates window's tunables (swappable; never inlined per-call-site). */
export interface UpdatesWindowConfig {
	/**
	 * Slack added to the window end IN THE OWNER'S FAVOUR before any release is
	 * compared against it. Absorbs clock skew between GitHub, the control plane
	 * and the user's machine, so a release cut hours before the window closed is
	 * never withheld on a rounding argument. Applied EXACTLY ONCE, by
	 * {@link updatesCutoffMs} — never again downstream.
	 */
	readonly skewGraceMs: number;
	/** Years of updates one lifetime purchase adds. */
	readonly yearsPerPurchase: number;
}

/** The single default updates-window policy: one year per purchase, a day of slack. */
export const UPDATES_WINDOW: UpdatesWindowConfig = {
	skewGraceMs: MS_PER_DAY,
	yearsPerPurchase: 1,
};

// Calendar-year arithmetic in UTC. UTC (not the local-time setFullYear) so the
// result is the same instant on every machine and in CI regardless of the host
// timezone, and so it round-trips cleanly through the RFC-3339 string the
// control plane sends. Overflow normalisation is deliberate: 29 February + 1
// year has no 29 February to land on, so it rolls to 1 March — later, which is
// the direction that favours the owner.
const addYears = (ms: number, years: number): number => {
	const at = new Date(ms);
	at.setUTCFullYear(at.getUTCFullYear() + years);
	return at.getTime();
};

// A year count that can safely be handed to `addYears`: whole, non-negative, and
// never NaN/Infinity (which would produce an Invalid Date and, downstream, a
// throwing `toISOString()`).
const wholeYears = (years: number): number =>
	Number.isFinite(years) ? Math.max(0, Math.trunc(years)) : 0;

/**
 * End of the updates window for a set of lifetime purchases, or null when there
 * are none.
 *
 * Purchases STACK rather than re-anchor: each order adds `yearsPerPurchase` from
 * whichever is later — the moment of that purchase, or the end of the window it
 * already had. Buying again with six months left therefore yields eighteen
 * months, not twelve. (This is a deliberate change from the previous re-anchor
 * behaviour; the pricing FAQ and the in-app "Extend — buy lifetime again" CTA
 * both already promised it.)
 *
 * Calendar-year arithmetic, not 365 days, so the date the UI shows lands on the
 * purchase anniversary. A 29 February purchase rolls forward to 1 March, which
 * is the direction that favours the owner.
 *
 * Returns null — the documented "no window", which every caller treats as
 * unrestricted — rather than a non-finite number, so a malformed order or bonus
 * count can never become a NaN date downstream.
 */
export const updatesWindowEndMs = (
	orderTimesMs: readonly number[],
	bonusYears = 0,
	config: UpdatesWindowConfig = UPDATES_WINDOW
): number | null => {
	const ordered = orderTimesMs
		.filter((ms) => Number.isFinite(ms))
		.sort((a, b) => a - b);
	if (ordered.length === 0) {
		return null;
	}

	const perPurchase = wholeYears(config.yearsPerPurchase);
	let end = Number.NEGATIVE_INFINITY;
	for (const orderMs of ordered) {
		// Stack: extend the window the owner already had, unless it lapsed before
		// this purchase, in which case the purchase itself is the new anchor.
		end = addYears(Math.max(orderMs, end), perPurchase);
	}

	end = addYears(end, wholeYears(bonusYears));
	return Number.isFinite(end) ? end : null;
};

/**
 * The instant a release must be published at or before to be eligible: the
 * window end plus the skew grace. This is the ONLY place the grace is added.
 */
export const updatesCutoffMs = (
	windowEndMs: number,
	config: UpdatesWindowConfig = UPDATES_WINDOW
): number => windowEndMs + config.skewGraceMs;

/**
 * Whether the lifetime updates window governs this plan at all.
 *
 * Only a desktop-license holder with NO active recurring plan. A lifetime owner
 * who later subscribes to Plus/Pro/Max/Teams/Teams Lite/Business resolves to that plan
 * (`resolveEntitlement` in `plans.ts` gives a subscription precedence over a license),
 * and an actively-paying subscriber must never be pinned to old builds or
 * upsold a licence they already have.
 */
export const updatesWindowApplies = (plan: PlanId | null): boolean =>
	plan === "desktop-license";

/** Why a release is (or is not) offered to this owner. */
export type UpdatesEligibilityReason =
	| "no-window"
	| "outside-window"
	| "unknown-release-date"
	| "within-window";

/** Inputs to the pure release-eligibility decision. All times are epoch ms. */
export interface UpdatesEligibilityInput {
	/**
	 * The GRACE-INCLUSIVE cutoff from {@link updatesCutoffMs}, or null when no
	 * window applies. Already includes the skew grace — do not add it again.
	 */
	readonly cutoffMs: number | null;
	/** Now, in epoch ms. Injected so the decision is deterministic in tests. */
	readonly nowMs: number;
	/** When the candidate release was published, or null when unknown. */
	readonly releasePublishedAtMs: number | null;
}

/** The resolved release-eligibility verdict. */
export interface UpdatesEligibilityVerdict {
	/** Whether this release may be offered and installed. */
	readonly eligible: boolean;
	readonly reason: UpdatesEligibilityReason;
	/**
	 * True when the window has already closed. Drives the renew prompt — and
	 * NOTHING else: it never revokes access.
	 */
	readonly windowLapsed: boolean;
}

/**
 * Decide whether one release may be offered to a lifetime owner. Pure and
 * deterministic (inject `nowMs`), mirroring `decideDesktopAccess`
 * (`plan-desktop-gate.ts`).
 *
 * Precedence:
 *  1. No usable cutoff              → eligible ("no-window"). FAIL OPEN.
 *  2. Otherwise note whether the window has lapsed; every verdict carries it.
 *  3. Unknown publish date          → eligible ("unknown-release-date"). FAIL OPEN.
 *  4. Published at or before cutoff → eligible ("within-window"), else withheld.
 *
 * Both fail-open branches are load-bearing: a missing window or one malformed
 * release must never stop an owner updating. The boundary at (4) is inclusive
 * and the lapse test at (2) is strict, both in the owner's favour.
 */
export const decideUpdateEligibility = (
	input: UpdatesEligibilityInput
): UpdatesEligibilityVerdict => {
	const { cutoffMs, nowMs, releasePublishedAtMs } = input;

	// 1) No window (or an unparseable one) governs this user at all.
	if (cutoffMs === null || !Number.isFinite(cutoffMs)) {
		return { eligible: true, reason: "no-window", windowLapsed: false };
	}

	// 2) Computed once so the prompt state is consistent across every branch.
	const windowLapsed = nowMs > cutoffMs;

	// 3) A release whose publish date we could not read is never withheld.
	if (releasePublishedAtMs === null || !Number.isFinite(releasePublishedAtMs)) {
		return { eligible: true, reason: "unknown-release-date", windowLapsed };
	}

	// 4) The actual comparison the whole window exists for.
	const eligible = releasePublishedAtMs <= cutoffMs;
	return {
		eligible,
		reason: eligible ? "within-window" : "outside-window",
		windowLapsed,
	};
};
