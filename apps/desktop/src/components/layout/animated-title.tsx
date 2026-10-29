import { useChatDisplayPrefs } from "@ryu/blocks/desktop/agent-elements/chat-display-prefs.tsx";
import { TextMorph } from "@ryu/ui/components/text-morph.tsx";
import { EASE_OUT_CSS } from "@ryu/ui/lib/ease.ts";
import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils.ts";
import { usePrefersReducedMotion } from "@/src/hooks/usePrefersReducedMotion.ts";

const MORPH_DURATION_MS = 380;
const TRANSITION_STATE_MS = 760;

/**
 * Desktop title transition backed by Torph's per-character text morph. The
 * component keeps the app-level animation preference separate from Torph's OS
 * reduced-motion preference and retains the settled/transitioning state used by
 * browser proof and title consumers.
 */
export function AnimatedTitle({
	className,
	text,
}: {
	className?: string;
	text: string;
}) {
	const { animationsEnabled } = useChatDisplayPrefs();
	const prefersReducedMotion = usePrefersReducedMotion();
	const motionEnabled = animationsEnabled && !prefersReducedMotion;
	const previousTextRef = useRef(text);
	const [transitioning, setTransitioning] = useState(false);

	useLayoutEffect(() => {
		const previous = previousTextRef.current;
		if (previous === text) {
			return;
		}
		previousTextRef.current = text;

		if (!motionEnabled) {
			setTransitioning(false);
			return;
		}

		setTransitioning(true);
		const timeout = window.setTimeout(() => {
			setTransitioning(false);
		}, TRANSITION_STATE_MS);

		return () => window.clearTimeout(timeout);
	}, [motionEnabled, text]);

	return (
		<span
			className={cn(
				"relative inline-block whitespace-pre align-bottom",
				className
			)}
			data-animated-title
			data-animated-title-state={transitioning ? "transitioning" : "settled"}
		>
			<TextMorph
				className="whitespace-pre"
				disabled={!motionEnabled}
				duration={MORPH_DURATION_MS}
				ease={EASE_OUT_CSS}
				numbers={false}
			>
				{text}
			</TextMorph>
		</span>
	);
}
