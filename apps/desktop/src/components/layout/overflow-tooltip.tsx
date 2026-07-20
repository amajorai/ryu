"use client";

import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import {
	type CSSProperties,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";

// Fades the trailing edge of an overflowing label into transparency instead of
// cutting it with an ellipsis — the text dissolves into the background. Only
// applied while the label is actually clipped, so short labels stay crisp.
const FADE_GRADIENT =
	"linear-gradient(to right, #000 calc(100% - 2.5rem), transparent)";
const FADE_STYLE: CSSProperties = {
	maskImage: FADE_GRADIENT,
	WebkitMaskImage: FADE_GRADIENT,
};

/** A truncating label whose tooltip only appears when the text is actually
 *  clipped. Without the overflow check the tooltip fires on every hover even
 *  when the full label is already visible — repeating what you can plainly read.
 *  We intercept Base UI's open request and measure scrollWidth vs clientWidth:
 *  if nothing is clipped, the open is suppressed (closing is always allowed).
 *
 *  Pass `forceShow` to keep the tooltip even when the label fits — for when the
 *  tooltip carries extra info beyond the visible text (e.g. an "unloaded" hint).
 *  Pass `fade` to dissolve the clipped edge into the background instead of
 *  showing an ellipsis (the caller should drop `truncate`/`text-ellipsis` and
 *  use `overflow-hidden whitespace-nowrap`). `tooltip` overrides the shown
 *  content (defaults to `text`); `align` defaults to "start" so the bubble
 *  lines up with the left edge of the label. */
export function OverflowTooltip({
	align = "start",
	className,
	fade = false,
	forceShow = false,
	text,
	tooltip,
}: {
	align?: "center" | "end" | "start";
	className?: string;
	fade?: boolean;
	forceShow?: boolean;
	text: string;
	tooltip?: ReactNode;
}) {
	const ref = useRef<HTMLSpanElement>(null);
	const [open, setOpen] = useState(false);
	// Whether the label is currently clipped — drives the fade mask so it only
	// engages when there is hidden text. Re-measured whenever the label or its
	// container resizes (e.g. the sidebar is dragged narrower).
	const [clipped, setClipped] = useState(false);

	useEffect(() => {
		if (!fade) {
			return;
		}
		const el = ref.current;
		if (!el) {
			return;
		}
		// Reading `text` keeps the measurement in sync when the label is renamed
		// (a content change that doesn't resize the flex box the observer watches).
		const measure = () =>
			setClipped(text.length > 0 && el.scrollWidth > el.clientWidth);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, [fade, text]);

	return (
		<Tooltip
			onOpenChange={(next) => {
				if (next && !forceShow) {
					const el = ref.current;
					if (!el || el.scrollWidth <= el.clientWidth) {
						return;
					}
				}
				setOpen(next);
			}}
			open={open}
		>
			<TooltipTrigger
				render={
					<span
						className={className}
						ref={ref}
						style={fade && clipped ? FADE_STYLE : undefined}
					>
						{text}
					</span>
				}
			/>
			<TooltipContent align={align}>{tooltip ?? text}</TooltipContent>
		</Tooltip>
	);
}
