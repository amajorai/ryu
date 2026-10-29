"use client";

// beui.dev/components/agents/loading-states/reasoning-text

import { Loader } from "@ryu/ui/components/motion/loader.tsx";
import { TextScramble } from "@ryu/ui/components/motion/text-scramble.tsx";
import { TextMorph } from "@ryu/ui/components/text-morph.tsx";
import { EASE_OUT, EASE_OUT_CSS, SPRING_SWAP } from "@ryu/ui/lib/ease.ts";
import {
	TEXT_SHIMMER_CLASS_NAME,
	type TextShimmerStyle,
	textShimmerStyle,
} from "@ryu/ui/lib/text-shimmer.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useEffect, useId, useState } from "react";

const DEFAULT_PHRASES = [
	"Thinking",
	"Reading the context",
	"Connecting the details",
	"Forming a response",
];

const CASCADE_STAGGER = 0.025;

export type ReasoningTextVariant = "cascade" | "swap" | "scramble";

export interface ReasoningTextProps {
	className?: string;
	/** Optional leading visual. Defaults to a terminal-style ASCII loader. */
	indicator?: ReactNode;
	/** Milliseconds each phrase remains visible. */
	interval?: number;
	/** Phrases cycled through while the agent works. */
	phrases?: string[];
	/** Seconds taken for one shimmer pass. */
	shimmerDuration?: number;
	/** Animation used when the active phrase changes. */
	variant?: ReasoningTextVariant;
}

interface PhraseProps {
	phrase: string;
	reduce: boolean;
	shimmerDuration: number;
}

function CascadePhrase({ phrase, reduce, shimmerDuration }: PhraseProps) {
	const shimmerStyle: TextShimmerStyle = {
		"--text-shimmer-duration":
			textShimmerStyle(shimmerDuration)["--text-shimmer-duration"],
	};
	const text = `${phrase}…`;

	if (reduce) {
		return (
			<span
				className={cn(
					"col-start-1 row-start-1 inline-block justify-self-start whitespace-pre",
					TEXT_SHIMMER_CLASS_NAME
				)}
				style={shimmerStyle}
			>
				{text}
			</span>
		);
	}

	return (
		<AnimatePresence initial={false}>
			<motion.span
				animate="animate"
				className="col-start-1 row-start-1 inline-block justify-self-start whitespace-pre"
				exit="exit"
				initial="initial"
				key={phrase}
			>
				{text.split("").map((character, characterIndex) => (
					<motion.span
						className={cn(
							"inline-block whitespace-pre will-change-[opacity,transform]",
							TEXT_SHIMMER_CLASS_NAME
						)}
						custom={characterIndex * CASCADE_STAGGER}
						key={characterIndex}
						style={shimmerStyle}
						variants={{
							initial: { opacity: 0, y: "100%" },
							animate: (delay: number) => ({
								opacity: 1,
								y: "0%",
								transition: { ...SPRING_SWAP, delay },
							}),
							exit: (delay: number) => ({
								opacity: 0,
								y: "-100%",
								transition: {
									duration: 0.14,
									ease: EASE_OUT,
									delay: delay * 0.45,
								},
							}),
						}}
					>
						{character}
					</motion.span>
				))}
			</motion.span>
		</AnimatePresence>
	);
}

function SwapPhrase({ phrase, reduce, shimmerDuration }: PhraseProps) {
	const shimmerStyle: TextShimmerStyle = {
		"--text-shimmer-duration":
			textShimmerStyle(shimmerDuration)["--text-shimmer-duration"],
	};
	return (
		<TextMorph
			className={cn(
				"col-start-1 row-start-1 justify-self-start whitespace-nowrap",
				TEXT_SHIMMER_CLASS_NAME
			)}
			disabled={reduce}
			duration={320}
			ease={EASE_OUT_CSS}
			numbers={false}
			style={shimmerStyle}
		>
			{phrase}…
		</TextMorph>
	);
}

function ScramblePhrase({ phrase, shimmerDuration }: PhraseProps) {
	const shimmerStyle: TextShimmerStyle = {
		"--text-shimmer-duration":
			textShimmerStyle(shimmerDuration)["--text-shimmer-duration"],
	};
	const target = `${phrase}…`;

	return (
		<TextScramble
			className={cn(
				"col-start-1 row-start-1 justify-self-start tabular-nums",
				TEXT_SHIMMER_CLASS_NAME
			)}
			style={shimmerStyle}
			text={target}
		/>
	);
}

export function ReasoningText({
	phrases = DEFAULT_PHRASES,
	variant = "cascade",
	interval = 1800,
	shimmerDuration = 0.9,
	indicator,
	className,
}: ReasoningTextProps) {
	const reduce = useReducedMotion() ?? false;
	const [index, setIndex] = useState(0);
	const statusId = useId();
	const safePhrases = phrases.length > 0 ? phrases : DEFAULT_PHRASES;
	const phrase = (safePhrases[index % safePhrases.length] ??
		safePhrases[0] ??
		DEFAULT_PHRASES[0])!;
	const longestPhrase = safePhrases.reduce((longest, current) =>
		current.length > longest.length ? current : longest
	);
	const phraseProps = { phrase, reduce, shimmerDuration };

	useEffect(() => {
		if (safePhrases.length < 2) {
			return;
		}

		const timer = window.setInterval(
			() => {
				setIndex((current) => (current + 1) % safePhrases.length);
			},
			Math.max(600, interval)
		);

		return () => window.clearInterval(timer);
	}, [interval, safePhrases.length]);

	return (
		<span
			aria-labelledby={statusId}
			aria-live="polite"
			className={cn(
				"inline-flex items-center gap-2 font-medium text-muted-foreground text-sm",
				className
			)}
			role="status"
		>
			<span
				aria-hidden="true"
				className="inline-flex size-3 shrink-0 items-center justify-center"
			>
				{indicator ?? (
					<Loader
						label="Reasoning"
						size={14}
						speed={0.8}
						variant="ascii-line"
					/>
				)}
			</span>

			<span aria-hidden="true" className="grid overflow-hidden text-left">
				<span className="invisible col-start-1 row-start-1 whitespace-nowrap">
					{longestPhrase}…
				</span>
				{variant === "cascade" ? (
					<CascadePhrase {...phraseProps} />
				) : variant === "scramble" ? (
					<ScramblePhrase {...phraseProps} />
				) : (
					<SwapPhrase {...phraseProps} />
				)}
			</span>

			<span className="sr-only" id={statusId}>
				{phrase}
			</span>
		</span>
	);
}
