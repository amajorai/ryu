import { describe, expect, it } from "bun:test";
import {
	dayPeriodKey,
	monthPeriodKey,
	periodKeyFor,
	QUESTS,
	questByKey,
	questCreditReward,
	questPointsReward,
	weekPeriodKey,
} from "./quests.ts";

describe("QUESTS catalog", () => {
	it("has unique stable keys", () => {
		const keys = QUESTS.map((quest) => quest.key);
		expect(new Set(keys).size).toBe(keys.length);
		for (const quest of QUESTS) {
			expect(quest.key).toMatch(/^[a-z0-9-]+$/);
		}
	});

	it("reaches every target with a positive, defined reward", () => {
		for (const quest of QUESTS) {
			expect(quest.target).toBeGreaterThan(0);
			const points = questPointsReward(quest);
			const credit = questCreditReward(quest);
			if (points === null) {
				expect(credit).not.toBeNull();
				expect(credit?.creditMicroUsd).toBeGreaterThan(0);
			} else {
				expect(points).toBeGreaterThan(0);
			}
		}
	});

	it("has a monthly referral quest the page can build a stepper around", () => {
		const refer5 = questByKey("refer-5-monthly");
		expect(refer5).toBeDefined();
		expect(refer5?.cadence).toBe("monthly");
		expect(refer5?.verification).toBe("auto");
		expect(refer5?.target).toBe(5);
		expect(refer5?.reward.kind).toBe("credit");
	});

	it("includes a once-per-day check-in quest", () => {
		const checkIn = questByKey("daily-check-in");
		expect(checkIn).toBeDefined();
		expect(checkIn?.cadence).toBe("daily");
		expect(checkIn?.verification).toBe("auto");
		expect(checkIn?.target).toBe(1);
		expect(checkIn?.reward).toEqual({ kind: "points", points: 25 });
	});

	it("includes the one-time desktop app quest", () => {
		const desktop = questByKey("download-desktop-app");
		expect(desktop).toBeDefined();
		expect(desktop?.cadence).toBe("one_time");
		expect(desktop?.verification).toBe("auto");
		expect(desktop?.target).toBe(1);
		expect(desktop?.reward).toEqual({ kind: "points", points: 100 });
	});

	it("keeps submit-verified quests on a single-proof target", () => {
		for (const quest of QUESTS.filter((q) => q.verification === "submit")) {
			expect(quest.target).toBe(1);
		}
	});

	it("looks up unknown keys as undefined", () => {
		expect(questByKey("nope")).toBeUndefined();
	});
});

describe("period keys", () => {
	it("derives a UTC month key", () => {
		expect(monthPeriodKey(new Date("2026-08-15T12:00:00Z"))).toBe("2026-08");
		expect(monthPeriodKey(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12");
	});

	it("derives a UTC day key", () => {
		expect(dayPeriodKey(new Date("2026-08-17T23:59:59Z"))).toBe("2026-08-17");
		expect(dayPeriodKey(new Date("2026-08-18T00:00:00Z"))).toBe("2026-08-18");
	});

	it("derives ISO weeks, handling the year turn", () => {
		// 2026-08-17 is a Monday in ISO week 34.
		expect(weekPeriodKey(new Date("2026-08-17T00:00:00Z"))).toBe("2026-W34");
		// A Thursday is in the same week as its Monday.
		expect(weekPeriodKey(new Date("2026-08-20T12:00:00Z"))).toBe("2026-W34");
		// A Sunday belongs to the same ISO week.
		expect(weekPeriodKey(new Date("2026-08-23T12:00:00Z"))).toBe("2026-W34");
		// 2027-01-01 is a Friday in ISO week 53 of 2026 (the year turns in the
		// middle of the week), so the week-year is 2026.
		expect(weekPeriodKey(new Date("2027-01-01T12:00:00Z"))).toBe("2026-W53");
	});

	it("returns null for one-time and permanent quests", () => {
		const date = new Date("2026-08-15T12:00:00Z");
		expect(periodKeyFor(date, "one_time")).toBeNull();
		expect(periodKeyFor(date, "permanent")).toBeNull();
		expect(periodKeyFor(date, "daily")).toBe("2026-08-15");
		expect(periodKeyFor(date, "weekly")).toBe("2026-W33");
		expect(periodKeyFor(date, "monthly")).toBe("2026-08");
	});
});
