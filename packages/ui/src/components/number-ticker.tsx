"use client";

import { motion, useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";

/**
 * NumberTicker — a slot-machine number animation in the spirit of
 * beui.dev/components/motion/number. Each digit lives in its own vertical
 * column of 0-9 that springs into place; on first view the columns roll up from
 * zero with a staggered entry, and on value changes the digits spin to their
 * new positions. Non-digit characters (currency separators) stay static.
 * Reduced-motion and SSR fall back to plain text to avoid hydration mismatch.
 */
interface NumberTickerProps {
	/**
	 * Apply a motion-blur on the roll-in. Default false — the blur can read as
	 * the digits floating out of baseline alignment with a prefix like "$".
	 */
	blur?: boolean;
	className?: string;
	/** Thousands separators via locale formatting. Default true. */
	locale?: boolean;
	/** Static text rendered before the number (e.g. "$"). */
	prefix?: string;
	/** Per-place entry delay in seconds. Default 0.05. */
	stagger?: number;
	/** Only animate once the element scrolls into view. Default true. */
	startOnView?: boolean;
	/** Static text rendered after the number. */
	suffix?: string;
	/** The number to display. */
	value: number;
}

const DIGIT_STRIP = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
const DIGIT_PATTERN = /\d/;

function DigitColumn({
	digit,
	delay,
	blur,
}: {
	digit: number;
	delay: number;
	blur: boolean;
}) {
	return (
		<span
			className="relative inline-block text-center align-baseline tabular-nums leading-none"
			style={{ height: "1em" }}
		>
			{/* In-flow spacer: fixes the column width + baseline to a real glyph. It
			    is NOT clipped, so the column keeps a true text baseline that lines up
			    with a prefix like "$" (an inline-block with overflow:hidden would
			    instead baseline to its bottom edge, floating the digits upward). */}
			<span aria-hidden className="invisible leading-none">
				0
			</span>
			{/* Clipping lives on an absolutely-positioned layer, so overflow:hidden
			    never touches the outer element's baseline. */}
			<span className="absolute inset-0 overflow-hidden">
				<motion.span
					animate={{ y: `-${digit}em`, filter: "blur(0px)" }}
					aria-hidden
					className="absolute inset-x-0 top-0 flex flex-col items-center"
					initial={{ y: "0em", filter: blur ? "blur(8px)" : "blur(0px)" }}
					transition={{ type: "spring", stiffness: 140, damping: 22, delay }}
				>
					{DIGIT_STRIP.map((d) => (
						<span className="block h-[1em] w-full leading-none" key={d}>
							{d}
						</span>
					))}
				</motion.span>
			</span>
		</span>
	);
}

export function NumberTicker({
	value,
	prefix = "",
	suffix = "",
	className,
	blur = false,
	stagger = 0.05,
	locale = true,
	startOnView = true,
}: NumberTickerProps) {
	const ref = useRef<HTMLSpanElement>(null);
	const reduce = useReducedMotion();
	const inView = useInView(ref, { once: true, amount: 0.4 });
	const [mounted, setMounted] = useState(false);

	useEffect(() => {
		setMounted(true);
	}, []);

	const formatted = locale ? value.toLocaleString("en-US") : String(value);
	const chars = formatted.split("");
	const animate = mounted && !reduce && (!startOnView || inView);

	return (
		<span className={className} ref={ref}>
			{prefix}
			{chars.map((char, index) => {
				const placeFromRight = chars.length - 1 - index;
				if (DIGIT_PATTERN.test(char)) {
					// Key by place (not index) so a column persists across value
					// changes and spins to the new digit instead of remounting.
					return animate ? (
						<DigitColumn
							blur={blur}
							delay={placeFromRight * stagger}
							digit={Number(char)}
							key={`d${placeFromRight}`}
						/>
					) : (
						<span className="tabular-nums" key={`d${placeFromRight}`}>
							{char}
						</span>
					);
				}
				return (
					<span className="tabular-nums" key={`s${placeFromRight}`}>
						{char}
					</span>
				);
			})}
			{suffix}
		</span>
	);
}
