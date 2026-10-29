"use client";

// packages/ui/src/components/text-marquee.tsx
//
// The spell.sh Text Marquee — an endless vertical reel of rows, used on the
// /username marketing page and the referral surfaces to scroll claimed
// usernames. Ported in spirit (same keyframes, same CSS-variable stagger) but
// restyled to this design system and hardened the way the other t-* animations
// are:
//
//  1. The keyframes and the row mask live in globals.css next to every other
//     t-* animation, rather than in a <style> tag here.
//  2. `prefers-reduced-motion` is honored. That matters more than usual here:
//     killing the animation alone would leave the rows frozen at their
//     `--origin` offsets, scattered down the page and mostly invisible. So the
//     reduced-motion branch renders a plain overflow-hidden stack instead — the
//     names still read, they just don't move.
//
// How the stagger works: each row is offset via `translate` to its own start
// point (`--origin`), then the animation moves it from there to `--destination`
// — one row-height per row — with a negative `--delay` that staggers the rows
// so the reel looks continuous. All the math is CSS variables; the component
// only stamps the count and speed.

import { useReducedMotion } from "motion/react";
import { Children, type CSSProperties, type ReactNode } from "react";
import { cn } from "../lib/utils.ts";

interface TextMarqueeStyle extends CSSProperties {
	"--count"?: number;
	"--delay"?: string;
	"--destination"?: string;
	"--duration"?: string;
	"--index"?: number;
	"--marquee-height"?: string;
	"--origin"?: string;
	"--speed"?: number;
}

interface TextMarqueeProps {
	/** Exactly one element per row of the reel. */
	children: ReactNode[];
	className?: string;
	/** Height in px of the visible window. Default 200 (five 40px rows). */
	height?: number;
	/** Static text pinned to the left of the reel (e.g. the domain prefix). */
	prefix?: ReactNode;
	/** Seconds per full pass of the reel, default 1. */
	speed?: number;
}

export function TextMarquee({
	children,
	className,
	height = 200,
	prefix,
	speed = 1,
}: TextMarqueeProps) {
	const reduceMotion = useReducedMotion();
	const count = Children.count(children);
	const windowStyle: TextMarqueeStyle = { "--marquee-height": `${height}px` };

	// Reduced motion: a static, clipped column. The rows are stacked in reading
	// order instead of offset by `--origin`, so the first `height / 40` names
	// are the ones visible — no animation to kill, nothing to hide.
	if (reduceMotion) {
		return (
			<div className={cn("relative flex", className)}>
				<div className="relative flex flex-row items-center gap-1">
					{prefix ? (
						<div className="relative size-auto whitespace-pre">{prefix}</div>
					) : null}
					<div
						className="t-text-marquee-mask relative h-[var(--marquee-height)] w-auto overflow-hidden"
						style={windowStyle}
					>
						{Children.toArray(children)}
					</div>
				</div>
			</div>
		);
	}

	const reelStyle: TextMarqueeStyle = { "--count": count, "--speed": speed };
	return (
		<div className={cn("relative flex", className)}>
			<div className="relative flex h-min w-min flex-row items-center gap-1 overflow-hidden">
				{prefix ? (
					<div className="relative size-auto whitespace-pre">{prefix}</div>
				) : null}
				<div
					className="t-text-marquee-mask relative h-[var(--marquee-height)] w-auto overflow-hidden"
					style={windowStyle}
				>
					<div className="relative h-full" style={reelStyle}>
						{Children.map(children, (child, index) => {
							const rowStyle: TextMarqueeStyle = {
								"--index": index,
								"--origin": "calc((var(--count) - var(--index)) * 100%)",
								"--destination": "calc((var(--index) + 1) * -100%)",
								"--duration": `calc(var(--speed) * ${count}s)`,
								"--delay":
									"calc((var(--duration) / var(--count)) * var(--index) - var(--duration))",
							};
							return (
								<div
									className="flex h-10 items-center [animation:t-text-marquee_var(--duration)_var(--delay)_infinite_linear] [translate:0_var(--origin)]"
									key={index}
									style={rowStyle}
								>
									{child}
								</div>
							);
						})}
					</div>
				</div>
			</div>
		</div>
	);
}

export default TextMarquee;
