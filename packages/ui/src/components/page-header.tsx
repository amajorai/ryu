"use client";

import { useInView } from "motion/react";
import type { CSSProperties, ReactNode } from "react";
import { useRef } from "react";
import { cn } from "../lib/utils.ts";

interface PageHeaderProps {
	/**
	 * The heading element to render the title as. Defaults to `h1` — the routed
	 * page's own header. A page that already has its `h1` and wants this same
	 * title/subtitle pair for a SECTION further down must pass `h2`, otherwise
	 * the page ships two `h1`s and its heading outline stops describing it.
	 */
	as?: "h1" | "h2" | "h3";
	className?: string;
	/**
	 * Set to `false` where the header is already inside a `StaggerReveal`. That
	 * wrapper reveals the header as one line among its siblings, so leaving the
	 * internal cascade on would compound the two — 24px of travel and a double
	 * blur on the same text.
	 */
	stagger?: boolean;
	style?: CSSProperties;
	subtitle?: ReactNode;
	subtitleClassName?: string;
	title: ReactNode;
	titleClassName?: string;
}

/**
 * The title/subtitle pair every routed page opens with.
 *
 * The two lines rise, sharpen and fade in one after the other once the header
 * scrolls into view, via the shared `.t-stagger` reveal in globals.css. Nothing
 * about the motion lives here: the durations, the 40ms offset between the lines
 * and the `prefers-reduced-motion` fallback (lines rest visible rather than
 * invisible) are all carried by those classes.
 *
 * `useInView` fires immediately for anything already on screen, so a header at
 * the top of a page and one far below the fold need no separate mount path. The
 * default `margin` is deliberate — the landing blocks' `-80px` shrinks the root
 * box, which would delay a header sitting inside a short modal.
 */
export function PageHeader({
	as: Heading = "h1",
	title,
	subtitle,
	className,
	titleClassName,
	stagger = true,
	style,
	subtitleClassName,
}: PageHeaderProps) {
	const ref = useRef<HTMLDivElement>(null);
	const inView = useInView(ref, { once: true });
	const shown = stagger && inView;

	return (
		<div
			className={cn(
				"space-y-1 text-left",
				stagger && "t-stagger",
				shown && "is-shown",
				className
			)}
			ref={ref}
			style={style}
		>
			<Heading
				className={cn(
					"font-medium text-xl",
					stagger && "t-stagger-line t-stagger-line--1",
					titleClassName
				)}
			>
				{title}
			</Heading>
			{subtitle ? (
				<p
					className={cn(
						"font-medium text-muted-foreground text-xl",
						stagger && "t-stagger-line t-stagger-line--2",
						subtitleClassName
					)}
				>
					{subtitle}
				</p>
			) : null}
		</div>
	);
}

export default PageHeader;
