import { describe, expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n";
import {
	editableSpaceTitle,
	isPlaceholderTitle,
	spaceDisplayTitle,
} from "./display-title.ts";

const german: LiteralMessage = (source) =>
	source === "Untitled" ? "Unbenannt" : source;

describe("isPlaceholderTitle", () => {
	test("treats empty, blank and missing titles as placeholders", () => {
		expect(isPlaceholderTitle("")).toBe(true);
		expect(isPlaceholderTitle("   ")).toBe(true);
		expect(isPlaceholderTitle(null)).toBe(true);
		expect(isPlaceholderTitle(undefined)).toBe(true);
	});

	test("treats the legacy stored English title as a placeholder", () => {
		expect(isPlaceholderTitle("Untitled")).toBe(true);
	});

	test("keeps real titles, including ones that only contain the word", () => {
		expect(isPlaceholderTitle("Roadmap")).toBe(false);
		expect(isPlaceholderTitle("Untitled draft")).toBe(false);
		expect(isPlaceholderTitle("untitled")).toBe(false);
	});
});

describe("spaceDisplayTitle", () => {
	test("renders the viewer's localized fallback for an empty title", () => {
		expect(spaceDisplayTitle("", german)).toBe("Unbenannt");
	});

	test("renders the localized fallback for the legacy English title", () => {
		expect(spaceDisplayTitle("Untitled", german)).toBe("Unbenannt");
	});

	test("renders a real title unchanged", () => {
		expect(spaceDisplayTitle("Quarterly plan", german)).toBe("Quarterly plan");
	});
});

describe("editableSpaceTitle", () => {
	test("empties placeholder titles so the input shows its placeholder", () => {
		expect(editableSpaceTitle("Untitled")).toBe("");
		expect(editableSpaceTitle("")).toBe("");
		expect(editableSpaceTitle(undefined)).toBe("");
	});

	test("keeps a real title editable as stored", () => {
		expect(editableSpaceTitle("Quarterly plan")).toBe("Quarterly plan");
	});
});
