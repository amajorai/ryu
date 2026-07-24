// Unit tests for the pure data-grid helpers: cell-key encoding, TSV parsing
// (quoted + plain paths), URL sanitization, local-date parsing (no timezone drift,
// rejects auto-corrected dates), and file-size formatting. These are framework-free
// and carry the grid's paste/serialization + security logic.

import { describe, expect, test } from "bun:test";
import {
	formatDateForDisplay,
	formatDateToString,
	formatFileSize,
	getCellKey,
	getColumnBorderVisibility,
	getColumnPinningStyle,
	getColumnVariant,
	getEmptyCellValue,
	getIsFileCellData,
	getLineCount,
	getOptionColorClass,
	getRowHeightValue,
	getScrollDirection,
	getUrlHref,
	matchSelectOption,
	parseCellKey,
	parseLocalDate,
	parseTsv,
	SELECT_OPTION_COLORS,
} from "./data-grid.ts";

// Minimal TanStack-Table Column stub: the pinning/border helpers only read a
// handful of the column API, so we synthesize just those methods per test.
type PinSide = "left" | "right" | false;
function fakeColumn(opts: {
	pinned?: PinSide;
	firstLeft?: boolean;
	lastLeft?: boolean;
	firstRight?: boolean;
	lastRight?: boolean;
	start?: number;
	after?: number;
	size?: number;
}) {
	const {
		pinned = false,
		firstLeft = false,
		lastLeft = false,
		firstRight = false,
		lastRight = false,
		start = 0,
		after = 0,
		size = 100,
	} = opts;
	return {
		getIsPinned: () => pinned,
		getIsFirstColumn: (side: "left" | "right") =>
			side === "left" ? firstLeft : firstRight,
		getIsLastColumn: (side: "left" | "right") =>
			side === "left" ? lastLeft : lastRight,
		getStart: () => start,
		getAfter: () => after,
		getSize: () => size,
		// biome-ignore lint/suspicious/noExplicitAny: test stub for the Column API
	} as any;
}

describe("matchSelectOption", () => {
	const options = [
		{ value: "a", label: "Apple" },
		{ value: "b", label: "Banana" },
	];

	test("matches an exact value", () => {
		expect(matchSelectOption("a", options)).toBe("a");
	});

	test("matches a value case-insensitively", () => {
		expect(matchSelectOption("A", options)).toBe("a");
	});

	test("matches by label case-insensitively, returning the value", () => {
		expect(matchSelectOption("banana", options)).toBe("b");
	});

	test("no match returns undefined", () => {
		expect(matchSelectOption("z", options)).toBeUndefined();
	});
});

describe("getCellKey / parseCellKey", () => {
	test("round-trips a row index and column id", () => {
		const key = getCellKey(3, "name");
		expect(key).toBe("3:name");
		expect(parseCellKey(key)).toEqual({ rowIndex: 3, columnId: "name" });
	});

	test("malformed key with no column falls back to defaults", () => {
		expect(parseCellKey("bad")).toEqual({ rowIndex: 0, columnId: "" });
	});

	test("non-numeric row index falls back to defaults", () => {
		expect(parseCellKey("x:name")).toEqual({ rowIndex: 0, columnId: "" });
	});
});

describe("getRowHeightValue / getLineCount", () => {
	test("maps row height presets to pixel heights", () => {
		expect(getRowHeightValue("short")).toBe(36);
		expect(getRowHeightValue("extra-tall")).toBe(96);
	});

	test("maps row height presets to visible line counts", () => {
		expect(getLineCount("short")).toBe(1);
		expect(getLineCount("tall")).toBe(3);
	});
});

describe("getScrollDirection", () => {
	test("passes through the four canonical directions", () => {
		expect(getScrollDirection("left")).toBe("left");
		expect(getScrollDirection("home")).toBe("home");
	});

	test("maps page directions to their axis direction", () => {
		expect(getScrollDirection("pageleft")).toBe("left");
		expect(getScrollDirection("pageright")).toBe("right");
	});

	test("unknown direction returns undefined", () => {
		expect(getScrollDirection("diagonal")).toBeUndefined();
	});
});

describe("getIsFileCellData", () => {
	test("true for an object with id/name/size/type", () => {
		expect(
			getIsFileCellData({ id: "1", name: "a", size: 1, type: "image/png" })
		).toBe(true);
	});

	test("false for null, primitives, and partial objects", () => {
		expect(getIsFileCellData(null)).toBe(false);
		expect(getIsFileCellData("x")).toBe(false);
		expect(getIsFileCellData({ id: "1", name: "a" })).toBe(false);
	});
});

describe("getOptionColorClass", () => {
	test("resolves a known color key to its badge class", () => {
		expect(getOptionColorClass("blue")).toBe(SELECT_OPTION_COLORS.blue);
	});

	test("returns empty string for unset or unknown colors", () => {
		expect(getOptionColorClass(undefined)).toBe("");
		expect(getOptionColorClass("chartreuse")).toBe("");
	});
});

describe("getEmptyCellValue", () => {
	test("collection variants default to an empty array", () => {
		expect(getEmptyCellValue("multi-select")).toEqual([]);
		expect(getEmptyCellValue("file")).toEqual([]);
	});

	test("nullable variants default to null", () => {
		expect(getEmptyCellValue("number")).toBeNull();
		expect(getEmptyCellValue("date")).toBeNull();
		expect(getEmptyCellValue("select")).toBeNull();
	});

	test("checkbox defaults to false and text to empty string", () => {
		expect(getEmptyCellValue("checkbox")).toBe(false);
		expect(getEmptyCellValue("short-text")).toBe("");
		expect(getEmptyCellValue(undefined)).toBe("");
	});
});

describe("getColumnVariant", () => {
	test("maps a known variant to a label", () => {
		expect(getColumnVariant("number")?.label).toBe("Number");
		expect(getColumnVariant("multi-select")?.label).toBe("Multi-select");
	});

	test("returns null for an unset variant", () => {
		expect(getColumnVariant(undefined)).toBeNull();
	});
});

describe("getUrlHref", () => {
	test("passes through absolute http(s) URLs", () => {
		expect(getUrlHref("https://example.com")).toBe("https://example.com");
		expect(getUrlHref("http://example.com")).toBe("http://example.com");
	});

	test("prefixes a bare host with http://", () => {
		expect(getUrlHref("example.com")).toBe("http://example.com");
	});

	test("trims surrounding whitespace before prefixing", () => {
		expect(getUrlHref("  example.com  ")).toBe("http://example.com");
	});

	test("rejects dangerous protocols by returning empty string", () => {
		expect(getUrlHref("javascript:alert(1)")).toBe("");
		expect(getUrlHref("data:text/html,x")).toBe("");
		expect(getUrlHref("vbscript:x")).toBe("");
		expect(getUrlHref("file:///etc/passwd")).toBe("");
	});

	test("empty or whitespace-only input returns empty string", () => {
		expect(getUrlHref("")).toBe("");
		expect(getUrlHref("   ")).toBe("");
	});
});

describe("parseLocalDate", () => {
	test("parses an ISO yyyy-mm-dd into a local Date", () => {
		const d = parseLocalDate("2024-01-15");
		expect(d?.getFullYear()).toBe(2024);
		expect(d?.getMonth()).toBe(0);
		expect(d?.getDate()).toBe(15);
	});

	test("rejects an auto-corrected impossible date (Feb 30)", () => {
		expect(parseLocalDate("2024-02-30")).toBeNull();
	});

	test("passes a Date instance through unchanged", () => {
		const now = new Date(2020, 5, 1);
		expect(parseLocalDate(now)).toBe(now);
	});

	test("null, non-strings, and garbage return null", () => {
		expect(parseLocalDate(null)).toBeNull();
		expect(parseLocalDate(123)).toBeNull();
		expect(parseLocalDate("not-a-date")).toBeNull();
	});
});

describe("formatDateToString", () => {
	test("zero-pads month and day", () => {
		expect(formatDateToString(new Date(2024, 0, 5))).toBe("2024-01-05");
	});

	test("round-trips with parseLocalDate", () => {
		const s = "2023-11-09";
		const d = parseLocalDate(s);
		expect(d).not.toBeNull();
		expect(formatDateToString(d as Date)).toBe(s);
	});
});

describe("formatDateForDisplay", () => {
	test("empty input yields empty string", () => {
		expect(formatDateForDisplay("")).toBe("");
	});

	test("unparseable string is echoed back untouched", () => {
		expect(formatDateForDisplay("not-a-date")).toBe("not-a-date");
	});

	test("valid date renders a non-empty localized string", () => {
		expect(formatDateForDisplay("2024-01-15").length).toBeGreaterThan(0);
	});
});

describe("formatFileSize", () => {
	test("non-positive and non-finite sizes render as 0 B", () => {
		expect(formatFileSize(0)).toBe("0 B");
		expect(formatFileSize(-10)).toBe("0 B");
		expect(formatFileSize(Number.POSITIVE_INFINITY)).toBe("0 B");
	});

	test("bytes stay in B under 1 KiB", () => {
		expect(formatFileSize(512)).toBe("512 B");
	});

	test("scales into KB / MB / GB by powers of 1024", () => {
		expect(formatFileSize(1024)).toBe("1 KB");
		expect(formatFileSize(1536)).toBe("1.5 KB");
		expect(formatFileSize(1024 * 1024)).toBe("1 MB");
		expect(formatFileSize(1024 * 1024 * 1024)).toBe("1 GB");
	});
});

describe("parseTsv", () => {
	test("plain tab-separated single row", () => {
		expect(parseTsv("a\tb\tc", 3)).toEqual([["a", "b", "c"]]);
	});

	test("single-column rows use the fallback column count", () => {
		expect(parseTsv("a\nb\nc", 1)).toEqual([["a"], ["b"], ["c"]]);
	});

	test("quoted field with an embedded tab is kept intact", () => {
		expect(parseTsv('"a\tb"\tc', 2)).toEqual([["a\tb", "c"]]);
	});

	test("quoted field with an embedded newline is kept intact", () => {
		expect(parseTsv('"line1\nline2"\tc', 2)).toEqual([["line1\nline2", "c"]]);
	});

	test("doubled quotes inside a quoted field become one quote", () => {
		expect(parseTsv('"a""b"\tc', 2)).toEqual([['a"b', "c"]]);
	});
});

describe("getColumnBorderVisibility", () => {
	test("a plain unpinned middle column shows only its end border", () => {
		expect(
			getColumnBorderVisibility({
				column: fakeColumn({ pinned: false }),
				nextColumn: fakeColumn({ pinned: false }),
				isLastColumn: false,
			})
		).toEqual({ showEndBorder: true, showStartBorder: false });
	});

	test("the column just before the first right-pinned column drops its end border", () => {
		expect(
			getColumnBorderVisibility({
				column: fakeColumn({ pinned: false }),
				nextColumn: fakeColumn({ pinned: "right", firstRight: true }),
				isLastColumn: false,
			})
		).toEqual({ showEndBorder: false, showStartBorder: false });
	});

	test("the first right-pinned column shows a start border", () => {
		const result = getColumnBorderVisibility({
			column: fakeColumn({ pinned: "right", firstRight: true, lastRight: true }),
			isLastColumn: true,
			nextColumn: undefined,
		});
		expect(result.showStartBorder).toBe(true);
		// It is also the last column overall, so the end border shows.
		expect(result.showEndBorder).toBe(true);
	});

	test("a last-right-pinned column that is not last overall hides its end border", () => {
		expect(
			getColumnBorderVisibility({
				column: fakeColumn({ pinned: "right", lastRight: true }),
				nextColumn: fakeColumn({ pinned: false }),
				isLastColumn: false,
			})
		).toEqual({ showEndBorder: false, showStartBorder: false });
	});
});

describe("getColumnPinningStyle", () => {
	test("an unpinned column is positioned relative with full opacity and no shadow", () => {
		const style = getColumnPinningStyle({
			column: fakeColumn({ pinned: false, size: 120 }),
		});
		expect(style.position).toBe("relative");
		expect(style.opacity).toBe(1);
		expect(style.zIndex).toBeUndefined();
		expect(style.left).toBeUndefined();
		expect(style.right).toBeUndefined();
		expect(style.width).toBe(120);
		expect(style.boxShadow).toBeUndefined();
	});

	test("a left-pinned column sticks with a left offset from getStart", () => {
		const style = getColumnPinningStyle({
			column: fakeColumn({ pinned: "left", start: 40 }),
		});
		expect(style.position).toBe("sticky");
		expect(style.opacity).toBe(0.97);
		expect(style.zIndex).toBe(1);
		expect(style.left).toBe("40px");
		expect(style.right).toBeUndefined();
	});

	test("a right-pinned column offsets from getAfter", () => {
		const style = getColumnPinningStyle({
			column: fakeColumn({ pinned: "right", after: 24 }),
		});
		expect(style.right).toBe("24px");
		expect(style.left).toBeUndefined();
	});

	test("RTL swaps the left/right offsets", () => {
		const style = getColumnPinningStyle({
			column: fakeColumn({ pinned: "left", start: 40 }),
			dir: "rtl",
		});
		// The left-pin's start offset lands on `right` under RTL.
		expect(style.right).toBe("40px");
		expect(style.left).toBeUndefined();
	});

	test("withBorder draws an inset shadow on the last left-pinned column (LTR)", () => {
		const style = getColumnPinningStyle({
			column: fakeColumn({ pinned: "left", lastLeft: true }),
			withBorder: true,
		});
		expect(style.boxShadow).toBe("-4px 0 4px -4px var(--border) inset");
	});

	test("withBorder draws the mirrored shadow on the first right-pinned column (LTR)", () => {
		const style = getColumnPinningStyle({
			column: fakeColumn({ pinned: "right", firstRight: true }),
			withBorder: true,
		});
		expect(style.boxShadow).toBe("4px 0 4px -4px var(--border) inset");
	});

	test("without withBorder there is no shadow even for a pinned edge column", () => {
		const style = getColumnPinningStyle({
			column: fakeColumn({ pinned: "left", lastLeft: true }),
		});
		expect(style.boxShadow).toBeUndefined();
	});
});
