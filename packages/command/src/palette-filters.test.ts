import { describe, expect, test } from "bun:test";
import { splitPaletteTabs } from "./palette-filters.tsx";

const tab = (id: string) => ({ id, label: id });

describe("splitPaletteTabs", () => {
	test("keeps All, Chats, Apps and Settings as chips and moves the rest into More", () => {
		const tabs = [
			"all",
			"messages",
			"pages",
			"apps",
			"chats",
			"settings",
			"tools",
		].map(tab);
		const { primary, overflow } = splitPaletteTabs(tabs);
		expect(primary.map((t) => t.id)).toEqual([
			"all",
			"apps",
			"chats",
			"settings",
		]);
		expect(overflow.map((t) => t.id)).toEqual(["messages", "pages", "tools"]);
	});

	test("tops up to four chips in host order when preferred lanes are missing", () => {
		const tabs = ["all", "spaces", "canvas"].map(tab);
		const { primary, overflow } = splitPaletteTabs(tabs);
		expect(primary.map((t) => t.id)).toEqual(["all", "spaces", "canvas"]);
		expect(overflow).toEqual([]);
	});

	test("honours host-chosen chips", () => {
		const tabs = ["all", "a", "b", "c", "d", "e"].map(tab);
		const { primary } = splitPaletteTabs(tabs, ["all", "e"]);
		expect(primary.map((t) => t.id)).toEqual(["all", "a", "b", "e"]);
	});
});
