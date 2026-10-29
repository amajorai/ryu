// Unit tests for the database formula language: parsing, operator precedence,
// coercion, functions, error values, and cross-column (including cyclic)
// evaluation.

import { describe, expect, test } from "bun:test";
import {
	compileFormula,
	computeFormulaColumns,
	FORMULA_ERRORS,
	FORMULA_MAX_TEXT_LENGTH,
	type FormulaValue,
	renameColumnInFormulas,
	renameFormulaReferences,
} from "./data-grid-formula.ts";

function run(
	expression: string,
	row: Record<string, FormulaValue | string[]> = {}
): FormulaValue {
	const result = compileFormula(expression);
	if (!result.ok) {
		return result.code;
	}
	return result.formula.evaluate((name) =>
		name in row ? row[name] : undefined
	);
}

describe("compileFormula", () => {
	test("arithmetic follows precedence and associativity", () => {
		expect(run("1 + 2 * 3")).toBe(7);
		expect(run("(1 + 2) * 3")).toBe(9);
		expect(run("2 ^ 3 ^ 2")).toBe(512);
		expect(run("-2 ^ 2")).toBe(4);
		expect(run("0.1 + 0.2")).toBe(0.3);
		expect(run("=10 / 4")).toBe(2.5);
	});

	test("column references coerce like a spreadsheet", () => {
		const row = {
			Price: 2.5,
			Qty: "4",
			Done: true,
			Note: null,
			Tags: ["a", "b"],
		};
		expect(run("{Price} * {Qty}", row)).toBe(10);
		expect(run("{Done} + 1", row)).toBe(2);
		expect(run("{Note} + 1", row)).toBe(1);
		expect(run('{Tags} & "!"', row)).toBe("a, b!");
	});

	test("comparison and text", () => {
		expect(run('"abc" = "ABC"')).toBe(true);
		expect(run("3 <> 3")).toBe(false);
		expect(run("2 != 3")).toBe(true);
		expect(run('"say ""hi"""')).toBe('say "hi"');
		expect(run('"a" & 1 & TRUE')).toBe("a1TRUE");
	});

	test("functions", () => {
		expect(run('IF({x} > 1, "big", "small")', { x: 2 })).toBe("big");
		expect(run("IF(FALSE, 1)")).toBe(false);
		expect(run("AND(TRUE, 1, NOT(FALSE))")).toBe(true);
		expect(run("SUM(1, 2, {x})", { x: 3 })).toBe(6);
		expect(run("AVERAGE(1, 2, {blank})", { blank: null })).toBe(1.5);
		expect(run("MIN(3, 1, 2) + MAX(4, 9)")).toBe(10);
		expect(run("ROUND(3.14159, 2)")).toBe(3.14);
		expect(run("ABS(-4)")).toBe(4);
		expect(run('CONCAT("a", 1, "b")')).toBe("a1b");
		expect(run('LEN("four")')).toBe(4);
		expect(run('UPPER(TRIM(" x "))')).toBe("X");
		expect(run('CONTAINS("Hello", "ELL")')).toBe(true);
		expect(run("ISBLANK({x})", { x: "" })).toBe(true);
		expect(run('DAYS("2026-03-01", "2026-02-01")')).toBe(28);
		expect(run("LEN(TODAY())")).toBe(10);
	});

	test("errors are values, not exceptions", () => {
		expect(run("1 / 0")).toBe(FORMULA_ERRORS.divZero);
		expect(run('"x" * 2')).toBe(FORMULA_ERRORS.value);
		expect(run("{Missing} + 1")).toBe(FORMULA_ERRORS.ref);
		expect(run("Price + 1")).toBe(FORMULA_ERRORS.name);
		expect(run("NOPE(1)")).toBe(FORMULA_ERRORS.name);
		expect(run("1 +")).toBe(FORMULA_ERRORS.syntax);
		expect(run("(1")).toBe(FORMULA_ERRORS.syntax);
		expect(run("{Price")).toBe(FORMULA_ERRORS.syntax);
		expect(run("")).toBe(FORMULA_ERRORS.syntax);
		expect(run("ROUND()")).toBe(FORMULA_ERRORS.value);
	});

	test("reports referenced columns", () => {
		const result = compileFormula("{A} + SUM({B}, {A})");
		expect(result.ok && result.formula.references).toEqual(["A", "B"]);
	});
});

describe("computeFormulaColumns", () => {
	const columns = [
		{ id: "price", label: "Price", cell: { variant: "number" } },
		{ id: "qty", label: "Qty", cell: { variant: "number" } },
		{
			id: "total",
			label: "Total",
			cell: { variant: "formula", expression: "{Price} * {qty}" },
		},
		{
			id: "taxed",
			label: "Taxed",
			cell: { variant: "formula", expression: "{Total} * 1.1" },
		},
	];

	test("fills formula columns, including formulas that use formulas", () => {
		const rows = [{ price: 2, qty: 3 }];
		const [row] = computeFormulaColumns(rows, columns);
		const expectedRow = { price: 2, qty: 3, total: 6, taxed: 6.6 };
		expect(row).toEqual(expectedRow);
	});

	test("cycles and bad formulas become error values", () => {
		const cyclic = [
			{
				id: "a",
				label: "A",
				cell: { variant: "formula", expression: "{B} + 1" },
			},
			{
				id: "b",
				label: "B",
				cell: { variant: "formula", expression: "{A} + 1" },
			},
			{ id: "c", label: "C", cell: { variant: "formula", expression: "1 +" } },
		];
		expect(computeFormulaColumns([{}], cyclic)[0]).toEqual({
			a: FORMULA_ERRORS.cycle,
			b: FORMULA_ERRORS.cycle,
			c: FORMULA_ERRORS.syntax,
		});
	});

	test("returns rows unchanged without formula columns", () => {
		const rows = [{ price: 1 }];
		expect(computeFormulaColumns(rows, columns.slice(0, 2))).toBe(rows);
	});
});

describe("formula limits and coercion", () => {
	test("deep nesting and very long formulas are syntax errors, not crashes", () => {
		const deep = `${"(".repeat(20_000)}1${")".repeat(20_000)}`;
		expect(run(deep)).toBe(FORMULA_ERRORS.syntax);
		expect(run("-".repeat(500))).toBe(FORMULA_ERRORS.syntax);
		expect(run(Array.from({ length: 600 }, () => "1").join("+"))).toBe(
			FORMULA_ERRORS.syntax
		);
		expect(run(`${"(".repeat(30)}1${")".repeat(30)}`)).toBe(1);
	});

	test("text results are capped before they are built", () => {
		const big = "x".repeat(FORMULA_MAX_TEXT_LENGTH);
		expect(run('{t} & "y"', { t: big })).toBe(FORMULA_ERRORS.value);
		expect(run("CONCAT({t}, {t})", { t: big })).toBe(FORMULA_ERRORS.value);
		expect(run('LEN({t} & "")', { t: big })).toBe(FORMULA_MAX_TEXT_LENGTH);
	});

	test("text coerces to a number only in decimal form", () => {
		expect(run("{x} + 1", { x: " 1.5e1 " })).toBe(16);
		expect(run("{x} + 1", { x: ".5" })).toBe(1.5);
		expect(run("{x} + 1", { x: "-2." })).toBe(-1);
		expect(run("{x} + 1", { x: "0x10" })).toBe(FORMULA_ERRORS.value);
		expect(run("{x} + 1", { x: "0b1" })).toBe(FORMULA_ERRORS.value);
		expect(run("{x} + 1", { x: "1e" })).toBe(FORMULA_ERRORS.value);
		expect(run("{x} + 1", { x: "." })).toBe(FORMULA_ERRORS.value);
	});

	test("stored text that reads like an error code stays text", () => {
		expect(run('{Notes} & " details"', { Notes: "#REF!" })).toBe(
			"#REF! details"
		);
		const formulaColumns = [
			{
				id: "a",
				label: "A",
				cell: { variant: "formula", expression: '"#DIV/0!"' },
			},
			{
				id: "b",
				label: "B",
				cell: { variant: "formula", expression: '{A} & "?"' },
			},
			{
				id: "c",
				label: "C",
				cell: { variant: "formula", expression: "1 / 0" },
			},
			{
				id: "d",
				label: "D",
				cell: { variant: "formula", expression: '{C} & "?"' },
			},
		];
		expect(computeFormulaColumns([{}], formulaColumns)[0]).toEqual({
			a: "#DIV/0!",
			b: "#DIV/0!?",
			c: FORMULA_ERRORS.divZero,
			d: FORMULA_ERRORS.divZero,
		});
	});
});

describe("renameFormulaReferences", () => {
	test("rewrites references to the renamed column, not quoted text", () => {
		expect(
			renameFormulaReferences('{ price } * {Qty} & "{Price}"', "Price", "Cost")
		).toBe('{Cost} * {Qty} & "{Price}"');
		expect(renameFormulaReferences("{Qty} + 1", "Price", "Cost")).toBe(
			"{Qty} + 1"
		);
	});

	test("updates formula columns and keeps them resolving after a rename", () => {
		const before = [
			{ id: "p", label: "Cost", cell: { variant: "number" } },
			{
				id: "t",
				label: "Total",
				cell: { variant: "formula", expression: "{Price} * 2" },
			},
		];
		const after = renameColumnInFormulas(before, "Price", "Cost");
		expect(after[1]?.cell.expression).toBe("{Cost} * 2");
		const expectedRow = { p: 3, t: 6 };
		expect(computeFormulaColumns([{ p: 3 }], after)[0]).toEqual(expectedRow);
		expect(renameColumnInFormulas(after, "Missing", "Other")).toBe(after);
	});
});
