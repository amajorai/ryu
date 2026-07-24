import { describe, expect, it } from "bun:test";
import {
	DEFAULT_COMMAND_SHORTCUT,
	parseCommandShortcut,
} from "./command-shortcut.ts";

describe("parseCommandShortcut", () => {
	it("falls back to the default for null", () => {
		expect(parseCommandShortcut(null)).toBe(DEFAULT_COMMAND_SHORTCUT);
	});

	it("falls back to the default for a blank/whitespace-only value", () => {
		expect(parseCommandShortcut("")).toBe(DEFAULT_COMMAND_SHORTCUT);
		expect(parseCommandShortcut("   ")).toBe(DEFAULT_COMMAND_SHORTCUT);
	});

	it("trims and returns a real accelerator", () => {
		expect(parseCommandShortcut("  CommandOrControl+K  ")).toBe(
			"CommandOrControl+K"
		);
		expect(parseCommandShortcut("Alt+Shift+I")).toBe("Alt+Shift+I");
	});
});
