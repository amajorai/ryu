"use client";

import { cn } from "@ryu/ui/lib/utils.ts";
import { useReducedMotion } from "motion/react";
import type { CSSProperties, ReactNode } from "react";

import styles from "./voice-activity-beam.module.css";

interface VoiceGlowStyle extends CSSProperties {
	"--voice-glow-opacity": number;
	"--voice-glow-scale": number;
}

export interface VoiceActivityBeamProps {
	active?: boolean;
	children?: ReactNode;
	className?: string;
	/** Rolling mic RMS values, oldest-to-newest. */
	levels: readonly number[];
	/** Sweep a bright beam across the glow while the assistant is thinking. */
	processing?: boolean;
}

function clampLevel(level: number): number {
	return Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
}

function peakLevel(levels: readonly number[]): number {
	return levels
		.slice(-8)
		.reduce((peak, level) => Math.max(peak, clampLevel(level)), 0);
}

/** A sound-reactive, multicolor glow anchored to the bottom edge of a voice surface. */
export function VoiceActivityBeam({
	active = true,
	children,
	levels,
	processing = false,
	className,
}: VoiceActivityBeamProps) {
	const reducedMotion = useReducedMotion() ?? false;
	const level = active ? peakLevel(levels) : 0;
	const glowScale = reducedMotion
		? 0.46 + level * 0.24 + (processing ? 0.08 : 0)
		: 0.46 + level * 0.96 + (processing ? 0.14 : 0);
	const glowStyle: VoiceGlowStyle = {
		"--voice-glow-opacity": active
			? 0.52 + level * 0.42
			: processing
				? 0.5
				: 0.04,
		"--voice-glow-scale": glowScale,
	};

	return (
		<div
			className={cn("relative isolate flex min-h-7 shrink-0", className)}
			data-active={active}
			data-processing={processing}
			data-voice-activity-beam="glow"
		>
			{children ? (
				<div className="relative z-10 flex h-full min-h-7 w-full items-center px-3">
					{children}
				</div>
			) : null}
			<div
				aria-hidden="true"
				className="pointer-events-none absolute inset-0 z-0"
			>
				<div
					className={cn(
						"voice-activity-beam__glow absolute inset-x-[-16%] bottom-[-40%] h-[180%] mix-blend-screen",
						styles.glowPaint
					)}
					data-voice-glow
					data-voice-level={level.toFixed(2)}
					style={glowStyle}
				/>
				{processing ? (
					reducedMotion ? (
						<div
							className={cn(
								"absolute inset-y-[-18%] left-1/3 w-1/3 mix-blend-screen blur-[20px]",
								styles.sweepStill
							)}
							data-voice-processing-sweep
						/>
					) : (
						<div
							className={cn(
								"voice-activity-beam__sweep absolute inset-y-[-18%] left-[-20%] w-[48%] mix-blend-screen blur-[20px]",
								styles.sweepAnimated
							)}
							data-voice-processing-sweep
						/>
					)
				) : null}
			</div>
		</div>
	);
}
