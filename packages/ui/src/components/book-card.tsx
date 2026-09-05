"use client";

// A collection item rendered as a physical book — front cover, printed spine and
// a visible fore-edge of pages — vendored from smoothui's `Book`
// (https://smoothui.dev/docs/components/book) and re-expressed in our tokens.
//
// Kept purely presentational on purpose: a Library collection shelf owns each
// item's opening and any nested controls. Baking one consumer's interaction
// model into this shape component would make the presentation less reusable, so
// the surface owns behavior and this file only draws.
//
// Two things about the geometry are load-bearing:
//  - `width` is a real px number, not a percentage. The fore-edge is positioned
//    with `translateX(calc(width - depth/2 …))` and the depth is `29cqw`, so both
//    resolve against the book's own container query — a fluid width makes the
//    pages detach from the cover.
//  - The extrusion is the fore-edge (right), not the spine, because the hover
//    tilt is `rotateY(-20deg)`: that swings the right edge toward the viewer. The
//    spine stays a printed band on the cover's left, which is also where its
//    label reads.
//
// Extensions are REQUIRED on the `@ryu/ui` import — see the header comment in
// `entity-avatar.tsx` for why an extensionless specifier resolves to nothing on
// web (and only on web).

import { cn } from "@ryu/ui/lib/utils.ts";
import { useReducedMotion } from "motion/react";
import type { CSSProperties, ReactNode } from "react";

/** How far the block of pages sticks out behind the cover, in container-query
 *  units so it tracks whatever width the consumer picked. */
const BOOK_DEPTH = "29cqw";
/** Rounder on the spine edge than the fore-edge, like a real hardback. */
const BOOK_RADIUS = "6px 4px 4px 6px";
const DEFAULT_WIDTH = 176;
/** Cover proportions — a trade paperback, not a square card. */
const BOOK_ASPECT = "49 / 60";

/** The binding: a sheen highlight over a shadow ramp, so the cover creases into
 *  the spine instead of ending flat. Achromatic on purpose — this is paper
 *  shading, so it is mixed from the theme's own ink and paper rather than a
 *  hardcoded grey that only reads right in one mode. */
const BINDING_SHEEN = [
	"linear-gradient(90deg,",
	"transparent 0%,",
	"transparent 12%,",
	"color-mix(in oklch, var(--color-background) 25%, transparent) 29.25%,",
	"transparent 50.5%,",
	"transparent 75.25%,",
	"color-mix(in oklch, var(--color-background) 25%, transparent) 91%,",
	"transparent 100%),",
	"linear-gradient(90deg,",
	"color-mix(in oklch, var(--color-foreground) 3%, transparent) 0%,",
	"color-mix(in oklch, var(--color-foreground) 10%, transparent) 12%,",
	"transparent 30%,",
	"color-mix(in oklch, var(--color-foreground) 2%, transparent) 50%,",
	"color-mix(in oklch, var(--color-foreground) 20%, transparent) 73.5%,",
	"color-mix(in oklch, var(--color-foreground) 50%, transparent) 75.25%,",
	"color-mix(in oklch, var(--color-foreground) 15%, transparent) 85.25%,",
	"transparent 100%)",
].join(" ");

/** The cut edge of the paper block: brighter where it meets the cover, falling
 *  away into the gutter. */
const PAGE_EDGES = [
	"linear-gradient(90deg,",
	"color-mix(in oklch, var(--color-foreground) 9%, var(--color-card)) 0%,",
	"transparent 70%),",
	"linear-gradient(var(--color-card),",
	"color-mix(in oklch, var(--color-foreground) 5%, var(--color-card)))",
].join(" ");

/** Three stacked shadows — contact, lift, ambient — so the book sits on the page
 *  instead of floating. Inline rather than a `shadow-[…]` utility: Tailwind
 *  rewrites an arbitrary box-shadow's colour into `--tw-shadow-color`, which
 *  swallows the `color-mix` alpha and leaves three OPAQUE ink-coloured shadows.
 *  Verified against the built stylesheet, not assumed. */
const BOOK_SHADOW = [
	"0 1px 1px color-mix(in oklch, var(--color-foreground) 4%, transparent),",
	"0 4px 8px -4px color-mix(in oklch, var(--color-foreground) 16%, transparent),",
	"0 16px 24px -8px color-mix(in oklch, var(--color-foreground) 10%, transparent)",
].join(" ");

export interface BookCardProps {
	className?: string;
	/** Full-bleed art for the cover's upper band — an avatar, a glyph, a thumbnail. */
	coverArt?: ReactNode;
	/** Rendered under the title, e.g. a count or a kind chip. */
	footer?: ReactNode;
	/** Text printed down the spine. Defaults to `title`; rendered `aria-hidden`
	 *  because it repeats what the cover already says. */
	spineLabel?: string;
	/** Printed on the cover. */
	title: string;
	/** Cover width in px. Must be a number — see the geometry note above. */
	width?: number;
}

/**
 * One item drawn as a 3D book. Tilts open on hover (and when a `group` ancestor
 * is hovered or keyboard-focused, so the surface wrapping it can drive the tilt
 * from its own focus ring), and stands still under `prefers-reduced-motion`.
 */
export function BookCard({
	className,
	coverArt,
	footer,
	spineLabel,
	title,
	width = DEFAULT_WIDTH,
}: BookCardProps) {
	const reducedMotion = useReducedMotion();
	const bookWidth = `${width}px`;

	return (
		<div
			className={cn("inline-block w-fit", className)}
			style={{ perspective: "900px" }}
		>
			<div
				className={cn(
					"relative w-fit [container-type:inline-size] [transform-style:preserve-3d]",
					// Written out in full rather than composed from a variable: Tailwind
					// scans source text, so an interpolated class name is never emitted.
					reducedMotion
						? null
						: [
								"transition-transform duration-[250ms] ease-out",
								"hover:[transform:rotateY(-20deg)_scale(1.05)_translateX(-8px)]",
								"group-hover:[transform:rotateY(-20deg)_scale(1.05)_translateX(-8px)]",
								"group-focus-visible:[transform:rotateY(-20deg)_scale(1.05)_translateX(-8px)]",
							]
				)}
				style={{ aspectRatio: BOOK_ASPECT, minWidth: bookWidth }}
			>
				{/* Front cover */}
				<div
					className="absolute flex flex-col overflow-hidden bg-card [transform:translateZ(0px)]"
					style={{
						borderRadius: BOOK_RADIUS,
						boxShadow: BOOK_SHADOW,
						height: "100%",
						width: bookWidth,
					}}
				>
					<div className="flex h-full w-full flex-row items-stretch">
						{/* Spine. The sheen is a separate absolutely-positioned child
						    because it blends in `overlay` — printing the label inside it
						    would blend the text away too. */}
						<div className="relative flex min-w-[9%] items-center justify-center overflow-hidden">
							<div
								aria-hidden
								className="absolute inset-0 mix-blend-overlay"
								style={{ background: BINDING_SHEEN }}
							/>
							<span
								aria-hidden
								className="relative truncate font-medium text-[7cqw] text-muted-foreground leading-none tracking-tight [text-orientation:mixed] [writing-mode:vertical-rl]"
								style={{ maxHeight: "80%" }}
							>
								{spineLabel ?? title}
							</span>
						</div>

						<div className="flex min-w-0 flex-1 flex-col">
							{/* Cover art band — muted rather than a brand colour, so the art
							    (usually a generative dither avatar) carries the hue. */}
							<div className="relative flex-1 overflow-hidden bg-muted [transform:translateZ(0px)]">
								{coverArt}
							</div>
							<div
								className="flex flex-col justify-between gap-[6.1%] p-[6.1%] [container-type:inline-size]"
								style={{ minHeight: "34%" }}
							>
								<span className="line-clamp-3 text-balance font-medium text-[11cqw] text-card-foreground leading-[1.25em] tracking-[-0.02em]">
									{title}
								</span>
								{footer ? (
									<span className="truncate text-[8cqw] text-muted-foreground leading-none">
										{footer}
									</span>
								) : null}
							</div>
						</div>
					</div>

					{/* Hairline so the cover reads as a printed board, not a flat div. */}
					<div
						aria-hidden
						className="pointer-events-none absolute inset-0 border border-border"
						style={{ borderRadius: "inherit" }}
					/>
				</div>

				{/* The block of pages, stood on end at the fore-edge. */}
				<div
					aria-hidden
					className="pointer-events-none absolute"
					style={
						{
							background: PAGE_EDGES,
							height: "calc(100% - 6px)",
							top: "3px",
							transform: `translateX(calc(${bookWidth} - ${BOOK_DEPTH} / 2 - 3px)) rotateY(90deg) translateX(calc(${BOOK_DEPTH} / 2))`,
							width: `calc(${BOOK_DEPTH} - 2px)`,
						} as CSSProperties
					}
				/>

				{/* Back cover, so the tilt does not reveal a hollow shell. */}
				<div
					aria-hidden
					className="pointer-events-none absolute left-0 bg-card"
					style={{
						borderRadius: BOOK_RADIUS,
						height: "100%",
						transform: `translateZ(calc(-1 * ${BOOK_DEPTH}))`,
						width: bookWidth,
					}}
				/>
			</div>
		</div>
	);
}
