"use client";

import { TextMorph } from "@ryu/ui/components/text-morph.tsx";
import { useMediaQuery } from "@ryu/ui/hooks/use-mobile.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { AnimatePresence, motion } from "motion/react";
import { Children, type ReactNode, useEffect, useState } from "react";
import { isNativeText } from "../lib/native-primitive-observation.ts";

export interface TextLoopProps {
	children: ReactNode[];
	className?: string;
	/** Seconds between states. */
	interval?: number;
	/** Keeps the first state static when false. */
	trigger?: boolean;
}

/**
 * A compact rotating text primitive for labels that share one line of space.
 * It follows the Motion Primitives Text Loop shape while keeping the product's
 * global motion preference at the call site through `trigger`.
 */
export function TextLoop({
	children,
	className,
	interval = 2,
	trigger = true,
}: TextLoopProps) {
	const items = Children.toArray(children);
	const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
	const shouldAnimate = trigger && !reduceMotion && items.length > 1;
	const [index, setIndex] = useState(0);

	useEffect(() => {
		setIndex((current) => (items.length > 0 ? current % items.length : 0));
	}, [items.length]);

	useEffect(() => {
		if (!shouldAnimate) {
			return;
		}
		const timer = window.setInterval(
			() => {
				setIndex((current) => (current + 1) % items.length);
			},
			Math.max(250, interval * 1000)
		);
		return () => window.clearInterval(timer);
	}, [interval, items.length, shouldAnimate]);

	if (items.length === 0) {
		return null;
	}

	if (!shouldAnimate) {
		return <span className={cn("truncate", className)}>{items[0]}</span>;
	}

	const textItems = items.every((item): item is string => isNativeText(item))
		? items
		: null;
	if (textItems) {
		const longestText = textItems.reduce(
			(longest, item) => (item.length > longest.length ? item : longest),
			textItems[0] ?? ""
		);
		return (
			<span
				aria-atomic="true"
				aria-live="polite"
				className={cn("inline-grid min-w-0 max-w-full", className)}
			>
				<span
					aria-hidden="true"
					className="invisible col-start-1 row-start-1 min-w-0 max-w-full truncate"
				>
					{longestText}
				</span>
				<TextMorph
					className="col-start-1 row-start-1 min-w-0 max-w-full truncate"
					duration={280}
				>
					{textItems[index] ?? ""}
				</TextMorph>
			</span>
		);
	}

	return (
		<span
			aria-atomic="true"
			aria-live="polite"
			className={cn("inline-grid min-w-0 max-w-full", className)}
		>
			<AnimatePresence initial={false} mode="popLayout">
				<motion.span
					animate={{ opacity: 1, y: 0 }}
					className="col-start-1 row-start-1 min-w-0 truncate"
					exit={{ opacity: 0, y: -5 }}
					initial={{ opacity: 0, y: 5 }}
					key={index}
					transition={{ duration: 0.2, ease: "easeOut" }}
				>
					{items[index]}
				</motion.span>
			</AnimatePresence>
		</span>
	);
}
