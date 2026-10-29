"use client";

// beui.dev/components/motion/range-slider

import { type SliderOptions, useSlider } from "@ryu/ui/hooks/use-slider.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { motion, useReducedMotion } from "motion/react";
import { useMemo } from "react";

// Per-bar spring: soft enough that the crest wobbles as it travels.
const SPRING_BAR = {
	type: "spring",
	stiffness: 420,
	damping: 20,
	mass: 0.5,
} as const;
/** Bar count that reads as a wave without turning into a stripe pattern. */
const BARS = 32;
/** Width of the crest in bars — bigger spreads the bell wider. */
const SPREAD = 2.6;
/** Cap on the per-bar stagger, so a far bar never lags visibly behind. */
const MAX_BAR_DELAY = 0.12;
const BAR_DELAY_PER_LANE = 0.012;

export interface WaveSliderProps extends SliderOptions {
	/** Number of bars drawn across the track. */
	bars?: number;
	className?: string;
}

/**
 * Equalizer slider: bars rise into a crest around the handle position and fall
 * back as it passes, so the value reads as a travelling wave. Bars up to the
 * value are filled, the rest stay muted. Use it for audio-domain values
 * (volume, gain, input level) — `FluidSlider` is the general settings one.
 */
export function WaveSlider({
	bars = BARS,
	className,
	...options
}: WaveSliderProps) {
	const reduce = useReducedMotion();
	const { percent, dragging, trackProps, sliderProps } = useSlider(options);

	// Keys only change when the bar count does — the list never reorders.
	const keys = useMemo(
		() => Array.from({ length: bars }, (_, i) => `bar-${i}`),
		[bars]
	);

	const head = (percent / 100) * (bars - 1);
	const lanes = keys.map((key, i) => {
		const distance = Math.abs(i - head);
		return {
			key,
			distance,
			// Gaussian crest centred on the handle.
			crest: Math.exp(-(distance ** 2) / (2 * SPREAD ** 2)),
			filled: i <= Math.round(head),
		};
	});

	return (
		<div
			{...trackProps}
			className={cn(
				"relative flex h-20 w-full touch-none select-none items-center justify-between gap-1",
				options.disabled
					? "pointer-events-none opacity-50"
					: "cursor-grab active:cursor-grabbing",
				className
			)}
			data-slot="slider"
		>
			{lanes.map((lane) => (
				<motion.span
					animate={{
						scaleY: reduce ? 0.4 : 0.22 + lane.crest * (dragging ? 0.78 : 0.6),
					}}
					className={cn(
						"h-14 flex-1 origin-center rounded-full",
						// /45 keeps the unfilled track above the 3:1 non-text contrast
						// floor in both themes (measured 4.16 dark / 3.13 light)
						lane.filled ? "bg-foreground" : "bg-foreground/45"
					)}
					key={lane.key}
					transition={
						reduce
							? { duration: 0 }
							: {
									...SPRING_BAR,
									delay: Math.min(
										lane.distance * BAR_DELAY_PER_LANE,
										MAX_BAR_DELAY
									),
								}
					}
				/>
			))}

			<button
				type="button"
				{...sliderProps}
				className="absolute inset-0 touch-none rounded-xl outline-none ring-foreground/30 focus-visible:ring-4"
			/>
		</div>
	);
}
