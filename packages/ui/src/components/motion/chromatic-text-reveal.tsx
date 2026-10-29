"use client";

// beui.dev/components/motion/text-animation

import { EASE_IN_OUT, EASE_OUT } from "@ryu/ui/lib/ease.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	type MotionStyle,
	motion,
	type UseInViewOptions,
	useInView,
	useReducedMotion,
} from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";

const CHROMATIC_PALETTE = [
	"#60a5fa",
	"#818cf8",
	"#c084fc",
	"#fb7185",
	"#fbbf24",
];

const TRAIL_HALF_WIDTH = 14;
const REVEAL_START = `-${TRAIL_HALF_WIDTH}%`;
const REVEAL_FINISH = `${100 + TRAIL_HALF_WIDTH}%`;

interface ChromaticStyle extends MotionStyle {
	"--chromatic-gradient": string;
	"--chromatic-sweep": string;
}
export interface ChromaticTextRevealProps {
	className?: string;
	/** Colors used along the moving chromatic edge. */
	colors?: string[];
	/** Delay before the first sweep, in seconds. */
	delay?: number;
	/** Sweep duration in seconds. */
	duration?: number;
	/** Final text color after the sweep passes. */
	foregroundColor?: string;
	/** IntersectionObserver root margin used by the viewport trigger. */
	inViewMargin?: UseInViewOptions["margin"];
	/** Returns to the first word after the final word. */
	loop?: boolean;
	/** Only starts on the first viewport entry. */
	once?: boolean;
	/** Rest after a word finishes revealing, in seconds. */
	pauseDuration?: number;
	/** Sentence fragment that remains fixed while the final word changes. */
	prefix: string;
	/** Starts when the text enters the viewport. */
	startOnView?: boolean;
	/** Words revealed one after another after the fixed prefix. */
	words: string[];
}

function composeChromaticGradient(colors: string[], foregroundColor: string) {
	const palette = colors.length > 0 ? colors : CHROMATIC_PALETTE;
	const colorStops = palette.map((color, index) => {
		const offset =
			palette.length === 1
				? 0
				: -TRAIL_HALF_WIDTH +
					(index / (palette.length - 1)) * TRAIL_HALF_WIDTH * 2;
		const operator = offset < 0 ? "-" : "+";
		const distance = Number(Math.abs(offset).toFixed(2));
		return `${color} calc(var(--chromatic-sweep) ${operator} ${distance}%)`;
	});

	return `linear-gradient(90deg, ${foregroundColor} 0%, ${foregroundColor} calc(var(--chromatic-sweep) - ${TRAIL_HALF_WIDTH}%), ${colorStops.join(", ")}, transparent calc(var(--chromatic-sweep) + ${TRAIL_HALF_WIDTH}%), transparent 100%)`;
}

export function ChromaticTextReveal({
	prefix,
	words,
	colors = CHROMATIC_PALETTE,
	foregroundColor = "var(--foreground)",
	duration = 1.2,
	delay = 0,
	pauseDuration = 0.8,
	loop = true,
	startOnView = true,
	once = true,
	inViewMargin,
	className,
}: ChromaticTextRevealProps) {
	const ref = useRef<HTMLSpanElement>(null);
	const timerRef = useRef<number | null>(null);
	const [wordIndex, setWordIndex] = useState(0);
	const reduceMotion = useReducedMotion();
	const isInView = useInView(ref, {
		once,
		margin: inViewMargin,
		amount: 0.4,
	});
	const shouldReveal = !startOnView || isInView || reduceMotion;
	const backgroundImage = composeChromaticGradient(colors, foregroundColor);
	const hasWords = words.length > 0;
	const activeIndex = hasWords ? wordIndex % words.length : 0;
	const activeWord = words[activeIndex] ?? "";
	const sizingWords = Array.from(new Set(words));

	const clearPendingWord = useCallback(() => {
		if (timerRef.current !== null) {
			window.clearTimeout(timerRef.current);
			timerRef.current = null;
		}
	}, []);

	const scheduleNextWord = useCallback(() => {
		clearPendingWord();
		const isLastWord = activeIndex === words.length - 1;
		if (
			reduceMotion ||
			!shouldReveal ||
			words.length < 2 ||
			(isLastWord && !loop)
		) {
			return;
		}

		timerRef.current = window.setTimeout(() => {
			setWordIndex((index) => (index + 1) % words.length);
		}, pauseDuration * 1000);
	}, [
		activeIndex,
		clearPendingWord,
		loop,
		pauseDuration,
		reduceMotion,
		shouldReveal,
		words.length,
	]);

	useEffect(() => clearPendingWord, [clearPendingWord]);

	const chromaticStyle: ChromaticStyle = {
		"--chromatic-sweep": reduceMotion ? REVEAL_FINISH : REVEAL_START,
		"--chromatic-gradient": backgroundImage,
	};

	return (
		<span className={cn("inline align-baseline", className)} ref={ref}>
			<span className="whitespace-normal">
				{prefix}
				{hasWords ? "\u00A0" : null}
			</span>
			{hasWords ? (
				<span className="relative inline-grid">
					{sizingWords.map((word) => (
						<span
							aria-hidden
							className="invisible col-start-1 row-start-1 whitespace-nowrap"
							key={word}
						>
							{word}
						</span>
					))}
					{/* Moving a clipped text gradient defines this effect. Paint
              containment bounds that deliberate repaint to the active word. */}
					<motion.span
						animate={{
							"--chromatic-sweep": shouldReveal ? REVEAL_FINISH : REVEAL_START,
							opacity: 1,
							filter: "blur(0px)",
							transform: "translateY(0px)",
						}}
						aria-hidden
						className="absolute start-0 top-0 whitespace-nowrap bg-[size:100%_100%] bg-clip-text bg-no-repeat text-transparent [background-image:var(--chromatic-gradient)] [contain:paint]"
						initial={
							reduceMotion
								? false
								: {
										opacity: 0.56,
										filter: "blur(6px)",
										transform: "translateY(5px)",
									}
						}
						key={`${activeWord}-${activeIndex}`}
						onAnimationComplete={scheduleNextWord}
						style={chromaticStyle}
						transition={{
							"--chromatic-sweep": reduceMotion
								? { duration: 0 }
								: { duration, delay, ease: EASE_IN_OUT },
							opacity: reduceMotion
								? { duration: 0 }
								: { duration: 0.28, ease: EASE_OUT },
							filter: reduceMotion
								? { duration: 0 }
								: { duration: 0.36, ease: EASE_OUT },
							transform: reduceMotion
								? { duration: 0 }
								: { duration: 0.36, ease: EASE_OUT },
						}}
					>
						{activeWord}
					</motion.span>
					<span className="sr-only">{activeWord}</span>
				</span>
			) : null}
		</span>
	);
}
