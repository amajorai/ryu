// The Detail level ladder, pinned. Two things here are load-bearing and neither
// is visible from the UI code: that "None" wins over the four expansion toggles
// without touching them, and that a hand-tuned ("custom") combo parks on a
// sensible detent — never on None, which would label a transcript that still
// shows its tool calls as one that hides them.

// `bun:test`, not `vitest`: this suite runs under `bun test`, and the handful of
// neighbours still importing from "vitest" are the only files in the desktop
// typecheck that cannot resolve their test module. Same API, one fewer error.
import { describe, expect, it } from "bun:test";
import {
	deriveToolDetailPreset,
	TOOL_DETAIL_STEPS,
	type ToolDetailStepId,
	type ToolDetailValue,
	toolDetailStepIndex,
} from "./tool-detail-ladder.ts";

const stepId = (index: number) => TOOL_DETAIL_STEPS[index]?.id;

describe("deriveToolDetailPreset", () => {
	it("names the three expansion presets", () => {
		expect(deriveToolDetailPreset(false, true, false, false, false)).toBe(
			"compact"
		);
		expect(deriveToolDetailPreset(false, true, true, false, false)).toBe(
			"minimal"
		);
		expect(deriveToolDetailPreset(false, false, true, true, true)).toBe(
			"detailed"
		);
	});

	it("returns custom for a combo that matches no preset", () => {
		expect(deriveToolDetailPreset(false, true, false, true, false)).toBe(
			"custom"
		);
	});

	it("short-circuits to none regardless of the four toggles", () => {
		// Every preset combo, plus a custom one, must read as None once the
		// visibility flag is set — there is nothing on screen for the expansion
		// toggles to describe.
		expect(deriveToolDetailPreset(true, true, false, false, false)).toBe(
			"none"
		);
		expect(deriveToolDetailPreset(true, false, true, true, true)).toBe("none");
		expect(deriveToolDetailPreset(true, true, false, true, false)).toBe("none");
	});
});

describe("toolDetailStepIndex", () => {
	it("puts each named level on its own detent, least detail first", () => {
		expect(stepId(toolDetailStepIndex("none", true, false, false, false))).toBe(
			"none"
		);
		expect(
			stepId(toolDetailStepIndex("compact", true, false, false, false))
		).toBe("compact");
		expect(
			stepId(toolDetailStepIndex("minimal", true, true, false, false))
		).toBe("minimal");
		expect(
			stepId(toolDetailStepIndex("detailed", false, true, true, true))
		).toBe("detailed");
	});

	// One row per possible count of expanded things (0–4), because that count is
	// the whole input to the parking arithmetic. Adding a detent changes every
	// row here, which is the point. These five are also exactly where the
	// three-detent ladder parked them before None was added — adding a rung at
	// the bottom must not move anybody's thumb.
	const PARKING_CASES: {
		args: [boolean, boolean, boolean, boolean];
		expandedCount: number;
		// The detent id, not `string`: a typo like "detaild" is then a compile
		// error here instead of a test that fails only when someone runs it.
		parked: ToolDetailStepId;
	}[] = [
		{ expandedCount: 0, args: [true, false, false, false], parked: "compact" },
		{ expandedCount: 1, args: [true, true, false, false], parked: "minimal" },
		{ expandedCount: 2, args: [true, true, true, false], parked: "minimal" },
		{ expandedCount: 3, args: [false, true, true, false], parked: "detailed" },
		{ expandedCount: 4, args: [false, true, true, true], parked: "detailed" },
	];

	for (const { args, expandedCount, parked } of PARKING_CASES) {
		it(`parks a custom combo with ${expandedCount} expanded on ${parked}`, () => {
			const [group, edits, commands, code] = args;
			// SAFETY: The authored custom literal is explicitly part of the native ToolDetailValue union declared by tool-detail-ladder; this fixture passes that supported mode unchanged.
			const index = toolDetailStepIndex(
				"custom" as ToolDetailValue,
				group,
				edits,
				commands,
				code
			);
			expect(stepId(index)).toBe(parked);
		});
	}

	it("never parks a custom combo on None", () => {
		for (const group of [true, false]) {
			for (const edits of [true, false]) {
				for (const commands of [true, false]) {
					for (const code of [true, false]) {
						const index = toolDetailStepIndex(
							"custom",
							group,
							edits,
							commands,
							code
						);
						expect(index).toBeGreaterThan(0);
						expect(index).toBeLessThan(TOOL_DETAIL_STEPS.length);
					}
				}
			}
		}
	});
});
