import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils.ts";

interface AutoScrollTextProps {
	/** Rendered content — usually the same text, optionally with inline accents. */
	children: ReactNode;
	/** Classes for the clipping line (sizing + color), e.g. "flex-1 text-muted-foreground". */
	className?: string;
	/** Full text for the hover tooltip (shown only when the line is clipped). */
	title: string;
}

// Roughly px-per-second of scroll travel; higher = slower, easier to read.
const MS_PER_PIXEL = 26;
const MIN_TRAVEL_MS = 1600;
// A hair of extra travel so the last glyph clears the edge before reversing.
const EDGE_PADDING_PX = 6;

/**
 * A single line of text that gently ping-pong auto-scrolls when it overflows its
 * container — so an over-long engine name or username stays fully readable — and
 * surfaces the whole value as a hover tooltip. When the text fits it renders as a
 * plain static line: no motion, no tooltip. Honors `prefers-reduced-motion` by
 * falling back to a static ellipsis (the tooltip still exposes the full value).
 * Scrolling pauses while hovered so the reader (and the tooltip) can catch up.
 */
export function AutoScrollText({
	title,
	children,
	className,
}: AutoScrollTextProps) {
	const textRef = useRef<HTMLSpanElement>(null);
	const [overflowing, setOverflowing] = useState(false);
	const [animating, setAnimating] = useState(false);

	useEffect(() => {
		const inner = textRef.current;
		const clip = inner?.parentElement;
		if (!(inner && clip)) {
			return;
		}

		let animation: Animation | undefined;

		const measure = () => {
			const overflow = inner.scrollWidth - clip.clientWidth;
			const isOverflowing = overflow > 1;

			animation?.cancel();
			animation = undefined;

			const reduceMotion = window.matchMedia(
				"(prefers-reduced-motion: reduce)"
			).matches;

			if (isOverflowing && !reduceMotion) {
				const distance = overflow + EDGE_PADDING_PX;
				const duration = Math.max(
					MIN_TRAVEL_MS,
					Math.round(distance * MS_PER_PIXEL)
				);
				animation = inner.animate(
					[
						{ transform: "translateX(0)", offset: 0 },
						{ transform: "translateX(0)", offset: 0.2 },
						{ transform: `translateX(-${distance}px)`, offset: 0.8 },
						{ transform: `translateX(-${distance}px)`, offset: 1 },
					],
					{
						duration,
						iterations: Number.POSITIVE_INFINITY,
						direction: "alternate",
						easing: "ease-in-out",
					}
				);
			}

			setOverflowing(isOverflowing);
			setAnimating(Boolean(animation));
		};

		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(clip);
		observer.observe(inner);
		return () => {
			observer.disconnect();
			animation?.cancel();
		};
	}, []);

	const setPaused = (paused: boolean) => {
		for (const anim of textRef.current?.getAnimations() ?? []) {
			if (paused) {
				anim.pause();
			} else {
				anim.play();
			}
		}
	};

	const line = (
		<span
			className={cn(
				"block min-w-0 overflow-hidden whitespace-nowrap",
				className
			)}
		>
			<span
				className={cn(
					"inline-block align-bottom will-change-transform",
					// Static ellipsis only when we're NOT scrolling (fits / reduced motion).
					animating ? "" : "max-w-full truncate"
				)}
				onPointerEnter={() => setPaused(true)}
				onPointerLeave={() => setPaused(false)}
				ref={textRef}
			>
				{children}
			</span>
		</span>
	);

	return (
		<Tooltip>
			<TooltipTrigger render={line} />
			{overflowing ? <TooltipContent>{title}</TooltipContent> : null}
		</Tooltip>
	);
}
