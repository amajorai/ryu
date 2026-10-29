import { describe, expect, test } from "bun:test";
import { parsePluginBackgrounds } from "./plugin-contribution-boundary.ts";

const background = {
	attribution: "PatternCraft",
	attributionUrl: "https://example.com/patterncraft/aurora",
	backdropId: "aurora-flow",
	description: "Slow northern-lights colours.",
	id: "@example/wallpapers:aurora",
	label: "Aurora",
	params: { colors: ["#22c55e", "#8b5cf6"], speed: 0.7 },
	plugin: "@example/wallpapers",
};

describe("plugin background API boundary", () => {
	test("keeps valid rows and drops duplicate contribution ids", () => {
		expect(
			parsePluginBackgrounds([
				background,
				{ ...background, label: "Duplicate" },
			])
		).toEqual([background]);
	});

	test("rejects unsafe source links, ids, and renderer parameter objects", () => {
		expect(
			parsePluginBackgrounds([
				{ ...background, attributionUrl: "javascript:alert(1)" },
				{ ...background, attributionUrl: "https://user:pass@example.com/" },
				{ ...background, id: "@example/other:aurora" },
				{ ...background, params: { speed: { nested: true } } },
				{ ...background, params: { constructor: "polluted" } },
			])
		).toEqual([]);
	});

	test("bounds the number of rows from a contributions response", () => {
		const rows = Array.from({ length: 260 }, (_, index) => ({
			...background,
			id: `@example/wallpapers:variant-${index}`,
		}));
		expect(parsePluginBackgrounds(rows)).toHaveLength(256);
	});
});

test("background codecs retain accepted object identity and enforce every renderer budget", () => {
	const future = { ...background, future: { metadata: [1, true, null] } };
	expect(parsePluginBackgrounds([future])[0]).toBe(future);
	const validParams = Object.fromEntries(
		Array.from({ length: 64 }, (_, index) => [`field${index}`, true])
	);
	expect(
		parsePluginBackgrounds([{ ...background, params: validParams }])
	).toHaveLength(1);
	const oversizedKeys = { ...validParams, overflow: true };
	const acceptedStrings = Array.from({ length: 16 }, () => "x".repeat(128));
	expect(
		parsePluginBackgrounds([
			{ ...background, params: { strings: acceptedStrings } },
		])
	).toHaveLength(1);
	for (const params of [
		oversizedKeys,
		{ strings: [...acceptedStrings, "extra"] },
		{ text: "x".repeat(129) },
		{ text: "bad\u0000text" },
		{ prototype: true },
		{ speed: Number.POSITIVE_INFINITY },
		{
			blob: acceptedStrings,
			blobTwo: acceptedStrings,
			blobThree: acceptedStrings,
		},
	]) {
		expect(parsePluginBackgrounds([{ ...background, params }])).toEqual([]);
	}
	expect(
		parsePluginBackgrounds([
			{ ...background, label: "  " },
			{ ...background, description: "x".repeat(513) },
		])
	).toEqual([]);
});
