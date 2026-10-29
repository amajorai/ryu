import { expect, test } from "bun:test";
import {
	expandPastePlaceholders,
	normalizePastedText,
	pastePlaceholderToken,
	shouldCollapsePaste,
} from "../core/composerPaste.ts";

test("normalizes CRLF and bare CR line breaks to LF", () => {
	expect(normalizePastedText("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
});

test("collapses pastes of three or more lines or over 150 characters", () => {
	expect(shouldCollapsePaste("one line")).toBe(false);
	expect(shouldCollapsePaste("a\nb")).toBe(false);
	expect(shouldCollapsePaste("a\nb\nc")).toBe(true);
	expect(shouldCollapsePaste("x".repeat(150))).toBe(false);
	expect(shouldCollapsePaste("x".repeat(151))).toBe(true);
});

test("labels placeholders by line count, or by size for long single lines", () => {
	expect(pastePlaceholderToken("a\nb\nc\nd", 1)).toBe("[Pasted 4 lines #1]");
	expect(pastePlaceholderToken("x".repeat(200), 2)).toBe(
		"[Pasted 200 chars #2]"
	);
});

test("expands every surviving placeholder and leaves edited ones literal", () => {
	const pastes = new Map([
		["[Pasted 3 lines #1]", "a\nb\nc"],
		["[Pasted 3 lines #2]", "x\ny\nz"],
	]);
	expect(
		expandPastePlaceholders(
			"see [Pasted 3 lines #1] and [Pasted 3 lines #2]",
			pastes
		)
	).toBe("see a\nb\nc and x\ny\nz");
	expect(expandPastePlaceholders("see [Pasted 3 lines #", pastes)).toBe(
		"see [Pasted 3 lines #"
	);
});
