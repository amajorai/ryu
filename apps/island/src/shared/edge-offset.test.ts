import { describe, expect, it } from "bun:test";
import {
	clampEdgeOffset,
	DEFAULT_EDGE_OFFSET,
	MAX_EDGE_OFFSET,
	MIN_EDGE_OFFSET,
	parseEdgeOffset,
} from "./edge-offset.ts";

describe("clampEdgeOffset", () => {
	it("keeps in-range values, rounding to whole pixels", () => {
		expect(clampEdgeOffset(20)).toBe(20);
		expect(clampEdgeOffset(20.4)).toBe(20);
		expect(clampEdgeOffset(20.6)).toBe(21);
	});

	it("clamps to the min and max bounds", () => {
		expect(clampEdgeOffset(-50)).toBe(MIN_EDGE_OFFSET);
		expect(clampEdgeOffset(9999)).toBe(MAX_EDGE_OFFSET);
		expect(clampEdgeOffset(MIN_EDGE_OFFSET - 1)).toBe(MIN_EDGE_OFFSET);
		expect(clampEdgeOffset(MAX_EDGE_OFFSET + 1)).toBe(MAX_EDGE_OFFSET);
	});
});

describe("parseEdgeOffset", () => {
	it("returns the default for null", () => {
		expect(parseEdgeOffset(null)).toBe(DEFAULT_EDGE_OFFSET);
	});

	it("returns the default for non-numeric blobs", () => {
		expect(parseEdgeOffset("abc")).toBe(DEFAULT_EDGE_OFFSET);
		expect(parseEdgeOffset("NaN")).toBe(DEFAULT_EDGE_OFFSET);
		expect(parseEdgeOffset("Infinity")).toBe(DEFAULT_EDGE_OFFSET);
	});

	it("coerces an empty/whitespace string to 0, since Number('') is 0 (not the default)", () => {
		// Number("") and Number("  ") are 0, which is finite, so the fallback is
		// NOT taken — the value clamps to MIN_EDGE_OFFSET.
		expect(parseEdgeOffset("")).toBe(MIN_EDGE_OFFSET);
		expect(parseEdgeOffset("   ")).toBe(MIN_EDGE_OFFSET);
	});

	it("parses and clamps a valid numeric string", () => {
		expect(parseEdgeOffset("32")).toBe(32);
		expect(parseEdgeOffset("  48  ")).toBe(48);
		expect(parseEdgeOffset("1000")).toBe(MAX_EDGE_OFFSET);
		expect(parseEdgeOffset("-5")).toBe(MIN_EDGE_OFFSET);
		expect(parseEdgeOffset("18.7")).toBe(19);
	});

	it("holds the documented bounds contract", () => {
		expect(MIN_EDGE_OFFSET).toBe(0);
		expect(MAX_EDGE_OFFSET).toBe(96);
		expect(DEFAULT_EDGE_OFFSET).toBeGreaterThanOrEqual(MIN_EDGE_OFFSET);
		expect(DEFAULT_EDGE_OFFSET).toBeLessThanOrEqual(MAX_EDGE_OFFSET);
	});
});
