import { describe, expect, it } from "bun:test";
import { approvalModeStyle } from "./composer-approval-style.ts";
import type { ComposerSettingItem } from "./composer-settings-menu.tsx";

function item(
	partial: Partial<ComposerSettingItem> & { id: string }
): ComposerSettingItem {
	return { name: partial.id, ...partial };
}

// className is the stable, module-private discriminator between decorations.
const BYPASS = "text-red-600 dark:text-red-400";
const PLAN = "text-emerald-600 dark:text-emerald-400";
const ACCEPT_EDITS = "text-purple-600 dark:text-purple-400";
const AUTO = "text-amber-600 dark:text-amber-400";
const READ_ONLY = "text-sky-600 dark:text-sky-400";

describe("approvalModeStyle", () => {
	it("returns undefined for an unrecognized mode", () => {
		expect(approvalModeStyle(item({ id: "custom-thing" }))).toBeUndefined();
	});

	it.each([
		["bypass", "bypass"],
		["full access", "full access"],
		["full-access", "full-access"],
		["fullaccess", "fullaccess"],
		["danger", "danger-zone"],
		["yolo", "yolo"],
		["skip", "skip-permissions"],
	])("classifies %p as the bypass style", (_label, id) => {
		expect(approvalModeStyle(item({ id }))?.className).toBe(BYPASS);
	});

	it("classifies plan mode", () => {
		expect(approvalModeStyle(item({ id: "plan" }))?.className).toBe(PLAN);
	});

	it("classifies accept-edits", () => {
		expect(approvalModeStyle(item({ id: "accept-edits" }))?.className).toBe(
			ACCEPT_EDITS
		);
	});

	it("classifies a bare auto mode as auto", () => {
		expect(approvalModeStyle(item({ id: "auto" }))?.className).toBe(AUTO);
	});

	it("classifies read-only", () => {
		expect(approvalModeStyle(item({ id: "read-only" }))?.className).toBe(
			READ_ONLY
		);
	});

	it("prefers accept over auto for 'auto-accept' (accept is checked first)", () => {
		expect(approvalModeStyle(item({ id: "auto-accept" }))?.className).toBe(
			ACCEPT_EDITS
		);
	});

	it("prefers bypass over every other match", () => {
		// 'skip' triggers bypass even though 'read' would otherwise match too.
		expect(
			approvalModeStyle(item({ id: "skip-read", name: "skip and read" }))
				?.className
		).toBe(BYPASS);
	});

	it("matches against the name field, not just the id", () => {
		expect(
			approvalModeStyle(item({ id: "mode-3", name: "Plan first" }))?.className
		).toBe(PLAN);
	});

	it("is case-insensitive", () => {
		expect(approvalModeStyle(item({ id: "PLAN" }))?.className).toBe(PLAN);
		expect(approvalModeStyle(item({ id: "YOLO" }))?.className).toBe(BYPASS);
	});

	it("returns a decoration carrying both an icon and a className", () => {
		const deco = approvalModeStyle(item({ id: "plan" }));
		expect(deco?.icon).toBeDefined();
		expect(typeof deco?.className).toBe("string");
	});
});
