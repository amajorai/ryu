// Unit tests for conditional-format rule matching across column types.

import { describe, expect, test } from "bun:test";
import type { CellFormatRule, CellOpts } from "@ryu/ui/types/data-grid.ts";
import {
	getCellFormatColor,
	getFormatOperators,
	matchesFormatRule,
} from "./data-grid-format.ts";

const rule = (
	operator: CellFormatRule["operator"],
	value?: string
): CellFormatRule => ({
	id: "r",
	color: "red",
	operator,
	value,
});

describe("matchesFormatRule", () => {
	test("equality rules never match blank cells", () => {
		expect(matchesFormatRule(null, rule("equals", "0"))).toBe(false);
		expect(matchesFormatRule(null, rule("notEquals", "5"))).toBe(false);
		expect(matchesFormatRule("", rule("notEquals", "x"))).toBe(false);
		expect(matchesFormatRule(4, rule("notEquals", "5"))).toBe(true);
	});

	test("Date values compare as their ISO day", () => {
		const day = new Date("2026-10-08T00:00:00.000Z");
		expect(matchesFormatRule(day, rule("equals", "2026-10-08"))).toBe(true);
		expect(matchesFormatRule(day, rule("greaterThan", "2026-10-07"))).toBe(
			true
		);
		expect(matchesFormatRule(day, rule("lessThan", "2026-10-07"))).toBe(false);
	});

	test("numbers compare numerically", () => {
		expect(matchesFormatRule(10, rule("greaterThan", "9"))).toBe(true);
		expect(matchesFormatRule(9, rule("greaterThanOrEqual", "9"))).toBe(true);
		expect(matchesFormatRule(2, rule("lessThan", "10"))).toBe(true);
		expect(matchesFormatRule(null, rule("lessThan", "10"))).toBe(false);
		expect(matchesFormatRule(5, rule("equals", "5.0"))).toBe(true);
	});

	test("dates compare as ISO days", () => {
		expect(
			matchesFormatRule("2026-01-05", rule("lessThan", "2026-02-01"))
		).toBe(true);
		expect(
			matchesFormatRule("2026-03-05", rule("lessThanOrEqual", "2026-02-01"))
		).toBe(false);
	});

	test("text matching is case-insensitive", () => {
		expect(matchesFormatRule("Urgent fix", rule("contains", "URGENT"))).toBe(
			true
		);
		expect(matchesFormatRule("", rule("contains", "x"))).toBe(false);
		expect(matchesFormatRule("", rule("notContains", "x"))).toBe(true);
		expect(matchesFormatRule("Done", rule("equals", "done"))).toBe(true);
		expect(matchesFormatRule("Done", rule("notEquals", "done"))).toBe(false);
	});

	test("selects match option labels", () => {
		const select: CellOpts = {
			variant: "select",
			options: [{ value: "o1", label: "Blocked" }],
		};
		expect(matchesFormatRule("o1", rule("equals", "blocked"), select)).toBe(
			true
		);
		const multi: CellOpts = {
			variant: "multi-select",
			options: [{ value: "o1", label: "Bug" }],
		};
		expect(matchesFormatRule(["o1"], rule("contains", "bug"), multi)).toBe(
			true
		);
	});

	test("empty checks include unchecked boxes", () => {
		expect(matchesFormatRule(false, rule("isEmpty"))).toBe(true);
		expect(matchesFormatRule(true, rule("isNotEmpty"))).toBe(true);
	});
});

describe("getCellFormatColor", () => {
	test("first matching rule wins", () => {
		const cell: CellOpts = {
			variant: "number",
			formatRules: [
				{ id: "a", operator: "greaterThan", value: "100", color: "red" },
				{ id: "b", operator: "greaterThan", value: "10", color: "yellow" },
			],
		};
		expect(getCellFormatColor(500, cell)).toBe("red");
		expect(getCellFormatColor(50, cell)).toBe("yellow");
		expect(getCellFormatColor(5, cell)).toBeUndefined();
	});

	test("operators depend on the column type", () => {
		expect(getFormatOperators("checkbox")).toEqual(["isNotEmpty", "isEmpty"]);
		expect(getFormatOperators("number")).toContain("greaterThan");
		expect(getFormatOperators("short-text")).not.toContain("greaterThan");
	});
});
