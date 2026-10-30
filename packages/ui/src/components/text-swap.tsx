"use client";

import { TextMorph } from "@ryu/ui/components/text-morph.tsx";
import { EASE_OUT_CSS } from "@ryu/ui/lib/ease.ts";

/**
 * Backwards-compatible text-state swap backed by the shared Torph morph.
 *
 * Existing callers keep the same API while the characters in the old and new
 * labels match and travel into their new positions. This is intentionally
 * short because the component is used for button feedback.
 *
 * Single-line only: Torph lays the characters out with `white-space: nowrap`,
 * so text passed through TextSwap never wraps. Keep it to short labels (button
 * text, status words); render a sentence that may need a second line as plain
 * text instead.
 */

interface TextSwapProps {
	children: string;
	className?: string;
}

export function TextSwap({ children, className }: TextSwapProps) {
	return (
		<TextMorph className={className} duration={160} ease={EASE_OUT_CSS}>
			{children}
		</TextMorph>
	);
}
