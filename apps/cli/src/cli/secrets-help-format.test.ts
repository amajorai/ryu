import { describe, expect, test } from "bun:test";
import { renderHelpEntries, wrapWords } from "./secrets-help-format.ts";

describe("secrets help layout", () => {
	test("rows align descriptions at one column and wrap them there", () => {
		const lines = renderHelpEntries([
			"Heading:",
			["list", "List values"],
			["--flag", "Flag text", 6],
			[
				"a-very-long-usage-that-does-not-fit-the-usage-column",
				"On the next line",
			],
		]);
		expect(lines[0]).toBe("Heading:");
		expect(lines[1]).toBe(`  list${" ".repeat(38)}List values`);
		expect(lines[2]).toBe(`      --flag${" ".repeat(32)}Flag text`);
		expect(lines[3]).toBe(
			"  a-very-long-usage-that-does-not-fit-the-usage-column"
		);
		expect(lines[4]).toBe(`${" ".repeat(44)}On the next line`);
	});

	test("a long translated description and prose wrap at word boundaries", () => {
		const long = Array.from({ length: 30 }, () => "Wort").join(" ");
		const [first, second] = renderHelpEntries([["x", long]]);
		expect(first?.length).toBeLessThanOrEqual(104);
		expect(second?.startsWith(`${" ".repeat(44)}Wort`)).toBe(true);
		expect(renderHelpEntries([{ prose: "a b", indent: 6 }])).toEqual([
			"      a b",
		]);
		expect(wrapWords("aa bb cc", 5)).toEqual(["aa bb", "cc"]);
	});
});
