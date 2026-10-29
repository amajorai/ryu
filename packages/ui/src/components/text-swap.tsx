"use client";

import { TextMorph } from "@ryu/ui/components/text-morph.tsx";
import { EASE_OUT_CSS } from "@ryu/ui/lib/ease.ts";

/**
 * Backwards-compatible text-state swap backed by the shared Torph morph.
 *
 * Existing callers keep the same API while the characters in the old and new
 * labels match and travel into their new positions. This is intentionally
 * short because the component is used for button feedback.
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
