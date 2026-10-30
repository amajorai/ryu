import { useChatDisplayPrefs } from "@ryu/blocks/desktop/agent-elements/chat-display-prefs.tsx";
import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils.ts";
import { usePrefersReducedMotion } from "@/src/hooks/usePrefersReducedMotion.ts";

/** Matches `--duration-fast`: the new title fades in over the old one's slot. */
const TRANSITION_STATE_MS = 150;

/**
 * Desktop title transition: a quiet 150ms opacity crossfade when the text
 * changes (no per-character morph). It honours the app-level animation
 * preference and the OS reduced-motion preference, and keeps the
 * settled/transitioning state used by browser proof and title consumers.
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
			<span
				className={cn(
					"whitespace-pre",
					transitioning &&
						"fade-in-0 animate-in duration-(--duration-fast) ease-enter"
				)}
				key={motionEnabled ? text : undefined}
			>
				{text}
			</span>
		</span>
	);
}
