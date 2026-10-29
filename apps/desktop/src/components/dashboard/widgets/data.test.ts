import { describe, expect, test } from "bun:test";
import {
	asRecord,
	cell,
	dottedGet,
	inferColumns,
	resolveArray,
	resolveNumber,
} from "./data.ts";

describe("dashboard JSON source decoding", () => {
	test("reads nested records and array indices from source JSON", () => {
		const source = { result: { series: [{ day: "Mon", count: 7 }] } };
		expect(dottedGet(source, "result.series.0.count")).toBe(7);
		expect(resolveArray(source, "result.series")).toEqual([
			{ day: "Mon", count: 7 },
		]);
		expect(resolveNumber(source, "result.series.0.count")).toBe(7);
		expect(dottedGet(source, "result.missing.count")).toBeUndefined();
	});
	test("retains first-seen columns, primitive coercion, and object cell rendering", () => {
		expect(inferColumns([{ a: 1 }, { b: 2, a: 3 }])).toEqual(["a", "b"]);
		expect(resolveNumber({ value: "12.5 items" })).toBe(12.5);
		expect(resolveNumber([1, 2])).toBe(2);
		expect(cell({ value: 1 })).toBe('{"value":1}');
		expect(cell(null)).toBe("");
	});
	test("rejects non-JSON payloads before record traversal", () => {
		expect(asRecord({ value: () => 1 })).toBeNull();
		expect(asRecord([1, 2])).toBeNull();
		expect(resolveArray({ result: undefined })).toEqual([]);
		expect(dottedGet({ value: Number.NaN }, "value")).toBeUndefined();
	});
});
