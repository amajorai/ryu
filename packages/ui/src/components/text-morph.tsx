"use client";

import {
	TextMorph as TorphTextMorph,
	type TextMorphProps as TorphTextMorphProps,
} from "torph/react";

/**
 * Ryu's shared entry point for character-level text morphing.
 *
 * Torph keeps the accessible value as plain text and animates only the visual
 * segments. The wrapper owns the Ryu defaults so product surfaces share one
 * duration, easing curve, and reduced-motion policy while still exposing the
 * upstream text-only API. Torph sets `white-space: nowrap`, so morphed text
 * stays on one line; use it for short labels, not sentences that may wrap.
 */
export type TextMorphProps = TorphTextMorphProps;

const DEFAULT_DURATION_MS = 240;
const DEFAULT_EASE = "cubic-bezier(0.16, 1, 0.3, 1)";

export function TextMorph({
	duration = DEFAULT_DURATION_MS,
	ease = DEFAULT_EASE,
	respectReducedMotion = true,
	...props
}: TextMorphProps) {
	return (
		<TorphTextMorph
			{...props}
			duration={duration}
			ease={ease}
			respectReducedMotion={respectReducedMotion}
		/>
	);
}
