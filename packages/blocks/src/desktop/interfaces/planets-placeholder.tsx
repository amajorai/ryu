import { cn } from "@ryu/ui/lib/utils";
import { motion } from "motion/react";
import { useMemo } from "react";
import type { HudLayout, PlanetSystem } from "./planets-model.ts";
import { OVERVIEW_INTRO_SCALE, overviewSketch } from "./planets-model.ts";
import { type PlanetsPalette, sunBloom, sunSwatch } from "./planets-palette.ts";

/** A sketch star when the scene's size is not known yet (server render, tests). */
const FALLBACK_SUN = 22;
const MIN_SUN = 16;
const PULSE = {
	duration: 2.4,
	ease: "easeInOut",
	repeat: Number.POSITIVE_INFINITY,
} as const;

/** How long the placeholder takes to fade once the scene has drawn, ms. */
export const PLACEHOLDER_FADE_MS = 360;

/**
 * What the scene shows while it gets ready (data still loading, the 3D chunk
 * downloading, shaders compiling): you, the star, softly pulsing at the exact
 * spot the scene will draw it, with faint orbits where the planets will be.
 * Once the scene draws, `fading` fades it out (a plain CSS transition, so it
 * finishes on time even while the first frames keep the main thread busy).
 * The sketch only matches the overview camera: a scene that opens on a
 * visited body (a thread already open) gets a small status pill instead.
 */
export function PlanetsPlaceholder({
	fading,
	hud,
	overview,
	palette,
	reduced,
	size,
	system,
}: {
	fading: boolean;
	hud: HudLayout;
	/** The scene opens on the overview, where the sketch lines up. */
	overview: boolean;
	palette: PlanetsPalette;
	reduced: boolean;
	size: { height: number; width: number };
	system: PlanetSystem;
}) {
	const wrapper = cn(
		"pointer-events-none absolute inset-0 z-[5] transition-opacity ease-out motion-reduce:transition-none",
		fading ? "opacity-0" : "opacity-100"
	);
	const fade = { transitionDuration: `${reduced ? 0 : PLACEHOLDER_FADE_MS}ms` };
	const measured = size.width > 0 && size.height > 0;
	// The scene's first frame is the start of its intro, a little farther out.
	// Framing is costly, so the sketch is redrawn only when its inputs change.
	const sketch = useMemo(
		() =>
			overview && measured
				? overviewSketch(
						system,
						{ height: size.height, width: size.width },
						hud,
						reduced ? 1 : OVERVIEW_INTRO_SCALE
					)
				: null,
		[overview, measured, system, size.height, size.width, hud, reduced]
	);
	if (!overview) {
		return (
			<div
				className={cn(wrapper, "flex items-center justify-center")}
				data-testid="planets-placeholder"
				style={fade}
			>
				<span
					className="flex items-center gap-2 rounded-full border border-border/60 bg-background/90 px-3 py-1.5 text-muted-foreground text-xs shadow-foreground/5 shadow-sm"
					role="status"
				>
					<motion.span
						animate={reduced ? undefined : { opacity: [0.6, 1, 0.6] }}
						aria-hidden="true"
						className="size-2.5 rounded-full"
						style={{ background: sunSwatch(palette.sun) }}
						transition={reduced ? undefined : PULSE}
					/>
					{fading ? "" : "Charting your system…"}
				</span>
			</div>
		);
	}
	const sunRadius = sketch ? Math.max(MIN_SUN, sketch.sunRadius) : FALLBACK_SUN;
	const centre = sketch
		? { left: `${sketch.centre.x}px`, top: `${sketch.centre.y}px` }
		: { left: "50%", top: "50%" };
	return (
		<div className={wrapper} data-testid="planets-placeholder" style={fade}>
			<span className="sr-only" role="status">
				{fading ? "" : "Charting your system…"}
			</span>
			{sketch ? (
				<svg
					aria-hidden="true"
					className="absolute inset-0 size-full fill-none stroke-foreground/15"
					height={size.height}
					viewBox={`0 0 ${size.width} ${size.height}`}
					width={size.width}
				>
					{sketch.orbits.map((path) => (
						// Orbits differ in radius, so each path is its own key.
						<path d={path} key={path} strokeWidth={1} />
					))}
				</svg>
			) : null}
			<div aria-hidden="true" className="absolute size-0" style={centre}>
				<motion.span
					animate={
						reduced
							? undefined
							: { opacity: [0.85, 1, 0.85], scale: [1, 1.06, 1] }
					}
					className="absolute rounded-full"
					style={{
						background: sunSwatch(palette.sun),
						boxShadow: sunBloom(palette.sun),
						height: sunRadius * 2,
						left: -sunRadius,
						top: -sunRadius,
						width: sunRadius * 2,
					}}
					transition={reduced ? undefined : PULSE}
				/>
				<span
					className="absolute -translate-x-1/2 whitespace-nowrap rounded-full border border-border/60 bg-background/90 px-2.5 font-semibold text-foreground text-xs leading-5 shadow-foreground/5 shadow-sm"
					style={{ top: sunRadius + 8 }}
				>
					You
				</span>
			</div>
		</div>
	);
}
