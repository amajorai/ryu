import { describe, expect, test } from "bun:test";
import { usageTone, usageToneClasses } from "./usage-rail-tone.ts";

// A reading turns amber from 70% used and red from 90% used, the thresholds of
// the picker's provider meter, so a ring and that meter never disagree about
// one account.

describe("the tone of a usage reading", () => {
	test("stays calm under 70% used", () => {
		expect(usageTone(0)).toBe("calm");
		expect(usageTone(35)).toBe("calm");
		expect(usageTone(69)).toBe("calm");
		expect(usageTone(69.99)).toBe("calm");
	});

	test("turns amber from exactly 70% and stays amber under 90%", () => {
		expect(usageTone(70)).toBe("warning");
		expect(usageTone(70.01)).toBe("warning");
		expect(usageTone(89)).toBe("warning");
		expect(usageTone(89.99)).toBe("warning");
	});

	test("turns red from exactly 90%", () => {
		expect(usageTone(90)).toBe("critical");
		expect(usageTone(99.5)).toBe("critical");
		expect(usageTone(100)).toBe("critical");
	});

	test("a reading outside 0 to 100 takes the tone of the nearest end", () => {
		// Core can report more than the limit for an account that overran it.
		expect(usageTone(140)).toBe("critical");
		expect(usageTone(Number.POSITIVE_INFINITY)).toBe("critical");
		expect(usageTone(-5)).toBe("calm");
	});

	test("a reading that is no number raises no alarm", () => {
		expect(usageTone(Number.NaN)).toBe("calm");
	});

	test("every whole percent has one tone, and the tone never eases as usage grows", () => {
		const order = ["calm", "warning", "critical"];
		let last = 0;
		for (let used = 0; used <= 100; used += 1) {
			const rank = order.indexOf(usageTone(used));
			expect(rank).toBeGreaterThanOrEqual(last);
			last = rank;
		}
		expect(last).toBe(2);
	});
});

describe("the classes of a tone", () => {
	test("the arc, the bar fill and the bar track of one reading share a colour", () => {
		expect(usageToneClasses(10)).toEqual({
			arc: "stroke-success",
			fill: "bg-success",
			track: "bg-success/20",
		});
		expect(usageToneClasses(70)).toEqual({
			arc: "stroke-warning",
			fill: "bg-warning",
			track: "bg-warning/20",
		});
		expect(usageToneClasses(90)).toEqual({
			arc: "stroke-destructive",
			fill: "bg-destructive",
			track: "bg-destructive/20",
		});
	});

	test("the classes change at the same two thresholds as the tone", () => {
		expect(usageToneClasses(69.99).arc).toBe("stroke-success");
		expect(usageToneClasses(70).arc).toBe("stroke-warning");
		expect(usageToneClasses(89.99).fill).toBe("bg-warning");
		expect(usageToneClasses(90).fill).toBe("bg-destructive");
	});

	test("the track is always the dimmed colour of its fill", () => {
		for (const used of [0, 50, 70, 85, 90, 100]) {
			const { fill, track } = usageToneClasses(used);
			expect(track).toBe(`${fill}/20`);
		}
	});
});
