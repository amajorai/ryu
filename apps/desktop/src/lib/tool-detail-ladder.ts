// The Detail level ladder: the pure rules behind Appearance → Chat → "Detail
// level". Lives in its own module (and not inside AppearanceTab.tsx) because the
// custom-parking arithmetic is the piece that silently regresses the moment
// someone adds a detent, and it is only checkable if it can be imported without
// dragging in React and the whole settings tab.
//
// The "Tool detail" knob is a stepped preset over the four transcript-density
// toggles (group / expand file edits / expand commands / expand code blocks):
// one simple choice that most users never outgrow, with the individual toggles
// tucked into "Advanced" for anyone who wants to fine-grain. The preset is
// DERIVED from the toggles (no separate storage), so editing an individual
// toggle in Advanced simply lands on whichever preset matches — or "custom" when
// none does. Ordered by how much each surfaces: compact (all collapsed) →
// minimal (diffs open) → detailed (everything open, calls listed individually).
// `pinUserMessage` is intentionally NOT part of this — it is scroll behaviour,
// not detail.
//
// `code` was added after the fact and only Detailed turns it on, so the two
// levels a user is most likely to be sitting on (Compact is the default, Minimal
// the common step up) keep matching their preset across the upgrade. Someone
// already on Detailed lands on "custom" once — the slider still shows where they
// are and one nudge puts them back on a named level, which is why nothing
// silently rewrites their toggles to make the label tidy.
//
// "None" is the exception to "derived from the four toggles", and it has to be:
// all four govern EXPANSION, and no combination of them can say "not shown at
// all". So it is a fifth, separate pref (`ryu:hide-tool-detail`) that
// SHORT-CIRCUITS the derivation — at None the other four are still stored
// exactly as the user left them, they simply have nothing to expand. That is
// also why picking None writes only that one flag: step back up to any other
// level and the toggles come back as they were, instead of having been quietly
// rewritten while the ladder was at the bottom.
export const TOOL_DETAIL_PRESETS = {
	compact: { group: true, edits: false, commands: false, code: false },
	minimal: { group: true, edits: true, commands: false, code: false },
	detailed: { group: false, edits: true, commands: true, code: true },
} as const;

/** The slider's detents, in the order they are rendered (least → most detail). */
export const TOOL_DETAIL_STEPS = [
	{ id: "none", label: "None" },
	{ id: "compact", label: "Compact" },
	{ id: "minimal", label: "Minimal" },
	{ id: "detailed", label: "Detailed" },
] as const;

export type ToolDetailPresetId = keyof typeof TOOL_DETAIL_PRESETS;
export type ToolDetailStepId = (typeof TOOL_DETAIL_STEPS)[number]["id"];
export type ToolDetailValue = ToolDetailStepId | "custom";

/** How many detents describe how much is EXPANDED (every step except None). */
const EXPANSION_STEP_COUNT = TOOL_DETAIL_STEPS.length - 1;

export function deriveToolDetailPreset(
	hideToolDetail: boolean,
	group: boolean,
	edits: boolean,
	commands: boolean,
	code: boolean
): ToolDetailValue {
	// Wins over whatever the four expansion toggles say — there is nothing left
	// on screen for them to describe.
	if (hideToolDetail) {
		return "none";
	}
	for (const [id, preset] of Object.entries(TOOL_DETAIL_PRESETS)) {
		if (
			preset.group === group &&
			preset.edits === edits &&
			preset.commands === commands &&
			preset.code === code
		) {
			// SAFETY: Object.entries returns the own keys of the authored compact/minimal/detailed table. Repository consumers only read this table; the native API erases those exact preset keys to string.
			return id as ToolDetailPresetId;
		}
	}
	return "custom";
}

/**
 * Where the slider thumb sits for a given value. "custom" has no detent of its
 * own — it parks on the nearest level BY COUNT of what is expanded, so a
 * hand-tuned combo reads as roughly-this-much-detail instead of snapping the
 * user's toggles to a preset just to have somewhere to point.
 *
 * Custom parks within the EXPANSION detents only, never on None: "everything
 * collapsed" is still a transcript that shows its tool calls, and parking it on
 * None would label a visible transcript as hidden.
 */
export function toolDetailStepIndex(
	value: ToolDetailValue,
	group: boolean,
	edits: boolean,
	commands: boolean,
	code: boolean
): number {
	if (value !== "custom") {
		return TOOL_DETAIL_STEPS.findIndex((s) => s.id === value);
	}
	const expanded = [!group, edits, commands, code].filter(Boolean).length;
	return (
		1 +
		Math.min(
			EXPANSION_STEP_COUNT - 1,
			Math.round((expanded / 4) * (EXPANSION_STEP_COUNT - 1))
		)
	);
}
