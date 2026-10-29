import { describe, expect, it } from "bun:test";
import {
	APPLY_CLOSE_BEFORE_MS,
	APPLY_LEAD_MAX_MS,
	APPLY_LEAD_MIN_MS,
	addInterval,
	classifyMigration,
	decisionById,
	decisionFor,
	decisionProblems,
	GRANDFATHERING_DECISIONS,
	type GrandfatheringDecision,
	MIGRATION_DUST_CAP_MICRO_USD,
	type MovingPolicy,
	migrationScheduleFor,
	rowsWithoutDecision,
} from "./plan-grandfathering.ts";
import { decisionHash, termsHash } from "./plan-terms.ts";
import { PLAN_VERSIONS, type PlanVersion } from "./plans.ts";

const DAY = 24 * 3_600_000;
const at = (iso: string) => new Date(iso);

const active = (
	currentPeriodEnd: string | null,
	interval: "monthly" | "yearly" = "monthly"
) => ({
	cancelAtPeriodEnd: false,
	currentPeriodEnd: currentPeriodEnd ? at(currentPeriodEnd) : null,
	interval,
	pendingUpdate: false,
	status: "active",
});

const renewal30: MovingPolicy = { kind: "next_renewal", noticeDays: 30 };

const effective = (result: ReturnType<typeof migrationScheduleFor>) => {
	if ("skip" in result) {
		throw new Error(`unexpected skip ${result.skip}`);
	}
	return result;
};

describe("addInterval", () => {
	it("clamps the day like a renewal does", () => {
		expect(
			addInterval(at("2027-01-31T09:00:00Z"), "monthly", 1).toISOString()
		).toBe("2027-02-28T09:00:00.000Z");
		expect(
			addInterval(at("2028-01-31T09:00:00Z"), "monthly", 1).toISOString()
		).toBe("2028-02-29T09:00:00.000Z");
		expect(
			addInterval(at("2028-02-29T00:00:00Z"), "yearly", 1).toISOString()
		).toBe("2029-02-28T00:00:00.000Z");
		expect(
			addInterval(at("2027-03-31T00:00:00Z"), "monthly", -1).toISOString()
		).toBe("2027-02-28T00:00:00.000Z");
		expect(
			addInterval(at("2026-12-15T00:00:00Z"), "monthly", 2).toISOString()
		).toBe("2027-02-15T00:00:00.000Z");
	});
});

describe("migrationScheduleFor", () => {
	it("next_renewal: a renewal inside the notice window moves to the following one", () => {
		const result = effective(
			migrationScheduleFor({
				intervalDeltaMicroUsd: 10_000_000,
				noticeAt: at("2026-10-20T00:00:00Z"),
				policy: renewal30,
				sub: active("2026-10-30T12:00:00Z"),
			})
		);
		expect(result.effectiveAt.toISOString()).toBe("2026-11-30T12:00:00.000Z");
		expect(result.noticeBy.toISOString()).toBe("2026-10-31T12:00:00.000Z");
	});

	it("next_renewal: a renewal after the notice window is used as is", () => {
		const result = effective(
			migrationScheduleFor({
				intervalDeltaMicroUsd: 10_000_000,
				noticeAt: at("2026-10-20T00:00:00Z"),
				policy: renewal30,
				sub: active("2026-11-29T00:00:00Z"),
			})
		);
		expect(result.effectiveAt.toISOString()).toBe("2026-11-29T00:00:00.000Z");
	});

	it("respects notBefore", () => {
		const result = effective(
			migrationScheduleFor({
				intervalDeltaMicroUsd: 10_000_000,
				noticeAt: at("2026-10-20T00:00:00Z"),
				policy: {
					kind: "next_renewal",
					noticeDays: 30,
					notBefore: "2027-03-01",
				},
				sub: active("2026-11-29T00:00:00Z"),
			})
		);
		expect(result.effectiveAt.toISOString()).toBe("2027-03-29T00:00:00.000Z");
	});

	it("until: a yearly subscriber keeps the price for the term already paid", () => {
		const result = effective(
			migrationScheduleFor({
				intervalDeltaMicroUsd: 100_000_000,
				noticeAt: at("2026-10-20T00:00:00Z"),
				policy: { kind: "until", noticeDays: 30, until: "2027-01-01" },
				sub: active("2027-08-20T00:00:00Z", "yearly"),
			})
		);
		expect(result.effectiveAt.toISOString()).toBe("2027-08-20T00:00:00.000Z");
		// Yearly reminder 30 days ahead.
		expect(result.reminderAt?.toISOString()).toBe("2027-07-21T00:00:00.000Z");
	});

	it("until: a yearly renewal that cannot get its notice moves a full year", () => {
		const result = effective(
			migrationScheduleFor({
				intervalDeltaMicroUsd: 100_000_000,
				noticeAt: at("2026-12-20T00:00:00Z"),
				policy: { kind: "until", noticeDays: 30, until: "2027-01-01" },
				sub: active("2027-01-06T00:00:00Z", "yearly"),
			})
		);
		expect(result.effectiveAt.toISOString()).toBe("2028-01-06T00:00:00.000Z");
	});

	it("until: monthly moves at the first renewal after both the date and the notice", () => {
		const result = effective(
			migrationScheduleFor({
				intervalDeltaMicroUsd: 10_000_000,
				noticeAt: at("2026-10-20T00:00:00Z"),
				policy: { kind: "until", noticeDays: 30, until: "2027-02-01" },
				sub: active("2026-10-25T00:00:00Z"),
			})
		);
		expect(result.effectiveAt.toISOString()).toBe("2027-02-25T00:00:00.000Z");
	});

	it("never moves earlier than a date already promised", () => {
		const result = effective(
			migrationScheduleFor({
				intervalDeltaMicroUsd: 10_000_000,
				noticeAt: at("2026-10-20T00:00:00Z"),
				notEarlierThan: at("2027-01-01T00:00:00Z"),
				policy: renewal30,
				sub: active("2026-11-29T00:00:00Z"),
			})
		);
		expect(result.effectiveAt.toISOString()).toBe("2027-01-29T00:00:00.000Z");
	});

	it("skips subscriptions that should not be moved", () => {
		const base = {
			intervalDeltaMicroUsd: 1,
			noticeAt: at("2026-10-20T00:00:00Z"),
			policy: renewal30,
		};
		expect(
			migrationScheduleFor({
				...base,
				sub: { ...active("2026-12-01T00:00:00Z"), status: "canceled" },
			})
		).toEqual({ skip: "inactive" });
		expect(
			migrationScheduleFor({
				...base,
				sub: { ...active("2026-12-01T00:00:00Z"), cancelAtPeriodEnd: true },
			})
		).toEqual({ skip: "cancelling" });
		expect(
			migrationScheduleFor({
				...base,
				sub: { ...active("2026-12-01T00:00:00Z"), pendingUpdate: true },
			})
		).toEqual({ skip: "pending_update" });
		expect(migrationScheduleFor({ ...base, sub: active(null) })).toEqual({
			skip: "no_period_end",
		});
		// A trial's period end is its boundary.
		expect(
			"skip" in
				migrationScheduleFor({
					...base,
					sub: { ...active("2026-12-01T00:00:00Z"), status: "trialing" },
				})
		).toBe(false);
	});

	it("bounds the apply window by the proration dust cap", () => {
		const big = effective(
			migrationScheduleFor({
				intervalDeltaMicroUsd: 50_000_000,
				noticeAt: at("2026-10-20T00:00:00Z"),
				policy: renewal30,
				sub: active("2026-12-01T00:00:00Z"),
			})
		);
		expect(big.effectiveAt.getTime() - big.applyAfter.getTime()).toBe(
			APPLY_LEAD_MAX_MS
		);
		expect(big.prorationBoundMicroUsd).toBeLessThanOrEqual(
			MIGRATION_DUST_CAP_MICRO_USD
		);
		expect(big.applyBefore.getTime()).toBe(
			big.effectiveAt.getTime() - APPLY_CLOSE_BEFORE_MS
		);

		const none = effective(
			migrationScheduleFor({
				intervalDeltaMicroUsd: 0,
				noticeAt: at("2026-10-20T00:00:00Z"),
				policy: renewal30,
				sub: active("2026-12-01T00:00:00Z"),
			})
		);
		expect(none.effectiveAt.getTime() - none.applyAfter.getTime()).toBe(
			APPLY_LEAD_MAX_MS
		);
		expect(none.prorationBoundMicroUsd).toBe(0);

		const huge = effective(
			migrationScheduleFor({
				intervalDeltaMicroUsd: 100_000_000_000,
				noticeAt: at("2026-10-20T00:00:00Z"),
				policy: renewal30,
				sub: active("2026-12-01T00:00:00Z"),
			})
		);
		expect(huge.effectiveAt.getTime() - huge.applyAfter.getTime()).toBe(
			APPLY_LEAD_MIN_MS
		);
	});

	it("drops the reminder when there is no room for it", () => {
		const result = effective(
			migrationScheduleFor({
				intervalDeltaMicroUsd: 1,
				noticeAt: at("2026-10-20T00:00:00Z"),
				policy: { kind: "next_renewal", noticeDays: 5 },
				sub: active("2026-10-26T00:00:00Z"),
			})
		);
		expect(result.reminderAt).toBeNull();
	});

	it("holds its guarantees over random dates (property loop)", () => {
		let seed = 7;
		const random = () => {
			seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
			return seed / 2_147_483_648;
		};
		const start = at("2026-01-01T00:00:00Z").getTime();
		for (let i = 0; i < 2000; i++) {
			const interval = random() < 0.5 ? "monthly" : "yearly";
			const noticeAt = new Date(start + Math.floor(random() * 900) * DAY);
			const periodEnd = new Date(
				noticeAt.getTime() + Math.floor(random() * 400) * DAY + 3_600_000
			);
			const notEarlierThan =
				random() < 0.3
					? new Date(noticeAt.getTime() + Math.floor(random() * 200) * DAY)
					: null;
			const noticeDays = 30 + Math.floor(random() * 60);
			const policy: MovingPolicy =
				random() < 0.5
					? { kind: "next_renewal", noticeDays }
					: { kind: "until", noticeDays, until: "2027-06-30" };
			const result = effective(
				migrationScheduleFor({
					intervalDeltaMicroUsd: Math.floor(random() * 500_000_000),
					noticeAt,
					notEarlierThan,
					policy,
					sub: active(periodEnd.toISOString(), interval),
				})
			);
			const isPeriodEnd = Array.from({ length: 121 }, (_, k) =>
				addInterval(periodEnd, interval, k).getTime()
			).includes(result.effectiveAt.getTime());
			expect(isPeriodEnd).toBe(true);
			expect(
				result.effectiveAt.getTime() - noticeAt.getTime()
			).toBeGreaterThanOrEqual(noticeDays * DAY);
			if (notEarlierThan) {
				expect(result.effectiveAt.getTime()).toBeGreaterThanOrEqual(
					notEarlierThan.getTime()
				);
			}
			if (policy.kind === "until") {
				expect(result.effectiveAt.getTime()).toBeGreaterThanOrEqual(
					at("2027-06-30T00:00:00Z").getTime()
				);
			}
			expect(result.applyAfter.getTime()).toBeGreaterThanOrEqual(
				result.effectiveAt.getTime() - APPLY_LEAD_MAX_MS
			);
			expect(result.applyAfter.getTime()).toBeLessThanOrEqual(
				result.applyBefore.getTime()
			);
			expect(result.applyBefore.getTime()).toBeLessThan(
				result.effectiveAt.getTime()
			);
		}
	});
});

const versionRow = (plan: "business" | "pro", version: number): PlanVersion => {
	const found = PLAN_VERSIONS[plan].find(
		(candidate) => candidate.version === version
	);
	if (!found) {
		throw new Error(`${plan} v${version} missing`);
	}
	return found;
};

const row = (overrides: Partial<PlanVersion>): PlanVersion => ({
	...versionRow("business", 2),
	...overrides,
});

describe("classifyMigration", () => {
	it("is adverse when any seat count pays more, even if another pays less", () => {
		const from = row({});
		const to = row({
			seatPriceTiers: [
				{ fromSeats: 1, pricePerSeatMicroUsd: 55_000_000, toSeats: 5 },
				{ fromSeats: 6, pricePerSeatMicroUsd: 55_000_000, toSeats: 50 },
			],
			version: 3,
		});
		expect(classifyMigration("business", from, to)).toBe("adverse");
	});

	it("is adverse when the pool shrinks and favourable when only the pool grows", () => {
		const from = versionRow("pro", 6);
		expect(
			classifyMigration("pro", from, {
				...from,
				monthlyCreditPoolMicroUsd: 10_000_000,
			})
		).toBe("adverse");
		expect(
			classifyMigration("pro", from, {
				...from,
				monthlyCreditPoolMicroUsd: 20_000_000,
			})
		).toBe("favourable");
		expect(classifyMigration("pro", from, { ...from })).toBe("neutral");
	});
});

const moving = (
	overrides: Partial<GrandfatheringDecision>
): GrandfatheringDecision => ({
	decidedBy: "test",
	decidedOn: "2026-10-20",
	fromVersion: 5,
	id: "pro-v5-to-v7-test",
	plan: "pro",
	policy: { kind: "next_renewal", noticeDays: 30 },
	rationale: "test",
	toVersion: 7,
	...overrides,
});

describe("decisions", () => {
	it("gives every superseded row a fate", () => {
		expect(rowsWithoutDecision()).toEqual([]);
	});

	it("are all valid", () => {
		for (const decision of GRANDFATHERING_DECISIONS) {
			expect(`${decision.id}: ${decisionProblems(decision).join("; ")}`).toBe(
				`${decision.id}: `
			);
			expect(decision.policy.kind === "forever").toBe(
				decision.toVersion === null
			);
		}
	});

	it("the last decision for a row wins and older ids stop being in force", () => {
		const later = moving({ id: "pro-v5-later" });
		const list = [...GRANDFATHERING_DECISIONS, later];
		expect(decisionFor("pro", 5, list)?.id).toBe("pro-v5-later");
		expect(decisionById("pro-v5-forever", list)).toBeNull();
		expect(decisionById("pro-v5-later", list)?.id).toBe("pro-v5-later");
	});

	it("refuses an adverse move of a pinned row without a reviewed override", () => {
		// Pro v5 ($39) to v7 ($49) is a price rise on a row sold as "keep your price".
		expect(decisionProblems(moving({}))).toContain(
			"an adverse move of a row sold under the keep-your-price promise needs overridesForeverPromise"
		);
		expect(
			decisionProblems(
				moving({
					overridesForeverPromise: {
						approvedBy: "founder",
						counselReviewedOn: "2026-10-19",
						note: "test",
					},
				})
			)
		).toEqual([]);
	});

	it("validates notice, target and dates", () => {
		const override = {
			approvedBy: "founder",
			counselReviewedOn: "2026-10-19",
			note: "test",
		} as const;
		expect(
			decisionProblems(
				moving({
					overridesForeverPromise: override,
					policy: { kind: "next_renewal", noticeDays: 10 },
				})
			)
		).toContain("notice must be at least 30 days");
		expect(
			decisionProblems(
				moving({
					fromVersion: 1,
					overridesForeverPromise: override,
					toVersion: 4,
				})
			)
		).toContain("the target must be the row currently sold");
		expect(
			decisionProblems(
				moving({
					overridesForeverPromise: override,
					policy: { kind: "until", noticeDays: 30, until: "2026-11-01" },
				})
			)
		).toContain("`until` must leave the full notice period after the decision");
		expect(decisionProblems(moving({ policy: { kind: "forever" } }))).toContain(
			"a forever decision must not name a target version"
		);
		expect(decisionProblems(moving({ toVersion: null }))).toEqual([
			"a moving decision must name a target version",
		]);
	});

	it("hashes change with the decision, the target terms and the target products", () => {
		const decision = moving({});
		const base = decisionHash(decision, () => undefined);
		expect(decisionHash(decision, () => undefined)).toBe(base);
		expect(
			decisionHash(moving({ rationale: "changed" }), () => undefined)
		).not.toBe(base);
		expect(decisionHash(decision, (key) => `other_${key}`)).not.toBe(base);
		expect(termsHash(versionRow("pro", 5))).toBe(
			termsHash(versionRow("pro", 4))
		);
		expect(termsHash(versionRow("pro", 6))).not.toBe(
			termsHash(versionRow("pro", 5))
		);
	});
});
