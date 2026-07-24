// Unit tests for the pure helpers behind the Skills catalog list + detail. Most
// run inside the Dialog-portaled preview (unreachable through the static-markup
// render idiom), so they are exported and exercised directly. `formatCount` also
// feeds the list card subtitle.

import { describe, expect, test } from "bun:test";
import {
	formatCount,
	formatDateLabel,
	isMarkdownFile,
	resolveSkillKey,
} from "./skills-catalog-section.tsx";
import type { SkillCard } from "./types.ts";

function card(over: Partial<SkillCard> = {}): SkillCard {
	return {
		id: "acme/repo/thing",
		installed: false,
		installs: 0,
		name: "Thing",
		slug: "thing",
		source: "acme",
		...over,
	};
}

describe("formatCount", () => {
	test("millions render as N.NM", () => {
		expect(formatCount(1_234_567)).toBe("1.2M");
		expect(formatCount(2_000_000)).toBe("2.0M");
	});

	test("thousands render as N.Nk", () => {
		expect(formatCount(1500)).toBe("1.5k");
		expect(formatCount(1000)).toBe("1.0k");
	});

	test("under 1000 renders the raw integer", () => {
		expect(formatCount(0)).toBe("0");
		expect(formatCount(999)).toBe("999");
	});

	test("the 1000 / 1_000_000 boundaries flip the unit", () => {
		expect(formatCount(999_999)).toBe("1000.0k");
		expect(formatCount(1_000_000)).toBe("1.0M");
	});
});

describe("resolveSkillKey", () => {
	test("prefers the slug when it is a known installed key", () => {
		expect(resolveSkillKey({ thing: true }, card())).toBe("thing");
	});

	test("falls back to the id when the slug is not a key", () => {
		expect(resolveSkillKey({ "acme/repo/thing": false }, card())).toBe(
			"acme/repo/thing"
		);
	});

	test("slug takes precedence over id when both are keys", () => {
		expect(
			resolveSkillKey({ thing: true, "acme/repo/thing": false }, card())
		).toBe("thing");
	});

	test("returns null when neither slug nor id is installed", () => {
		expect(resolveSkillKey({ somethingElse: true }, card())).toBeNull();
		expect(resolveSkillKey({}, card())).toBeNull();
	});

	test("a key present but false still resolves (undefined check, not truthiness)", () => {
		// The toggle needs to target a disabled-but-installed skill, so a `false`
		// value must still resolve the key rather than be treated as absent.
		expect(resolveSkillKey({ thing: false }, card())).toBe("thing");
	});
});

describe("formatDateLabel", () => {
	test("null yields null", () => {
		expect(formatDateLabel(null)).toBeNull();
	});

	test("an unparseable date is echoed back verbatim", () => {
		expect(formatDateLabel("not-a-date")).toBe("not-a-date");
	});

	test("a valid ISO date renders a localized label containing the year", () => {
		const label = formatDateLabel("2026-07-23T00:00:00Z");
		expect(label).not.toBeNull();
		expect(label).toContain("2026");
	});
});

describe("isMarkdownFile", () => {
	test("true for .md and .mdx, case-insensitive", () => {
		expect(isMarkdownFile("README.md")).toBe(true);
		expect(isMarkdownFile("SKILL.MD")).toBe(true);
		expect(isMarkdownFile("doc.mdx")).toBe(true);
	});

	test("false for non-markdown extensions", () => {
		expect(isMarkdownFile("script.py")).toBe(false);
		expect(isMarkdownFile("data.json")).toBe(false);
		expect(isMarkdownFile("mdfile")).toBe(false);
		expect(isMarkdownFile("notmarkdown.txt")).toBe(false);
	});
});
