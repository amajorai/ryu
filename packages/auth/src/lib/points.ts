/**
 * Points economy — the pure, server-authoritative math for XP levels and the
 * daily-rollup point awards (epic: Profiles, Usage Metrics & Points Economy;
 * see `docs/profiles-usage-points-spec.md` §6).
 *
 * Two SEPARATE numbers live on `UserStats` (never conflate them):
 *  - `xp` — never decreases, drives `level` + heatmap prestige. Cosmetic.
 *  - `pointsBalance` — spendable; decreases when a feature is unlocked.
 * Both grow by the same positive award deltas; only points shrink on spend.
 *
 * NOTHING HARDCODED downstream: every earn rate/cap lives ONLY here, exactly
 * like the plan pricing lives only in `plans.ts`. The API ingest step (which
 * owns the DB writes) calls these pure helpers, then appends the returned
 * awards to `PointsLedger` idempotently by `refId` — a re-sent daily rollup
 * therefore never double-awards. This module performs NO DB writes.
 */

/* -------------------------------------------------------------------------- *
 * Level / XP curve (implemented VERBATIM from the type contract).
 *
 * levelForXp(xp) = floor(sqrt(xp / 50));  xpForLevel(l) = 50 * l^2.
 * They are exact inverses at the thresholds: xpForLevel(levelForXp(xp)) is the
 * XP that opened the user's current level.
 * -------------------------------------------------------------------------- */

/** XP required to reach the START of the curve; the divisor in the level fn. */
const XP_PER_LEVEL_UNIT = 50;

/** The level a given lifetime XP total maps to (0-based, cosmetic). */
export const levelForXp = (xp: number): number =>
	Math.floor(Math.sqrt(Math.max(xp, 0) / XP_PER_LEVEL_UNIT));

/** The minimum lifetime XP needed to reach `level`. */
export const xpForLevel = (level: number): number =>
	XP_PER_LEVEL_UNIT * level * level;

/* -------------------------------------------------------------------------- *
 * Earn rules (server-side only — never trust the client). Spec §6.1.
 * -------------------------------------------------------------------------- */

/** Points for being active at all on a given day (once/day, idempotent). */
export const POINTS_DAILY_ACTIVE = 10;
/** Token block size that earns points; +POINTS_PER_TOKEN_BLOCK per block. */
export const TOKENS_PER_POINT_BLOCK = 100_000;
/** Points awarded per whole {@link TOKENS_PER_POINT_BLOCK} processed. */
export const POINTS_PER_TOKEN_BLOCK = 5;
/** Daily cap on token-based points, to blunt farming. */
export const POINTS_TOKEN_DAILY_CAP = 100;
/** Per streak-day points, multiplied by min(streak, {@link STREAK_POINTS_CAP_DAYS}). */
export const POINTS_PER_STREAK_DAY = 2;
/** Streak length past which the per-day bonus stops growing. */
export const STREAK_POINTS_CAP_DAYS = 7;
/** Points for a converted referral (reason `referral`). */
export const POINTS_REFERRAL = 200;
/** Milestone award bounds (reason `milestone`); the exact value is per-milestone. */
export const POINTS_MILESTONE_MIN = 50;
export const POINTS_MILESTONE_MAX = 500;

/**
 * The reasons a `PointsLedger` row may carry. Mirrors the `@ryu/db`
 * `PointsLedger.reason` enum; kept as a local literal so this pure module has
 * no runtime dependency on the DB layer (same discipline as the pure
 * `waitlist-queue` helpers).
 */
export const POINTS_REASONS = [
	"usage_daily",
	"milestone",
	"streak_bonus",
	"referral",
	"unlock_spend",
	"admin_adjust",
	"paid_grant",
] as const;
export type PointsReason = (typeof POINTS_REASONS)[number];

/**
 * A single computed award, ready for the API layer to append to `PointsLedger`
 * (which fills in `balanceAfter`). `refId` is the idempotency key: the unique
 * partial index on `{ reason, refId }` guarantees at-most-once application, so
 * re-sending the same daily rollup is a no-op.
 */
export interface PointAward {
	readonly delta: number;
	readonly meta?: Record<string, unknown>;
	readonly reason: PointsReason;
	readonly refId: string;
}

/** Inputs to the daily-rollup award computation (all server-derived). */
export interface DailyRollupInput {
	/** UTC day, "YYYY-MM-DD". */
	readonly day: string;
	/**
	 * The user's CURRENT streak length in days AFTER this day is counted (spec:
	 * `UserStats.streak.current`). Drives the streak bonus.
	 */
	readonly streak: number;
	/** Total tokens (input + output) processed that day. */
	readonly tokens: number;
	/** Better Auth user id the rollup belongs to. */
	readonly userId: string;
}

/**
 * The daily-active award. refId is exactly `${userId}:${day}` (per the earn
 * contract) so a re-sent rollup for the same day cannot re-award it.
 */
export const dailyActiveAward = (userId: string, day: string): PointAward => ({
	delta: POINTS_DAILY_ACTIVE,
	reason: "usage_daily",
	refId: `${userId}:${day}`,
});

/**
 * The token-based award for a day, capped daily. Returns null when the day
 * processed less than one whole block (no award). refId is suffixed `:tokens`
 * so it coexists with (never collides with) the daily-active row under the
 * shared `usage_daily` reason.
 */
export const tokenAward = (
	userId: string,
	day: string,
	tokens: number
): PointAward | null => {
	const blocks = Math.floor(Math.max(tokens, 0) / TOKENS_PER_POINT_BLOCK);
	if (blocks <= 0) {
		return null;
	}
	const delta = Math.min(
		blocks * POINTS_PER_TOKEN_BLOCK,
		POINTS_TOKEN_DAILY_CAP
	);
	return {
		delta,
		reason: "usage_daily",
		refId: `${userId}:${day}:tokens`,
		meta: { tokens, blocks },
	};
};

/**
 * The streak-day bonus: +{@link POINTS_PER_STREAK_DAY} × min(streak, cap).
 * Returns null for a non-positive streak. Distinct `streak_bonus` reason, so
 * the refId can reuse `${userId}:${day}` without colliding with usage rows.
 */
export const streakAward = (
	userId: string,
	day: string,
	streak: number
): PointAward | null => {
	if (streak <= 0) {
		return null;
	}
	const effective = Math.min(streak, STREAK_POINTS_CAP_DAYS);
	return {
		delta: POINTS_PER_STREAK_DAY * effective,
		reason: "streak_bonus",
		refId: `${userId}:${day}`,
		meta: { streak },
	};
};

/**
 * Compute every point award earned by a single daily rollup: daily-active,
 * token-based (capped), and the streak bonus. Pure — the API ingest step
 * appends the results to `PointsLedger` idempotently by `refId` and folds the
 * total into `UserStats.pointsBalance` (+ `xp`). Zero-value awards are omitted.
 */
export const computeDailyRollupAwards = (
	input: DailyRollupInput
): PointAward[] => {
	const { userId, day, tokens, streak } = input;
	const awards: PointAward[] = [dailyActiveAward(userId, day)];
	const tokens_ = tokenAward(userId, day, tokens);
	if (tokens_) {
		awards.push(tokens_);
	}
	const streak_ = streakAward(userId, day, streak);
	if (streak_) {
		awards.push(streak_);
	}
	return awards;
};

/** Sum of an award list's deltas — the XP gained (and net points, pre-spend). */
export const totalAwardDelta = (awards: readonly PointAward[]): number =>
	awards.reduce((sum, award) => sum + award.delta, 0);
