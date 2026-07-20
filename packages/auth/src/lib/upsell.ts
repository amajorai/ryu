/**
 * The conversion upsell engine (free-tier gating plan, 2026-07-11 addendum).
 *
 * A PURE, deterministic metric selector that mirrors `decideDesktopAccess`'s
 * idiom: injected clock, config-not-literals, unit-tested with usage fixtures.
 * The control plane computes WHAT to show (this file); the client decides WHEN
 * (show-cadence). Given the same usage snapshot + weights + clock it always
 * returns the same ranked cards, so it is reproducible and tunable.
 *
 * Three psychology levers, scored and ranked, returned lever-diverse:
 *  1. INVESTMENT / sunk-cost (magnitude) — "You've started N conversations."
 *  2. FRICTION / loss-aversion (cap-proximity) — "You hit the {cap} limit N×."
 *  3. FEATURE-DESIRE (gated-attempts) — "You reached for {feature} N×."
 *
 * Phasing: V1 implements the INVESTMENT lever fully (fed entirely by today's
 * `userStats` / `userUsageDaily`). The friction + desire branches are wired but
 * read `capHits` / `gatedAttempts`, which do not exist as events yet — they
 * default to empty and yield nothing, so V2 lights them up with ZERO rewrite of
 * this selector. Auto-optimization (bandit / A-B on the weights) is explicitly
 * future: same selector, weights learned instead of hand-set.
 *
 * Open-core note: this is closed-product marketing logic — it belongs in the
 * control plane, never in OSS core/gateway.
 */

/** The psychology lever a card appeals to. */
export type UpsellLever = "investment" | "friction" | "desire";

/**
 * A snapshot of one user's recent usage, drawn from the fields that already
 * exist on `userStats` / `userUsageDaily`. The V2-only maps (`capHits`,
 * `gatedAttempts`) are optional and default to empty; when absent the friction +
 * desire levers produce no cards.
 */
export interface UsageSnapshot {
	/** Seconds of agent runtime accrued (investment magnitude). */
	readonly agentSeconds: number;
	/** Optional per-feature usage counts (available today; future scoring). */
	readonly byFeature?: Readonly<Record<string, number>>;
	/** Optional per-plugin usage counts (available today; future scoring). */
	readonly byPlugin?: Readonly<Record<string, number>>;
	/** Optional per-skill usage counts (available today; future scoring). */
	readonly bySkill?: Readonly<Record<string, number>>;
	/**
	 * V2-only: how many times each numeric cap rejected the user this period,
	 * keyed by cap field. Empty (default) until the cap-hit events ship → the
	 * FRICTION lever stays silent.
	 */
	readonly capHits?: Readonly<Record<string, number>>;
	/**
	 * V2-only: how many times the user reached for each gated capability and was
	 * blocked, keyed by capability. Empty (default) until the gated-attempt events
	 * ship → the DESIRE lever stays silent.
	 */
	readonly gatedAttempts?: Readonly<Record<string, number>>;
	/** Total gateway/model requests made (investment magnitude). */
	readonly requestCount: number;
	/**
	 * Sessions STARTED (framed to the user as "conversations"). This counts starts,
	 * not completions — do NOT add a completion counter.
	 */
	readonly sessionCount: number;
	/** Consecutive-day streak (available today; reserved for future scoring). */
	readonly streakDays: number;
}

/** One rendered upsell pitch card. */
export interface UpsellCard {
	/** The rendered pitch headline. */
	readonly headline: string;
	/** Stable id (usage-derived, NOT time-derived) so the same card is dedupable. */
	readonly id: string;
	/** Which psychology lever this card appeals to (drives lever-diversity). */
	readonly lever: UpsellLever;
	/** The metric key the card is built from (e.g. "conversations", a cap name). */
	readonly metric: string;
	/** A short supporting line under the headline. */
	readonly subtext: string;
	/** The magnitude shown in the headline (conversations, hours, hits, …). */
	readonly value: number;
}

/** Tunable weights for the investment lever's scoring. */
export interface InvestmentWeights {
	/** Divisor turning a raw magnitude into a minor score tiebreak. */
	readonly magnitudeDivisor: number;
	/** Score added per milestone the metric has crossed. */
	readonly milestoneBonus: number;
	/** The ascending milestones a metric can cross (e.g. 100 / 500 / 1000). */
	readonly milestones: readonly number[];
}

/** All selector weights, as one swappable config (never inline literals). */
export interface UpsellWeights {
	/** Feature-desire lever weights. */
	readonly desire: {
		/** Score added per gated-feature attempt. */
		readonly perGatedAttempt: number;
	};
	/** Friction / loss-aversion lever weights. */
	readonly friction: {
		/** Score added per cap-hit event. */
		readonly perCapHit: number;
	};
	/** Investment / sunk-cost lever weights. */
	readonly investment: InvestmentWeights;
	/** Max cards to return (top-N after ranking). */
	readonly maxCards: number;
	/** A card scoring below this is dropped (weak usage → no card). */
	readonly minScore: number;
}

/**
 * The default selector weights. Milestones at 100 / 500 / 1000 apply uniformly to
 * every investment metric; the milestone bonus dominates, own-magnitude is a
 * minor tiebreak. `minScore` is set so a metric must cross at least one milestone
 * to surface (raw magnitude alone rarely qualifies) — this is the "weak usage →
 * no cards" guarantee. All hand-set now; learned later (V-future), same selector.
 */
export const UPSELL_WEIGHTS: UpsellWeights = {
	investment: {
		milestones: [100, 500, 1000],
		milestoneBonus: 10,
		magnitudeDivisor: 1000,
	},
	friction: { perCapHit: 8 },
	desire: { perGatedAttempt: 12 },
	minScore: 5,
	maxCards: 3,
};

/** One scored candidate before ranking. */
interface ScoredCard {
	readonly card: UpsellCard;
	readonly score: number;
}

const SECONDS_PER_HOUR = 3600;

/** How many of `milestones` the value has reached or passed. */
const milestonesCrossed = (
	value: number,
	milestones: readonly number[]
): number => milestones.filter((m) => value >= m).length;

/** The investment score for a raw magnitude under the given weights. */
const investmentScore = (value: number, w: InvestmentWeights): number =>
	milestonesCrossed(value, w.milestones) * w.milestoneBonus +
	value / w.magnitudeDivisor;

/**
 * Build the INVESTMENT candidates from the three magnitude metrics. Each metric
 * yields a card only when its value is positive; scoring is shared so the three
 * rank against one another consistently.
 */
const investmentCandidates = (
	snapshot: UsageSnapshot,
	w: InvestmentWeights
): ScoredCard[] => {
	const out: ScoredCard[] = [];

	if (snapshot.sessionCount > 0) {
		const count = snapshot.sessionCount;
		out.push({
			score: investmentScore(count, w),
			card: {
				id: "investment-conversations",
				lever: "investment",
				metric: "conversations",
				value: count,
				headline: `You've started ${count.toLocaleString()} conversations`,
				subtext: "All that context lives in Ryu — keep it working for you.",
			},
		});
	}

	// Only surface agent-time once it rounds to a whole hour or more — a "0 hours"
	// pitch reads as broken, and sub-hour runtimes are not a real investment hook.
	const agentHours = Math.round(snapshot.agentSeconds / SECONDS_PER_HOUR);
	if (agentHours >= 1) {
		out.push({
			// Score off raw seconds (the true magnitude); display in hours.
			score: investmentScore(snapshot.agentSeconds, w),
			card: {
				id: "investment-agent-time",
				lever: "investment",
				metric: "agent-time",
				value: agentHours,
				headline: `Your agents have worked ${agentHours.toLocaleString()} hours for you`,
				subtext: "Give them room to run — unlock parallel background runs.",
			},
		});
	}

	if (snapshot.requestCount > 0) {
		const count = snapshot.requestCount;
		out.push({
			score: investmentScore(count, w),
			card: {
				id: "investment-requests",
				lever: "investment",
				metric: "requests",
				value: count,
				headline: `You've made ${count.toLocaleString()} requests`,
				subtext: "You're getting real work done — keep the momentum on Pro.",
			},
		});
	}

	return out;
};

/**
 * Build FRICTION candidates from the V2 `capHits` map. Empty today → yields
 * nothing, so the lever stays silent until the cap-hit events ship.
 */
const frictionCandidates = (
	snapshot: UsageSnapshot,
	perCapHit: number
): ScoredCard[] => {
	const out: ScoredCard[] = [];
	for (const [cap, hits] of Object.entries(snapshot.capHits ?? {})) {
		if (hits > 0) {
			out.push({
				score: hits * perCapHit,
				card: {
					id: `friction-${cap}`,
					lever: "friction",
					metric: cap,
					value: hits,
					headline: `You hit the ${cap} limit ${hits}× this week`,
					subtext: "Upgrade to Pro and this limit goes away.",
				},
			});
		}
	}
	return out;
};

/**
 * Build DESIRE candidates from the V2 `gatedAttempts` map. Empty today → yields
 * nothing, so the lever stays silent until the gated-attempt events ship.
 */
const desireCandidates = (
	snapshot: UsageSnapshot,
	perGatedAttempt: number
): ScoredCard[] => {
	const out: ScoredCard[] = [];
	for (const [feature, attempts] of Object.entries(
		snapshot.gatedAttempts ?? {}
	)) {
		if (attempts > 0) {
			out.push({
				score: attempts * perGatedAttempt,
				card: {
					id: `desire-${feature}`,
					lever: "desire",
					metric: feature,
					value: attempts,
					headline: `You reached for ${feature} ${attempts}×`,
					subtext: "It's one upgrade away.",
				},
			});
		}
	}
	return out;
};

/**
 * Rank and pick the final cards: filter below-threshold, sort by score, then a
 * lever-diversity pass (best card per lever first) followed by a fill pass, and
 * finally re-sort by score for display. Returns at most `maxCards`; may return
 * fewer (or none) when usage is weak.
 */
const rank = (candidates: ScoredCard[], w: UpsellWeights): UpsellCard[] => {
	const eligible = candidates
		.filter((c) => c.score >= w.minScore)
		.sort((a, b) => b.score - a.score);

	const chosen: ScoredCard[] = [];
	const leversUsed = new Set<UpsellLever>();

	// Diversity pass: one best-scoring card per lever, in score order.
	for (const c of eligible) {
		if (chosen.length >= w.maxCards) {
			break;
		}
		if (!leversUsed.has(c.card.lever)) {
			chosen.push(c);
			leversUsed.add(c.card.lever);
		}
	}

	// Fill pass: top up remaining slots by score regardless of lever (so a single
	// dominant lever — e.g. investment-only in V1 — still returns 2-3 cards).
	for (const c of eligible) {
		if (chosen.length >= w.maxCards) {
			break;
		}
		if (!chosen.includes(c)) {
			chosen.push(c);
		}
	}

	return chosen.sort((a, b) => b.score - a.score).map((c) => c.card);
};

/**
 * Select the top 2-3 conversion cards for a usage snapshot. PURE and
 * deterministic — inject `nowMs` (the clock) so tests are reproducible; the
 * client recomputes this at show-time from live stats, so the cards shift
 * naturally week to week as usage changes (no weekly recompute job).
 *
 * V1 surfaces only the INVESTMENT lever (the friction + desire branches are wired
 * but silent until their V2 events exist). Weak usage yields few or no cards.
 */
export const selectUpsellCards = (
	snapshot: UsageSnapshot,
	weights: UpsellWeights,
	nowMs: number
): UpsellCard[] => {
	if (!Number.isFinite(nowMs)) {
		throw new Error("selectUpsellCards: nowMs must be a finite timestamp");
	}

	const candidates: ScoredCard[] = [
		...investmentCandidates(snapshot, weights.investment),
		...frictionCandidates(snapshot, weights.friction.perCapHit),
		...desireCandidates(snapshot, weights.desire.perGatedAttempt),
	];

	return rank(candidates, weights);
};
