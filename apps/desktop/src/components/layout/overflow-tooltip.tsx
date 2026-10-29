"use client";

import { useChatDisplayPrefs } from "@ryu/blocks/desktop/agent-elements/chat-display-prefs.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import {
	type ReactElement,
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { cn } from "@/lib/utils.ts";
import { usePrefersReducedMotion } from "@/src/hooks/usePrefersReducedMotion.ts";
import { AnimatedTitle } from "./animated-title.tsx";
import layoutStyles from "./overflow-tooltip.module.css";

// Fades the trailing edge of an overflowing label into transparency instead of
// cutting it with an ellipsis — the text dissolves into the background. Only
// applied while the label is actually clipped, so short labels stay crisp.

// The clipping line. `block` is load-bearing: a bare <span> whose parent is not
// a flex container stays inline, and an inline non-replaced box reports
// clientWidth/scrollWidth as 0 — so the old single-element measurement compared
// 0 against 0, decided "not clipped", and the fade never engaged no matter how
// long the text was.
const CLIP_CLASS = "block min-w-0 overflow-hidden whitespace-nowrap";
// The measured content box. An inline-block sizes to max-content, so its
// scrollWidth is the FULL text width even when the clip box is narrower — which
// is what makes an unbroken (space-free) string measure correctly. `align-bottom`
// keeps the line from shifting when the state changes.
const INNER_CLASS = "inline-block max-w-none align-bottom";
// Streaming/loading treatment (see agent-ui.css). It lives on the INNER span so
// the clip box keeps its fade mask: `background-clip: text` and the mask compose
// instead of fighting.
const SHIMMER_CLASS = cn(
	"an-text-shimmer an-text-shimmer--active",
	layoutStyles.authored1
);
/** Adds the desktop tooltip treatment without adding a layout wrapper. */
export function TitleTooltip({
	children,
	content,
}: {
	children: ReactElement;
	content: ReactNode;
}) {
	return (
		<Tooltip>
			<TooltipTrigger render={children} />
			<TooltipContent>{content}</TooltipContent>
		</Tooltip>
	);
}

/** A clipped line is one whose content is wider than the box showing it. Both
 *  widths must come from the right pair of elements: the CONTENT width off the
 *  max-content inner span, the AVAILABLE width off the block clip box. */
function isClipped(
	clip: HTMLElement | null,
	inner: HTMLElement | null
): boolean {
	if (!clip) {
		return false;
	}
	// Ellipsis (non-fade) labels keep the legacy single-element shape, where the
	// clip box IS the content box; falling back to it keeps that path unchanged.
	return (inner ?? clip).scrollWidth - clip.clientWidth > 1;
}

/**
 * Shared clip + fade measurement behind both `OverflowTooltip` and `FadeLabel`.
 * Re-measures on resize of either box and whenever the text itself changes (a
 * rename keeps the same box width, so the ResizeObserver alone misses it).
 */
function useEdgeFade(text: string, track: boolean) {
	const clipRef = useRef<HTMLSpanElement>(null);
	const innerRef = useRef<HTMLSpanElement>(null);
	const [clipped, setClipped] = useState(false);

	useEffect(() => {
		const clip = clipRef.current;
		const inner = innerRef.current;
		// Ellipsis labels never read `clipped`, so they pay for no observer: their
		// tooltip asks `measureNow()` on hover instead.
		if (!(clip && track)) {
			return;
		}
		const measure = () => setClipped(text.length > 0 && isClipped(clip, inner));
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(clip);
		if (inner) {
			observer.observe(inner);
		}
		return () => observer.disconnect();
	}, [text, track]);

	const measureNow = useCallback(
		() => isClipped(clipRef.current, innerRef.current),
		[]
	);

	return { clipRef, clipped, innerRef, measureNow };
}

/**
 * A one-line label whose clipped edge dissolves into the background instead of
 * ending in an ellipsis, with an optional streaming shimmer. This is the fade
 * mechanism itself; `OverflowTooltip` is this plus a clipped-only tooltip.
 *
 * Use this directly where the row already has its own hover affordance (the
 * sidebar chat rows carry a HoverCard preview, so a second popup would fight it).
 * It intentionally stays static; the shared package UI label is the only
 * hover-scroll owner for controls.
 * Pass sizing/colour classes via `className`; the structural clip classes and
 * the mask are owned here.
 */
export function FadeLabel({
	className,
	shimmer = false,
	text,
}: {
	className?: string;
	shimmer?: boolean;
	text: string;
}) {
	const { clipRef, clipped, innerRef } = useEdgeFade(text, true);
	const { animationsEnabled } = useChatDisplayPrefs();
	const prefersReducedMotion = usePrefersReducedMotion();
	const motionEnabled = animationsEnabled && !prefersReducedMotion;

	return (
		<span
			className={cn(CLIP_CLASS, className, clipped && layoutStyles.fade)}
			ref={clipRef}
		>
			<span
				className={cn(INNER_CLASS, shimmer && motionEnabled && SHIMMER_CLASS)}
				ref={innerRef}
			>
				<AnimatedTitle text={text} />
			</span>
		</span>
	);
}

/** A truncating label whose tooltip only appears when the text is actually
 *  clipped. Without the overflow check the tooltip fires on every hover even
 *  when the full label is already visible — repeating what you can plainly read.
 *  We intercept Base UI's open request and measure the content width against the
 *  clip width: if nothing is clipped, the open is suppressed (closing is always
 *  allowed).
 *
 *  Pass `forceShow` to keep the tooltip even when the label fits — for when the
 *  tooltip carries extra info beyond the visible text (e.g. an "unloaded" hint).
 *  Pass `fade` to dissolve the clipped edge into the background instead of
 *  showing an ellipsis (the caller should drop `truncate`/`text-ellipsis` and
 *  use `overflow-hidden whitespace-nowrap`), and `shimmer` while the title is
 *  still streaming — the shimmer rides the same clip box, so a busy title fades
 *  exactly like a resting one instead of falling back to an ellipsis.
 *  `tooltip` overrides the shown content (defaults to `text`); `align` defaults
 *  to "start" so the bubble lines up with the left edge of the label. */
export function OverflowTooltip({
	align = "start",
	className,
	fade = false,
	forceShow = false,
	shimmer = false,
	text,
	tooltip,
}: {
	align?: "center" | "end" | "start";
	className?: string;
	fade?: boolean;
	forceShow?: boolean;
	shimmer?: boolean;
	text: string;
	tooltip?: ReactNode;
}) {
	const { clipRef, clipped, innerRef, measureNow } = useEdgeFade(text, fade);
	const { animationsEnabled } = useChatDisplayPrefs();
	const prefersReducedMotion = usePrefersReducedMotion();
	const motionEnabled = animationsEnabled && !prefersReducedMotion;
	const [open, setOpen] = useState(false);

	return (
		<Tooltip
			onOpenChange={(next) => {
				if (next && !(forceShow || measureNow())) {
					return;
				}
				setOpen(next);
			}}
			open={open}
		>
			<TooltipTrigger
				render={
					<span
						className={
							fade
								? cn(CLIP_CLASS, className, clipped && layoutStyles.fade)
								: className
						}
						ref={clipRef}
					>
						{fade ? (
							<span
								className={cn(
									INNER_CLASS,
									shimmer && motionEnabled && SHIMMER_CLASS
								)}
								ref={innerRef}
							>
								<AnimatedTitle text={text} />
							</span>
						) : (
							text
						)}
					</span>
				}
			/>
			<TooltipContent align={align}>{tooltip ?? text}</TooltipContent>
		</Tooltip>
	);
}
