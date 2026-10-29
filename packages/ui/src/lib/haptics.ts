// Haptic feedback for the touch surfaces.
//
// THREE RULES, and the reason this is a tiny closed vocabulary rather than a
// pass-through to `navigator.vibrate`:
//
//  1. CAUSALITY — fire on the actual causal event (the thing snapping home, the
//     toggle flipping), not when the animation that follows it finishes.
//  2. HARMONY — the visual and the haptic must land on the SAME frame. Call this
//     next to the state change, never inside a transition callback.
//  3. UTILITY — only meaningful moments: a commit, a snap, a success, an error.
//     Buzzing on every tap trains people to ignore all of it, which costs you the
//     four moments that mattered.
//
// SUPPORT, honestly: `navigator.vibrate` is a no-op on macOS and on iOS Safari.
// It is real on Android Chrome. Both the desktop shell and the marketing site are
// served at phone widths, so this is not dead code — but it is also not a
// substitute for a native haptics API, and nothing should depend on it firing.

/** The only moments that earn feedback. Adding a case needs a reason. */
export type HapticKind =
	/** A value locked to a detent, a panel snapped open or shut. */
	| "snap"
	/** An irreversible or consequential action went through. */
	| "commit"
	/** Something completed successfully. */
	| "success"
	/** Something was rejected or failed. */
	| "error";

/**
 * Durations in ms. A pattern alternates vibrate/pause/vibrate.
 * Short and dry: a long buzz reads as an alarm, not as feedback.
 */
const PATTERNS = {
	snap: 8,
	commit: 12,
	success: [10, 40, 10],
	error: [24, 60, 24],
} satisfies Record<HapticKind, number | number[]>;

/**
 * Fire the haptic for a moment, if the device has one. Silently does nothing
 * everywhere else — callers must never branch on the return value to decide
 * whether to also show something visual. The visual is always required; the
 * haptic is the reinforcement.
 */
export function haptic(kind: HapticKind): void {
	if (globalThis.navigator === undefined) {
		return;
	}
	// The DOM owns this method's signature. Engines that omit it, and engines
	// that reject a vibration, both use the same guarded no-op below.
	const vibrate = navigator.vibrate;
	if (!vibrate) {
		return;
	}
	try {
		vibrate(PATTERNS[kind]);
	} catch {
		// A vibration that throws (permissions policy, headless) must never take
		// the interaction down with it.
	}
}
