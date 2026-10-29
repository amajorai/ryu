import { describe, expect, it } from "bun:test";
import {
	agentUiFunctions,
	agentUiComputedFunctions as fns,
	toFiniteNumber,
} from "./computed.ts";

describe("agent-UI computed functions", () => {
	it("coerces bound input text to numbers and rejects junk", () => {
		expect(toFiniteNumber("1,250.5")).toBe(1250.5);
		expect(toFiniteNumber(" 3 ")).toBe(3);
		expect(toFiniteNumber("")).toBeNull();
		expect(toFiniteNumber("abc")).toBeNull();
		expect(toFiniteNumber(Number.POSITIVE_INFINITY)).toBeNull();
		expect(toFiniteNumber({ value: 1 })).toBeNull();
	});

	it("does arithmetic and returns null instead of throwing", () => {
		expect(fns.add.run({ a: "2", b: 3 })).toBe(5);
		expect(fns.subtract.run({ a: 10, b: 4 })).toBe(6);
		expect(fns.multiply.run({ a: 2.5, b: 4 })).toBe(10);
		expect(fns.divide.run({ a: 1, b: 0 })).toBeNull();
		expect(fns.add.run({ a: 1 })).toBeNull();
		expect(fns.percent.run({ part: 1, total: 4 })).toBe(0.25);
	});

	it("aggregates lists, optionally reading a field", () => {
		const rows = [{ cost: 10 }, { cost: "5" }, { cost: "n/a" }, null];
		expect(fns.sum.run({ values: rows, field: "cost" })).toBe(15);
		expect(fns.average.run({ values: [2, 4, 6] })).toBe(4);
		expect(fns.min.run({ values: [3, 1, 2] })).toBe(1);
		expect(fns.max.run({ values: [3, 1, 2] })).toBe(3);
		expect(fns.count.run({ values: rows })).toBe(4);
		expect(fns.average.run({ values: [] })).toBeNull();
		expect(fns.sum.run({ values: "nope" })).toBeNull();
		// Oversized arrays are refused up front rather than traversed.
		const huge = Array.from({ length: 1001 }, () => 1);
		expect(fns.sum.run({ values: huge })).toBeNull();
		expect(fns.sum.run({ values: huge.slice(0, 1000) })).toBe(1000);
		expect(fns.count.run({ values: huge })).toBe(1001);
	});

	it("rounds, clamps and computes loan payments", () => {
		expect(fns.round.run({ value: 1.234_56, digits: 2 })).toBe(1.23);
		expect(fns.clamp.run({ value: 140, min: 0, max: 100 })).toBe(100);
		expect(fns.payment.run({ principal: 1200, rate: 0, periods: 12 })).toBe(
			100
		);
		const monthly = fns.payment.run({
			principal: 300_000,
			rate: 0.06 / 12,
			periods: 360,
		});
		expect(monthly).toBeCloseTo(1798.65, 2);
		expect(fns.payment.run({ principal: 1, rate: 0.1, periods: 0 })).toBeNull();
	});

	it("formats values and falls back to an em dash", () => {
		expect(
			fns.format.run({ value: 1234.5, style: "currency", currency: "usd" })
		).toBe("$1,234.50");
		expect(fns.format.run({ value: 0.256, style: "percent", digits: 1 })).toBe(
			"25.6%"
		);
		expect(fns.format.run({ value: "", style: "number" })).toBe("—");
		// Unknown styles and currencies degrade to safe defaults.
		expect(fns.format.run({ value: 2, style: "bogus" })).toBe("2");
	});

	it("registers exactly the documented functions", () => {
		expect(Object.keys(agentUiFunctions).sort()).toEqual(
			Object.keys(fns).sort()
		);
	});
});
