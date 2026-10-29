import { describe, expect, it } from "bun:test";
import {
	computeDailyActivityAwards,
	computeDailyRollupAwards,
	dailyActiveAward,
	levelForXp,
	METERED_SPEND_MICRO_USD_PER_TOKEN_POINT,
	meteredTokenAwards,
	meteredTokenBlocks,
	meteredTokenRefId,
	POINTS_DAILY_ACTIVE,
	POINTS_PER_STREAK_DAY,
	POINTS_PER_TOKEN_BLOCK,
	POINTS_TOKEN_DAILY_CAP,
	STREAK_POINTS_CAP_DAYS,
	streakAward,
	TOKENS_PER_POINT_BLOCK,
	tokenAward,
	totalAwardDelta,
	xpForLevel,
} from "./points.ts";

describe("levelForXp / xpForLevel curve", () => {
	it("levelForXp is floor(sqrt(xp / 50))", () => {
		expect(levelForXp(0)).toBe(0);
		expect(levelForXp(49)).toBe(0);
		expect(levelForXp(50)).toBe(1);
		expect(levelForXp(199)).toBe(1);
		expect(levelForXp(200)).toBe(2);
		expect(levelForXp(450)).toBe(3);
	});

	it("clamps negative xp to level 0", () => {
		expect(levelForXp(-100)).toBe(0);
	});

	it("xpForLevel is 50 * level^2", () => {
		expect(xpForLevel(0)).toBe(0);
		expect(xpForLevel(1)).toBe(50);
		expect(xpForLevel(2)).toBe(200);
		expect(xpForLevel(3)).toBe(450);
	});

	it("xpForLevel and levelForXp are exact inverses at thresholds", () => {
		for (let level = 0; level <= 20; level++) {
			expect(levelForXp(xpForLevel(level))).toBe(level);
		}
	});

	it("one xp below a threshold is still the previous level", () => {
		for (let level = 1; level <= 20; level++) {
			expect(levelForXp(xpForLevel(level) - 1)).toBe(level - 1);
		}
	});
});

describe("dailyActiveAward", () => {
	it("awards the flat daily-active points with a per-user-per-day refId", () => {
		const award = dailyActiveAward("u1", "2026-07-22");
		expect(award).toEqual({
			delta: POINTS_DAILY_ACTIVE,
			reason: "usage_daily",
			refId: "u1:2026-07-22",
		});
	});

	it("produces a stable refId so a re-sent rollup is idempotent", () => {
		expect(dailyActiveAward("u1", "2026-07-22").refId).toBe(
			dailyActiveAward("u1", "2026-07-22").refId
		);
	});
});

describe("tokenAward", () => {
	it("returns null below one whole token block", () => {
		expect(tokenAward("u1", "d", 0)).toBeNull();
		expect(tokenAward("u1", "d", TOKENS_PER_POINT_BLOCK - 1)).toBeNull();
	});

	it("awards points per whole block", () => {
		const award = tokenAward("u1", "d", TOKENS_PER_POINT_BLOCK * 3);
		expect(award?.delta).toBe(POINTS_PER_TOKEN_BLOCK * 3);
		expect(award?.reason).toBe("usage_daily");
		expect(award?.meta).toEqual({
			tokens: TOKENS_PER_POINT_BLOCK * 3,
			blocks: 3,
		});
	});

	it("caps the token award at the daily cap", () => {
		const hugeTokens = TOKENS_PER_POINT_BLOCK * 10_000;
		const award = tokenAward("u1", "d", hugeTokens);
		expect(award?.delta).toBe(POINTS_TOKEN_DAILY_CAP);
	});

	it("suffixes the refId with :tokens so it never collides with the active award", () => {
		const award = tokenAward("u1", "2026-07-22", TOKENS_PER_POINT_BLOCK);
		expect(award?.refId).toBe("u1:2026-07-22:tokens");
		expect(award?.refId).not.toBe(dailyActiveAward("u1", "2026-07-22").refId);
	});

	it("treats negative tokens as zero (no award)", () => {
		expect(tokenAward("u1", "d", -5000)).toBeNull();
	});
});

describe("streakAward", () => {
	it("returns null for a non-positive streak", () => {
		expect(streakAward("u1", "d", 0)).toBeNull();
		expect(streakAward("u1", "d", -3)).toBeNull();
	});

	it("awards per-streak-day points below the cap", () => {
		const award = streakAward("u1", "d", 3);
		expect(award?.delta).toBe(POINTS_PER_STREAK_DAY * 3);
		expect(award?.reason).toBe("streak_bonus");
		expect(award?.meta).toEqual({ streak: 3 });
	});

	it("clamps the streak multiplier at the cap", () => {
		const award = streakAward("u1", "d", STREAK_POINTS_CAP_DAYS + 50);
		expect(award?.delta).toBe(POINTS_PER_STREAK_DAY * STREAK_POINTS_CAP_DAYS);
	});

	it("uses the plain user:day refId (distinct reason avoids collision)", () => {
		expect(streakAward("u1", "2026-07-22", 1)?.refId).toBe("u1:2026-07-22");
	});
});

describe("computeDailyRollupAwards", () => {
	it("always includes the daily-active award", () => {
		const awards = computeDailyRollupAwards({
			userId: "u1",
			day: "d",
			tokens: 0,
			streak: 0,
		});
		expect(awards).toHaveLength(1);
		expect(awards[0]?.reason).toBe("usage_daily");
		expect(awards[0]?.delta).toBe(POINTS_DAILY_ACTIVE);
	});

	it("omits zero-value token and streak awards", () => {
		const awards = computeDailyRollupAwards({
			userId: "u1",
			day: "d",
			tokens: TOKENS_PER_POINT_BLOCK - 1,
			streak: 0,
		});
		expect(awards.map((a) => a.reason)).toEqual(["usage_daily"]);
	});

	it("combines active, token, and streak awards when all earn", () => {
		const awards = computeDailyRollupAwards({
			userId: "u1",
			day: "d",
			tokens: TOKENS_PER_POINT_BLOCK * 2,
			streak: 4,
		});
		const reasons = awards.map((a) => a.reason);
		expect(reasons).toContain("usage_daily"); // active
		expect(reasons.filter((r) => r === "usage_daily")).toHaveLength(2); // active + token
		expect(reasons).toContain("streak_bonus");
	});

	it("keeps every (reason, refId) idempotency key unique within one rollup", () => {
		const awards = computeDailyRollupAwards({
			userId: "u1",
			day: "2026-07-22",
			tokens: TOKENS_PER_POINT_BLOCK * 2,
			streak: 4,
		});
		// The ledger's uniqueness is on (reason, refId), NOT refId alone: the
		// active and streak awards deliberately reuse "u1:2026-07-22" but carry
		// distinct reasons, while the token award suffixes ":tokens".
		const keys = awards.map((a) => `${a.reason}|${a.refId}`);
		expect(new Set(keys).size).toBe(keys.length);
	});
});

describe("totalAwardDelta", () => {
	it("sums the deltas of an award list", () => {
		const awards = computeDailyRollupAwards({
			userId: "u1",
			day: "d",
			tokens: TOKENS_PER_POINT_BLOCK,
			streak: 2,
		});
		const expected =
			POINTS_DAILY_ACTIVE + POINTS_PER_TOKEN_BLOCK + POINTS_PER_STREAK_DAY * 2;
		expect(totalAwardDelta(awards)).toBe(expected);
	});

	it("returns zero for an empty list", () => {
		expect(totalAwardDelta([])).toBe(0);
	});
});

/** Spend that backs exactly `blocks` token blocks. */
const spendFor = (blocks: number): number =>
	blocks * POINTS_PER_TOKEN_BLOCK * METERED_SPEND_MICRO_USD_PER_TOKEN_POINT;

describe("computeDailyActivityAwards", () => {
	it("pays daily-active and streak, and never a token award", () => {
		const awards = computeDailyActivityAwards({
			userId: "u1",
			day: "2026-07-22",
			streak: 3,
		});
		expect(awards.map((a) => a.refId)).toEqual([
			"u1:2026-07-22",
			"u1:2026-07-22",
		]);
		expect(totalAwardDelta(awards)).toBe(
			POINTS_DAILY_ACTIVE + POINTS_PER_STREAK_DAY * 3
		);
	});
});

describe("meteredTokenBlocks", () => {
	it("needs both the tokens and the charged spend for each block", () => {
		// Plenty of tokens, no charge: a reporter-inflated count earns nothing.
		expect(
			meteredTokenBlocks({
				tokens: TOKENS_PER_POINT_BLOCK * 50,
				spendMicroUsd: 0,
			})
		).toBe(0);
		// A tiny charge does not unlock a huge token claim.
		expect(
			meteredTokenBlocks({
				tokens: TOKENS_PER_POINT_BLOCK * 50,
				spendMicroUsd: spendFor(2),
			})
		).toBe(2);
		// Spend without tokens earns nothing either.
		expect(meteredTokenBlocks({ tokens: 0, spendMicroUsd: spendFor(10) })).toBe(
			0
		);
		expect(
			meteredTokenBlocks({
				tokens: TOKENS_PER_POINT_BLOCK * 3,
				spendMicroUsd: spendFor(3) - 1,
			})
		).toBe(2);
	});

	it("is capped at the daily token cap", () => {
		expect(
			meteredTokenBlocks({
				tokens: TOKENS_PER_POINT_BLOCK * 10_000,
				spendMicroUsd: spendFor(10_000),
			}) * POINTS_PER_TOKEN_BLOCK
		).toBe(POINTS_TOKEN_DAILY_CAP);
	});

	it("treats negative and non-finite inputs as nothing", () => {
		expect(meteredTokenBlocks({ tokens: -1, spendMicroUsd: -1 })).toBe(0);
		expect(
			meteredTokenBlocks({
				tokens: Number.POSITIVE_INFINITY,
				spendMicroUsd: Number.NaN,
			})
		).toBe(0);
	});

	it("keeps the payout below a quarter of the spend at the best store rate", () => {
		// The store's best credit rate is $25 for 2,200 points.
		const microUsdPerPoint = 25_000_000 / 2200;
		const blocks = meteredTokenBlocks({
			tokens: TOKENS_PER_POINT_BLOCK * 20,
			spendMicroUsd: spendFor(20),
		});
		const payout = blocks * POINTS_PER_TOKEN_BLOCK * microUsdPerPoint;
		expect(payout / spendFor(20)).toBeLessThan(0.25);
	});
});

describe("meteredTokenAwards", () => {
	it("emits one award per block under stable, distinct refIds", () => {
		const usage = {
			tokens: TOKENS_PER_POINT_BLOCK * 3,
			spendMicroUsd: spendFor(3),
		};
		const awards = meteredTokenAwards("u1", "2026-07-22", usage);
		expect(awards.map((a) => a.refId)).toEqual([
			meteredTokenRefId("u1", "2026-07-22", 1),
			meteredTokenRefId("u1", "2026-07-22", 2),
			meteredTokenRefId("u1", "2026-07-22", 3),
		]);
		expect(awards.every((a) => a.reason === "usage_daily")).toBe(true);
		expect(totalAwardDelta(awards)).toBe(POINTS_PER_TOKEN_BLOCK * 3);
		// Never collides with the legacy reported-token award or daily-active.
		expect(awards.map((a) => a.refId)).not.toContain("u1:2026-07-22:tokens");
		expect(awards.map((a) => a.refId)).not.toContain("u1:2026-07-22");
	});

	it("re-evaluating a grown day only adds the new blocks' refIds", () => {
		const early = meteredTokenAwards("u1", "d", {
			tokens: TOKENS_PER_POINT_BLOCK,
			spendMicroUsd: spendFor(1),
		});
		const later = meteredTokenAwards("u1", "d", {
			tokens: TOKENS_PER_POINT_BLOCK * 2,
			spendMicroUsd: spendFor(2),
		});
		expect(later.slice(0, early.length).map((a) => a.refId)).toEqual(
			early.map((a) => a.refId)
		);
		expect(later).toHaveLength(2);
	});
});
