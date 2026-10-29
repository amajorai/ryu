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
import styles from "./book-card.module.css";

/** How far the block of pages sticks out behind the cover, in container-query
 *  units so it tracks whatever width the consumer picked. */
interface BookStyle extends CSSProperties {
	"--book-depth": string;
	"--book-width": string;
}

const DEFAULT_WIDTH = 176;

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
	const bookStyle: BookStyle = {
		"--book-width": `${width}px`,
		"--book-depth": "29cqw",
	};

	return (
		<div
			className={cn("inline-block w-fit", styles.scene, className)}
			data-slot="book-card"
		>
			<div
				className={cn(
					"relative w-fit",
					styles.book,
					reducedMotion
						? null
						: ["transition-transform duration-[250ms] ease-out", styles.motion]
				)}
				style={bookStyle}
			>
				{/* Front cover */}
				<div
					className={cn(
						"absolute flex flex-col overflow-hidden bg-card",
						styles.cover
					)}
				>
					<div className="flex h-full w-full flex-row items-stretch">
						{/* Spine. The sheen is a separate absolutely-positioned child
						    because it blends in `overlay` — printing the label inside it
						    would blend the text away too. */}
						<div
							className={cn(
								"relative flex items-center justify-center overflow-hidden",
								styles.spine
							)}
						>
							<div
								aria-hidden
								className={cn(
									"absolute inset-0 mix-blend-overlay",
									styles.binding
								)}
							/>
							<span
								aria-hidden
								className={cn(
									"relative truncate font-medium text-muted-foreground leading-none tracking-tight",
									styles.spineLabel
								)}
							>
								{spineLabel ?? title}
							</span>
						</div>

						<div className="flex min-w-0 flex-1 flex-col">
							{/* Cover art band — muted rather than a brand colour, so the art
							    (usually a generative dither avatar) carries the hue. */}
							<div
								className={cn(
									"relative flex-1 overflow-hidden bg-muted",
									styles.art
								)}
							>
								{coverArt}
							</div>
							<div
								className={cn("flex flex-col justify-between", styles.caption)}
							>
								<span
									className={cn(
										"line-clamp-3 text-balance font-medium text-card-foreground",
										styles.title
									)}
								>
									{title}
								</span>
								{footer ? (
									<span
										className={cn(
											"truncate text-muted-foreground leading-none",
											styles.footer
										)}
									>
										{footer}
									</span>
								) : null}
							</div>
						</div>
					</div>

					{/* Hairline so the cover reads as a printed board, not a flat div. */}
					<div
						aria-hidden
						className={cn(
							"pointer-events-none absolute inset-0 border border-border",
							styles.hairline
						)}
					/>
				</div>

				{/* The block of pages, stood on end at the fore-edge. */}
				<div
					aria-hidden
					className={cn("pointer-events-none absolute", styles.pages)}
				/>

				{/* Back cover, so the tilt does not reveal a hollow shell. */}
				<div
					aria-hidden
					className={cn(
						"pointer-events-none absolute left-0 bg-card",
						styles.back
					)}
				/>
			</div>
		</div>
	);
}
