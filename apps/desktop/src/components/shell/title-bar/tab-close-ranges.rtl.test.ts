// "Close tabs before/after this one" follow the tab order, not the screen. The
// title-bar strip mirrors under dir="rtl" (index 0 sits at the physical right),
// so the menus name the ranges logically and the ranges never flip.
import { describe, expect, test } from "bun:test";
import { tabCloseRanges } from "./tab-close-ranges.ts";

const tabs = [
	{ id: "pinned", pinned: true },
	{ id: "a" },
	{ id: "b" },
	{ id: "c" },
	{ id: "d" },
];

const ids = (list: readonly { id: string }[]) => list.map((tab) => tab.id);

describe("tabCloseRanges", () => {
	test("after closes the tabs at idx + 1 onwards, whatever side they render on", () => {
		const { after, before } = tabCloseRanges(tabs, 2);
		expect(ids(after)).toEqual(["c", "d"]);
		expect(ids(before)).toEqual(["a"]);
	});

	test("pinned tabs survive a bulk close", () => {
		expect(ids(tabCloseRanges(tabs, 4).before)).toEqual(["a", "b", "c"]);
	});

	test("the first and last tabs have nothing before or after them", () => {
		expect(tabCloseRanges(tabs, 1).before).toEqual([]);
		expect(tabCloseRanges(tabs, 4).after).toEqual([]);
	});

	test("an unknown index closes nothing", () => {
		expect(tabCloseRanges(tabs, -1)).toEqual({ after: [], before: [] });
		expect(tabCloseRanges(tabs, 9)).toEqual({ after: [], before: [] });
	});
});
