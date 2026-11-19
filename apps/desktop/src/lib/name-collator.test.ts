import { describe, expect, test } from "bun:test";
import { compareNames } from "./name-collator.ts";

function sortNames(names: readonly string[], locale?: string): string[] {
	return [...names].sort((a, b) => compareNames(a, b, locale));
}

describe("compareNames", () => {
	test("orders Chinese names by pinyin under zh-CN", () => {
		expect(sortNames(["张三", "阿明"], "zh-CN")).toEqual(["阿明", "张三"]);
	});

	test("orders numbered names by value", () => {
		expect(sortNames(["Notiz 10", "Notiz 2", "Notiz 1"], "de")).toEqual([
			"Notiz 1",
			"Notiz 2",
			"Notiz 10",
		]);
	});

	test("follows the locale's alphabet", () => {
		// Swedish sorts ä after z; German sorts it with a.
		expect(sortNames(["zebra", "äpple"], "sv")).toEqual(["zebra", "äpple"]);
		expect(sortNames(["zebra", "äpple"], "de")).toEqual(["äpple", "zebra"]);
	});

	test("falls back to English for an unusable tag", () => {
		expect(sortNames(["Notiz 10", "Notiz 2"], "not a locale!")).toEqual([
			"Notiz 2",
			"Notiz 10",
		]);
	});

	test("defaults to the active UI locale (English before a provider mounts)", () => {
		expect(sortNames(["item 10", "item 9"])).toEqual(["item 9", "item 10"]);
	});
});
