// Unit tests for the spreadsheet helpers behind the grid's fill handle,
// Ctrl+D/R, Ctrl+Arrow data-edge jumps, and the selection status bar.

import { describe, expect, test } from "bun:test";
import { parseTsv } from "./data-grid.ts";
import {
	buildFillSeries,
	collectFilterOptions,
	findDataEdge,
	getCellDisplayText,
	getFillExtension,
	getFilledRect,
	getFilterKeys,
	isCellValueEmpty,
	isSameCellValue,
	matchesFilterKeys,
	serializeTsv,
	summarizeValues,
	transposeMatrix,
} from "./data-grid-fill.ts";

const source = { minRow: 2, maxRow: 3, minCol: 1, maxCol: 2 };

describe("getFillExtension", () => {
	test("returns null inside the source", () => {
		expect(getFillExtension(source, { row: 3, col: 2 })).toBeNull();
	});

	test("follows the dominant axis", () => {
		expect(getFillExtension(source, { row: 7, col: 4 })).toEqual({
			direction: "down",
			count: 4,
		});
		expect(getFillExtension(source, { row: 0, col: 2 })).toEqual({
			direction: "up",
			count: 2,
		});
		expect(getFillExtension(source, { row: 4, col: 6 })).toEqual({
			direction: "right",
			count: 4,
		});
		expect(getFillExtension(source, { row: 3, col: 0 })).toEqual({
			direction: "left",
			count: 1,
		});
	});

	test("getFilledRect grows the source", () => {
		expect(getFilledRect(source, { direction: "up", count: 2 })).toEqual({
			...source,
			minRow: 0,
		});
	});
});

describe("buildFillSeries", () => {
	test("single number copies; two numbers extend the trend", () => {
		expect(buildFillSeries([5], 3)).toEqual([5, 5, 5]);
		expect(buildFillSeries([1, 3], 3)).toEqual([5, 7, 9]);
		expect(buildFillSeries([0.1, 0.2], 2)).toEqual([0.3, 0.4]);
	});

	test("dates step by day, by inferred gap, or by month", () => {
		expect(buildFillSeries(["2026-01-30"], 3, { variant: "date" })).toEqual([
			"2026-01-31",
			"2026-02-01",
			"2026-02-02",
		]);
		expect(buildFillSeries(["2026-01-01", "2026-01-08"], 1)).toEqual([
			"2026-01-15",
		]);
		expect(buildFillSeries(["2026-01-31", "2026-02-28"], 0)).toEqual([]);
		expect(buildFillSeries(["2026-01-15", "2026-02-15"], 2)).toEqual([
			"2026-03-15",
			"2026-04-15",
		]);
	});

	test("reverse fills step a single value backward", () => {
		expect(buildFillSeries(["2026-03-01"], 1, undefined, true)).toEqual([
			"2026-02-28",
		]);
		expect(buildFillSeries(["Item 2"], 3, undefined, true)).toEqual([
			"Item 1",
			"Item 0",
			"Item 1",
		]);
		expect(buildFillSeries(["Mon"], 1, undefined, true)).toEqual(["Sun"]);
	});

	test("text with a trailing number increments and keeps padding", () => {
		expect(buildFillSeries(["Item 1"], 2)).toEqual(["Item 2", "Item 3"]);
		expect(buildFillSeries(["A001", "A003"], 2)).toEqual(["A005", "A007"]);
		expect(buildFillSeries(["7"], 2)).toEqual(["7", "7"]);
	});

	test("weekday and month names advance with matching case", () => {
		expect(buildFillSeries(["Fri"], 3)).toEqual(["Sat", "Sun", "Mon"]);
		expect(buildFillSeries(["JANUARY", "MARCH"], 2)).toEqual(["MAY", "JULY"]);
	});

	test("other values and non-series variants repeat the pattern", () => {
		expect(buildFillSeries(["a", "b"], 3)).toEqual(["a", "b", "a"]);
		expect(
			buildFillSeries([1, 2], 2, { variant: "select", options: [] })
		).toEqual([1, 2]);
		const tags = [["x"]];
		const filled = buildFillSeries(tags, 1, {
			variant: "multi-select",
			options: [],
		});
		expect(filled).toEqual([["x"]]);
		expect(filled[0]).not.toBe(tags[0]);
	});
});

describe("findDataEdge", () => {
	const filled = [true, true, true, false, false, true, false];
	const isFilled = (index: number) => filled[index] ?? false;
	const length = filled.length;

	test("runs to the end of a filled block", () => {
		expect(findDataEdge({ isFilled, length, start: 0, step: 1 })).toBe(2);
	});

	test("jumps across blanks to the next filled cell", () => {
		expect(findDataEdge({ isFilled, length, start: 2, step: 1 })).toBe(5);
		expect(findDataEdge({ isFilled, length, start: 5, step: -1 })).toBe(2);
	});

	test("stops at the boundary when nothing is left", () => {
		expect(findDataEdge({ isFilled, length, start: 5, step: 1 })).toBe(6);
		expect(findDataEdge({ isFilled, length, start: 6, step: 1 })).toBe(6);
	});
});

describe("cell value helpers", () => {
	test("isCellValueEmpty", () => {
		expect(isCellValueEmpty("")).toBe(true);
		expect(isCellValueEmpty([])).toBe(true);
		expect(isCellValueEmpty(false)).toBe(true);
		expect(isCellValueEmpty(0)).toBe(false);
		expect(isCellValueEmpty(" ")).toBe(false);
	});

	test("isSameCellValue compares lists and dates structurally", () => {
		expect(isSameCellValue(["a"], ["a"])).toBe(true);
		expect(isSameCellValue(new Date(1), new Date(1))).toBe(true);
		expect(isSameCellValue("1", 1)).toBe(false);
	});

	test("summarizeValues aggregates numbers and counts non-empty cells", () => {
		expect(summarizeValues([1, 2, "x", "", null, 3])).toEqual({
			count: 4,
			numericCount: 3,
			sum: 6,
			average: 2,
			min: 1,
			max: 3,
		});
		expect(summarizeValues(["a"]).sum).toBeNull();
	});
});

describe("getCellDisplayText", () => {
	test("uses option labels, chip counts, and the longest line", () => {
		const options = [{ value: "a", label: "Alpha" }];
		expect(getCellDisplayText("a", { variant: "select", options })).toEqual({
			text: "Alpha",
			chips: 1,
		});
		expect(
			getCellDisplayText(["a", "b"], { variant: "multi-select", options })
		).toEqual({ text: "Alphab", chips: 2 });
		expect(getCellDisplayText("hi\nlonger line")).toEqual({
			text: "longer line",
			chips: 0,
		});
		expect(getCellDisplayText(true, { variant: "checkbox" }).text).toBe("");
	});
});

describe("paste transposed", () => {
	test("transposeMatrix swaps axes and pads ragged rows", () => {
		expect(
			transposeMatrix([
				["a", "b", "c"],
				["d", "e"],
			])
		).toEqual([
			["a", "d"],
			["b", "e"],
			["c", ""],
		]);
	});

	test("serializeTsv round-trips through parseTsv", () => {
		const plain = [
			["a", "b"],
			["c", "d"],
		];
		expect(parseTsv(serializeTsv(plain), 2)).toEqual(plain);
		const tricky = [
			["line\nbreak", 'say "hi"'],
			["tab\there", ""],
		];
		expect(parseTsv(serializeTsv(tricky), 2)).toEqual(tricky);
	});
});

describe("column value filter", () => {
	test("getFilterKeys splits tags and keeps booleans", () => {
		expect(getFilterKeys(["a", "b"])).toEqual(["a", "b"]);
		expect(getFilterKeys(null)).toEqual([""]);
		expect(getFilterKeys(false)).toEqual(["false"]);
		expect(getFilterKeys(3)).toEqual(["3"]);
	});

	test("matchesFilterKeys passes everything without a filter", () => {
		expect(matchesFilterKeys("x", undefined)).toBe(true);
		expect(matchesFilterKeys("x", ["y"])).toBe(false);
		expect(matchesFilterKeys(["x", "y"], ["y"])).toBe(true);
		expect(matchesFilterKeys("", [""])).toBe(true);
	});

	test("collectFilterOptions counts, labels, and orders values", () => {
		const options = [{ value: "a", label: "Alpha" }];
		expect(
			collectFilterOptions(["a", "", "a", null], { variant: "select", options })
		).toEqual([
			{ key: "a", count: 2, label: "Alpha" },
			{ key: "", count: 2, label: "(Blanks)" },
		]);
		expect(
			collectFilterOptions([10, 9, 100], { variant: "number" }).map(
				(o) => o.key
			)
		).toEqual(["9", "10", "100"]);
	});
});
