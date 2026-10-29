"use client";

// beui.dev/components/motion/range-slider

import type { MotionStyle } from "motion/react";
import type { CSSProperties } from "react";
import css from "./range-slider-fluid.module.css";

interface Inline1Style extends MotionStyle {
	"--range-slider-fluid-1-clip-path"?: MotionStyle["clipPath"];
}
interface Inline2Style extends CSSProperties {
	"--range-slider-fluid-2-color"?: CSSProperties["color"];
}

import { useContrastInk } from "@ryu/ui/hooks/use-contrast-ink.ts";
import { type SliderOptions, useSlider } from "@ryu/ui/hooks/use-slider.ts";
import { SPRING_GLIDE, SPRING_PRESS } from "@ryu/ui/lib/ease.ts";
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

/** Decimal places implied by the step, so 0.025 reads "0.375", not "0.375000001". */
function decimalsForStep(step: number): number {
	const s = step.toString();
	const dot = s.indexOf(".");
	return dot === -1 ? 0 : s.length - dot - 1;
}

export interface FluidSliderProps extends SliderOptions {
	className?: string;
	/** Formats the value shown on the right. */
	format?: (value: number) => string;
	/** Text shown on the left of the track. */
	label?: string;
}

/**
 * Thumbless slider: the whole pill is the control. The fill glides to the new
 * value behind a rounded liquid cap, and the label reads inverted wherever the
 * fill has covered it.
 *
 * Deviation from upstream: `format` defaults to the step's own precision rather
 * than a `%` suffix, so it is a drop-in for `ElasticSlider` — every settings
 * call site that passed no formatter keeps rendering the bare number it did.
 */
export function FluidSlider({
	label,
	// The value arrives already snapped to the step. Rounding it again would
	// only make the label and the announcement disagree with aria-valuenow.
	format,
	className,
	...options
}: FluidSliderProps) {
	const reduce = useReducedMotion();
	// The fill is `--primary`, which the Appearance colour picker and plugin
	// themes can set to anything — so the label that rides on top of it resolves
	// its ink from the live token rather than assuming light-on-brand.
	const fillInk = useContrastInk("--primary");
	const step = options.step ?? 1;
	const formatValue =
		format ?? ((v: number) => v.toFixed(decimalsForStep(step)));
	const { percent, current, dragging, trackProps, sliderProps } = useSlider({
		...options,
		"aria-label": options["aria-label"] ?? label,
		formatValueText: options.formatValueText ?? formatValue,
	});

	const target = useMotionValue(percent);
	useEffect(() => {
		target.set(percent);
	}, [percent, target]);
	const smooth = useSpring(target, SPRING_GLIDE);
	const pos = reduce ? target : smooth;
	// Reveal the fill by clipping a full-width layer rather than animating its
	// width: at 0% the clip is empty, so no hairline of a sub-pixel-wide box is
	// left behind, and the label inside is never scaled or re-laid out.
	const uncovered = useTransform(pos, (v) => 100 - v);
	const clipPath = useMotionTemplate`inset(0 ${uncovered}% 0 0 round 9999px)`;

	const row = (
		<>
			{label ? <span className="truncate">{label}</span> : <span />}
			<span className="tabular-nums">{formatValue(current)}</span>
		</>
	);

	const inline1Style: Inline1Style = {
		"--range-slider-fluid-1-clip-path": clipPath,
	};
	const inline2Style: Inline2Style = {
		"--range-slider-fluid-2-color": fillInk,
	};
	return (
		<motion.div
			{...trackProps}
			animate={reduce ? undefined : { scale: dragging ? 1.03 : 1 }}
			className={cn(
				"relative flex h-12 w-full touch-none select-none overflow-hidden rounded-full bg-muted",
				options.disabled
					? "pointer-events-none opacity-50"
					: "cursor-grab active:cursor-grabbing",
				className
			)}
			data-slot="slider"
			transition={SPRING_PRESS}
		>
			{/* uncovered label — sits on the muted track */}
			<div className="pointer-events-none absolute inset-0 flex items-center justify-between px-5 font-medium text-foreground text-sm">
				{row}
			</div>

			{/* fill + the same label, both clipped to the value, so the text inverts
			    as the fill covers it and lines up glyph for glyph with the copy
			    underneath. The clip's rounded right edge is the liquid cap. */}
			<motion.div
				className={[css.inline1, "absolute inset-0"].join(" ")}
				style={inline1Style}
			>
				<div className="absolute inset-0 bg-primary" />
				<div
					className={[
						css.inline2,
						"pointer-events-none absolute inset-0 flex items-center justify-between px-5 font-medium text-sm",
					].join(" ")}
					style={inline2Style}
				>
					{row}
				</div>
			</motion.div>

			{/* focusable, keyboard-controlled handle surface. The ring is inset — an
			    outset one is clipped away by the track's overflow-hidden. */}
			<button
				type="button"
				{...sliderProps}
				className="absolute inset-0 touch-none rounded-full outline-none ring-primary/40 ring-inset focus-visible:ring-4"
			/>
		</motion.div>
	);
}
