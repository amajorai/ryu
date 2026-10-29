"use client";

// beui.dev/components/motion/loader
// Frame-based loader variants (spinner, dots, terminal ASCII sets). The canvas
// variants (dither, metaballs, newton, helix, percent) are omitted — this is the
// compact port the agent loading states use.

import { EASE_IN_OUT } from "@ryu/ui/lib/ease.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { motion, useReducedMotion } from "motion/react";
import { type CSSProperties, useEffect, useState } from "react";
import styles from "./loader.module.css";

interface LoaderDrawingStyle extends CSSProperties {
	"--loader-font-size"?: string;
	"--loader-gap"?: string;
	"--loader-part-height"?: string;
	"--loader-part-width"?: string;
}

export type LoaderVariant =
	| "spinner"
	| "dots"
	| "bars"
	| "ascii"
	| "ascii-line"
	| "ascii-braille"
	| "ascii-blocks"
	| "ascii-bounce";

interface AsciiFrameSets {
	ascii: string[];
	"ascii-blocks": string[];
	"ascii-bounce": string[];
	"ascii-braille": string[];
	"ascii-line": string[];
	bars?: never;
	dots?: never;
	spinner?: never;
}

// Terminal-style frame sets — the loaders CLI AI agents cycle through.
const ASCII_SETS: AsciiFrameSets = {
	ascii: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
	"ascii-line": ["|", "/", "-", "\\"],
	"ascii-braille": ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"],
	"ascii-blocks": [
		"▁",
		"▂",
		"▃",
		"▄",
		"▅",
		"▆",
		"▇",
		"█",
		"▇",
		"▆",
		"▅",
		"▄",
		"▃",
		"▂",
	],
	"ascii-bounce": ["⠁", "⠂", "⠄", "⡀", "⢀", "⠠", "⠐", "⠈"],
};

export interface LoaderProps {
	className?: string;
	/** Accessible label announced to screen readers. */
	label?: string;
	/** Base square size in px. Everything scales from this. */
	size?: number;
	/** Seconds per animation cycle. */
	speed?: number;
	/** Which animation to render. */
	variant?: LoaderVariant;
}

// Reduced motion keeps a calm opacity pulse and drops every transform.
const REDUCED = {
	animate: { opacity: [1, 0.4, 1] },
	transition: {
		duration: 1.4,
		ease: EASE_IN_OUT,
		repeat: Number.POSITIVE_INFINITY,
	},
};

interface PartProps {
	reduce: boolean;
	size: number;
	speed: number;
}

function Spinner({ size, speed, reduce }: PartProps) {
	const stroke = Math.max(2, size * 0.09);
	const r = (size - stroke) / 2;
	return (
		<motion.svg
			animate={reduce ? REDUCED.animate : { rotate: 360 }}
			height={size}
			transition={
				reduce
					? REDUCED.transition
					: {
							duration: speed,
							ease: "linear",
							repeat: Number.POSITIVE_INFINITY,
						}
			}
			viewBox={`0 0 ${size} ${size}`}
			width={size}
		>
			<circle
				cx={size / 2}
				cy={size / 2}
				fill="none"
				r={r}
				stroke="currentColor"
				strokeOpacity={0.2}
				strokeWidth={stroke}
			/>
			<path
				d={`M ${size / 2} ${size / 2 - r} A ${r} ${r} 0 0 1 ${size / 2 + r} ${size / 2}`}
				fill="none"
				stroke="currentColor"
				strokeLinecap="round"
				strokeWidth={stroke}
			/>
		</motion.svg>
	);
}

function Dots({ size, speed, reduce }: PartProps) {
	const dot = size * 0.24;
	const gapStyle: LoaderDrawingStyle = { "--loader-gap": `${size * 0.14}px` };
	const dotStyle: LoaderDrawingStyle = {
		"--loader-part-width": `${dot}px`,
		"--loader-part-height": `${dot}px`,
	};
	return (
		<span className={cn("flex items-center", styles.parts)} style={gapStyle}>
			{[0, 1, 2].map((i) => (
				<motion.span
					animate={
						reduce
							? { opacity: [0.4, 1, 0.4] }
							: { y: [0, -size * 0.3, 0], opacity: [0.5, 1, 0.5] }
					}
					className={cn("rounded-full bg-current", styles.part)}
					key={i}
					style={dotStyle}
					transition={{
						duration: speed,
						ease: EASE_IN_OUT,
						repeat: Number.POSITIVE_INFINITY,
						delay: i * speed * 0.16,
					}}
				/>
			))}
		</span>
	);
}

function Bars({ size, speed, reduce }: PartProps) {
	const bar = Math.max(2, size * 0.12);
	const gapStyle: LoaderDrawingStyle = {
		"--loader-gap": `${Math.max(1, size * 0.08)}px`,
	};
	const barStyle: LoaderDrawingStyle = {
		"--loader-part-width": `${bar}px`,
		"--loader-part-height": `${size * 0.55}px`,
	};
	return (
		<span className={cn("flex items-end", styles.parts)} style={gapStyle}>
			{[0, 1, 2, 3].map((i) => (
				<motion.span
					animate={
						reduce ? { opacity: [0.4, 1, 0.4] } : { scaleY: [0.35, 1, 0.35] }
					}
					className={cn(
						"w-1 origin-bottom rounded-full bg-current",
						styles.part
					)}
					key={i}
					style={barStyle}
					transition={{
						duration: speed,
						ease: EASE_IN_OUT,
						repeat: Number.POSITIVE_INFINITY,
						delay: i * speed * 0.12,
					}}
				/>
			))}
		</span>
	);
}

function Ascii({
	frames,
	size,
	speed,
	reduce,
}: PartProps & { frames: string[] }) {
	const [frame, setFrame] = useState(0);
	const asciiStyle: LoaderDrawingStyle = { "--loader-font-size": `${size}px` };
	useEffect(() => {
		// Reduced motion slows the cycle rather than stopping it — it's a glyph
		// swap, not on-screen movement.
		const step = ((reduce ? speed * 2.5 : speed) / frames.length) * 1000;
		const id = setInterval(
			() => setFrame((f) => (f + 1) % frames.length),
			step
		);
		return () => clearInterval(id);
	}, [frames.length, speed, reduce]);

	return (
		<span
			className={cn("font-mono tabular-nums leading-none", styles.ascii)}
			style={asciiStyle}
		>
			{frames[frame % frames.length]}
		</span>
	);
}

export function Loader({
	variant = "spinner",
	size = 32,
	speed = 1,
	label = "Loading",
	className,
}: LoaderProps) {
	const reduce = useReducedMotion() ?? false;

	return (
		<span
			aria-label={label}
			className={cn(
				"inline-flex items-center justify-center text-foreground",
				className
			)}
			role="status"
		>
			{variant === "spinner" && (
				<Spinner reduce={reduce} size={size} speed={speed} />
			)}
			{variant === "dots" && <Dots reduce={reduce} size={size} speed={speed} />}
			{variant === "bars" && <Bars reduce={reduce} size={size} speed={speed} />}
			{ASCII_SETS[variant] && (
				<Ascii
					frames={ASCII_SETS[variant]}
					reduce={reduce}
					size={size}
					speed={speed}
				/>
			)}
			<span className="sr-only">{label}</span>
		</span>
	);
}
