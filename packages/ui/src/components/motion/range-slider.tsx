"use client";

// beui.dev/components/motion/range-slider

import type { MotionStyle } from "motion/react";
import type { CSSProperties } from "react";
import css from "./range-slider.module.css";

interface Inline1Style extends MotionStyle {
	"--range-slider-1-background-color"?: MotionStyle["backgroundColor"];
	"--range-slider-1-width"?: MotionStyle["width"];
}
interface Inline2Style extends CSSProperties {
	"--range-slider-2-left"?: CSSProperties["left"];
}
interface Inline3Style extends MotionStyle {
	"--range-slider-3-left"?: MotionStyle["left"];
	"--range-slider-3-x"?: MotionStyle["x"];
	"--range-slider-3-y"?: MotionStyle["y"];
}

import { type SliderOptions, useSlider } from "@ryu/ui/hooks/use-slider.ts";
import { SPRING_GLIDE } from "@ryu/ui/lib/ease.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	motion,
	useMotionTemplate,
	useMotionValue,
	useReducedMotion,
	useSpring,
	useTransform,
} from "motion/react";
import { useEffect } from "react";

// Bouncy grab feedback for the thumb scale only.
const SPRING_BOUNCY = {
	type: "spring",
	stiffness: 500,
	damping: 14,
	mass: 0.7,
} as const;

/** Above this many steps the dots read as a stripe pattern, so they are hidden. */
const MAX_TICKS = 50;

export interface RangeSliderProps extends SliderOptions {
	className?: string;
	/**
	 * Colour of the filled span, as any CSS colour. Left unset the fill keeps its
	 * neutral `foreground/15` tone; set it when the level itself carries meaning
	 * (the composer's effort ladder ramps its fill green → purple) and the change
	 * cross-fades as the value moves.
	 */
	fillColor?: string;
	/** Render a tick dot at each step. */
	showTicks?: boolean;
}

/**
 * Stepped slider: a tick dot per step and a vertical-bar thumb that bounces as
 * it lands on each one. The discrete counterpart to `FluidSlider` — use it when
 * the value is one of a handful of named levels, not a continuous amount.
 */
export function RangeSlider({
	showTicks = true,
	className,
	fillColor,
	...options
}: RangeSliderProps) {
	const reduce = useReducedMotion();
	const { percent, dragging, min, max, step, trackProps, sliderProps } =
		useSlider(options);

	// Spring-smoothed position drives both the thumb and the fill.
	const target = useMotionValue(percent);
	useEffect(() => {
		target.set(percent);
	}, [percent, target]);
	const smooth = useSpring(target, SPRING_GLIDE);
	const pos = reduce ? target : smooth;
	const left = useMotionTemplate`${pos}%`;
	// Self-offset the thumb from 0% (flush left) to -100% (flush right) of its
	// own width so it stays fully inside the track at both ends — no clip, no gap.
	const thumbX = useTransform(pos, (p) => `${-p}%`);

	// Floor rather than round, so a range the step does not divide (0 to 10 by 4)
	// stops its dots at the last whole step instead of drawing one past max.
	// toFixed comes first because 0.3/0.1 is 2.9999999999999996, which would
	// floor to 2 and drop the last dot.
	const steps = Math.floor(Number(((max - min) / step).toFixed(6)));
	const ticks =
		showTicks && steps > 0 && steps <= MAX_TICKS
			? Array.from({ length: steps + 1 }, (_, i) =>
					Number((min + i * step).toFixed(6))
				)
			: [];

	const inline1Style: Inline1Style = {
		"--range-slider-1-width": left,
		"--range-slider-1-background-color": fillColor,
	};
	const inline3Style: Inline3Style = {
		"--range-slider-3-left": left,
		"--range-slider-3-x": thumbX,
		"--range-slider-3-y": "-50%",
	};
	return (
		<div
			{...trackProps}
			className={cn(
				"relative flex h-10 w-full touch-none select-none items-center overflow-hidden rounded-lg bg-muted",
				options.disabled
					? "pointer-events-none opacity-50"
					: "cursor-grab active:cursor-grabbing",
				className
			)}
			data-slot="slider"
		>
			{/* fill — runs from the left edge to the thumb. Neutral by default; a
			    `fillColor` tints it and cross-fades as the value lands elsewhere. */}
			<motion.div
				className={[
					css.inline1,
					cn(
						"absolute inset-y-0 left-0",
						fillColor
							? [
									css.fillTint,
									"transition-[background-color] duration-300 ease-out",
								]
							: "bg-foreground/15"
					),
				].join(" ")}
				style={inline1Style}
			/>

			{/* Ticks, inset by half the thumb's width. That inset is the span the
			    thumb's own centre travels, so a dot sits where the thumb lands. */}
			<div className="pointer-events-none absolute inset-x-[3px] inset-y-0">
				{ticks.map((t) => {
					const tp = ((t - min) / (max - min)) * 100;
					const inline2Style: Inline2Style = {
						"--range-slider-2-left": `${tp}%`,
					};
					return (
						<span
							className={[
								css.inline2,
								"absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/25",
							].join(" ")}
							key={t}
							style={inline2Style}
						/>
					);
				})}
			</div>

			{/* vertical bar thumb — contained at both ends via thumbX */}
			<motion.div
				{...sliderProps}
				animate={reduce ? undefined : { scaleY: dragging ? 1.35 : 1 }}
				className={[
					css.inline3,
					"absolute top-1/2 h-5 w-1.5 rounded-sm bg-foreground shadow-sm outline-none ring-foreground/30 ring-inset focus-visible:ring-4",
				].join(" ")}
				data-slot="slider-thumb"
				style={inline3Style}
				transition={SPRING_BOUNCY}
			/>
		</div>
	);
}
