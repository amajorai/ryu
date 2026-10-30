import type React from "react";

export interface GripStyle extends React.CSSProperties {
	"--grip-left": string;
	"--grip-top": string;
	"--grip-transform": string;
	"--grip-transition"?: string;
}

/**
 * A destructive confirmation you perform on the object itself: pull the ticket
 * stub down along its perforation until it tears free. The wrapper is generic — it knows
 * nothing about billing, plans or portals; it takes a child, a label and an
 * `onConfirm`, and it decides when the gesture was deliberate enough to fire.
 *
 * Three properties it has to hold, because they are the entire argument for a
 * gesture over a button:
 *
 *  - **Not triggerable by accident.** The gesture can only start on a dedicated
 *    44×44 grip, must survive `armMs` of dwell before travel counts at all,
 *    aborts if the pointer wanders out of a horizontal corridor, aborts on
 *    `pointercancel`, and needs `threshold` of the card's height. A stray swipe
 *    over the card does nothing — the card is not the control, the grip is.
 *  - **Reversible until it completes.** Letting go short of the threshold
 *    springs the stub back and fires `onAbort`. Nothing is dispatched until
 *    progress reaches 1, and once it has, nothing — not Escape, not a second
 *    press — can undo it from inside: the only way back is {@link
 *    CutToConfirmProps.resetKey}, which the caller bumps when the action it
 *    handed off to failed.
 *  - **Reachable without a pointer, and without a drag.** The grip IS the
 *    keyboard control (a `role="slider"`), not a parallel "are you sure?"
 *    button — one control, one mental model. It also accepts discrete TAPS,
 *    one {@link STEP} each, which is what keeps the gesture at WCAG 2.2 AA:
 *    2.5.7 (Dragging Movements) is explicit that a keyboard route does not
 *    excuse a drag-only control, and 2.5.1 (Path-Based Gestures) is failed by
 *    the corridor, which makes the positions BETWEEN the ends load-bearing.
 *    Five deliberate acts either way; see {@link KEY_DELTAS} for why
 *    `End`/`PageUp` are unbound.
 */
export interface CutToConfirmProps {
	/** ms the pointer must rest on the grip before travel counts. Default 120. */
	armMs?: number;
	/** The live card. Rendered exactly once — see the note on {@link CutToConfirm}. */
	children: React.ReactNode;
	className?: string;
	/** Horizontal corridor, px. Leaving it aborts. Default 56. */
	corridorPx?: number;
	disabled?: boolean;
	/** Accessible name, e.g. "Tear the stub to cancel your Max plan". */
	label: string;
	/** An armed gesture abandoned before threshold. For copy, not for effects. */
	onAbort?: () => void;
	/** Fires ONCE, after the tear animation, when progress reaches 1. */
	onConfirm: () => void;
	/** Lock the owning dialog once the tear has committed. */
	onTearStart?: () => void;
	renderHint?: (progress: number) => React.ReactNode;
	/**
	 * Change this to put the card back together after a committed gesture. The
	 * commit latch is deliberately one-way from the inside, so a caller whose
	 * `onConfirm` FAILED has no other way to make "try again" true: without it
	 * the card stays invisible, the grip stays inert, and the hint still reads
	 * as if the handoff were in flight.
	 */
	resetKey?: number | string;
	/** The grip's end position as a fraction of card height. Default 0.92. */
	threshold?: number;
}

export const DEFAULT_ARM_MS = 120;
export const DEFAULT_CORRIDOR_PX = 56;
export const DEFAULT_THRESHOLD = 0.92;
/** The grip is a touch target first: 44px is the smallest one that is not a dare. */
export const GRIP_PX = 44;
/** Movement during the dwell window that reads as a flick rather than a grab. */
export const ARM_SLOP_PX = 8;
/** One deliberate act — one arrow press, one tap. Five of them commit. */
export const STEP = 0.2;
/**
 * Five presses to commit. `ArrowDown` adds and `ArrowUp` subtracts; `End`/
 * `PageUp`/`PageDown` are deliberately absent: on a normal
 * slider `End` jumps to the maximum, which here would let ONE keypress cancel a
 * subscription. Auto-repeat is dropped in the handler for the same reason — a
 * HELD arrow is also one keypress, at a repeat rate the OS picks, not us.
 * `Home` and `Escape` still zero it, because retreating in one keypress is
 * always safe, so neither is guarded against repeat.
 */
export const KEY_DELTAS = new Map<string, number>([
	["ArrowDown", STEP],
	["ArrowUp", -STEP],
]);
/** How long the card takes to come apart before `onConfirm` fires. */
export const TEAR_MS = 420;
/** The spring-back when an armed gesture is abandoned. */
export const RETURN_MS = 260;
export const PERCENT = 100;
export const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
