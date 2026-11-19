// `ryu secrets agent` renewal timing with a fake clock.

import { describe, expect, test } from "bun:test";
import {
	MIN_DELAY_MS,
	renewDelay,
	Timers,
	timestampMs,
} from "../cli/secrets-agentd-schedule.ts";
import { fakeClock } from "./secrets-agentd-fixture.ts";

describe("timestampMs", () => {
	test("accepts epoch milliseconds and RFC 3339", () => {
		expect(timestampMs(1_700_000_000_000)).toBe(1_700_000_000_000);
		expect(timestampMs("2026-01-01T00:00:00Z")).toBe(Date.UTC(2026, 0, 1));
		expect(timestampMs("not a date")).toBeNull();
		expect(timestampMs(null)).toBeNull();
	});
});

describe("renewDelay", () => {
	test("renews after two thirds of the remaining lifetime", () => {
		expect(renewDelay(0, 3_600_000)).toBe(2_400_000);
		expect(renewDelay(1_000_000, 1_090_000)).toBe(60_000);
	});

	test("never schedules sooner than the minimum, even when already expired", () => {
		expect(renewDelay(10_000, 10_500)).toBe(MIN_DELAY_MS);
		expect(renewDelay(10_000, 0)).toBe(MIN_DELAY_MS);
	});
});

describe("Timers", () => {
	test("fires at the scheduled time, replaces per key and cancels", () => {
		const time = fakeClock();
		const timers = new Timers(time.clock);
		const fired: string[] = [];
		timers.at("token", 2_400_000, () => fired.push("token"));
		timers.at("lease:db", 60_000, () => fired.push("lease:db first"));
		timers.at("lease:db", 120_000, () => fired.push("lease:db"));
		timers.at("interval", 10_000, () => fired.push("interval"));
		timers.cancel("interval");
		expect(timers.pending()).toEqual(["lease:db", "token"]);

		time.advance(119_999);
		expect(fired).toEqual([]);
		time.advance(1);
		expect(fired).toEqual(["lease:db"]);
		time.advance(2_400_000);
		expect(fired).toEqual(["lease:db", "token"]);
		expect(timers.pending()).toEqual([]);

		timers.at("token", 5, () => fired.push("late"));
		timers.cancelAll();
		time.advance(10);
		expect(fired).toEqual(["lease:db", "token"]);
		expect(time.pending()).toBe(0);
	});
});
