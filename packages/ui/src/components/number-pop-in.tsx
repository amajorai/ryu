"use client";

import { cn } from "@ryu/ui/lib/utils.ts";
import { useEffect, useRef } from "react";

/**
 * transitions.dev "number pop-in" (02) as a React primitive.
 *
 * Each character animates in from `--digit-distance` with blur when `value`
 * changes; the last two characters stagger by `--digit-stagger` so decimals /
 * trailing digits feel alive. Use for counters, prices, progress totals. Honors
 * prefers-reduced-motion via the shared guard in globals.css.
 */

function staggerFor(index: number, length: number): "1" | "2" | undefined {
	if (index === length - 2) {
		return "1";
	}
	if (index === length - 1) {
		return "2";
	}
	return undefined;
}

interface NumberPopInProps {
	className?: string;
	value: string | number;
}

export function NumberPopIn({ value, className }: NumberPopInProps) {
	const text = String(value);
	const groupRef = useRef<HTMLSpanElement>(null);
	const previous = useRef(text);

	useEffect(() => {
		if (previous.current === text) {
			return;
		}
		previous.current = text;
		const group = groupRef.current;
		if (!group) {
			return;
		}
		// Replay the per-digit animation: drop the class, force a reflow, re-add.
		group.classList.remove("is-animating");
		group.getBoundingClientRect();
		group.classList.add("is-animating");
	}, [text]);

	const chars = [...text];
	return (
		<span
			className={cn("t-digit-group is-animating", className)}
			ref={groupRef}
		>
			{chars.map((char, index) => (
				<span
					className="t-digit"
					data-stagger={staggerFor(index, chars.length)}
					// Positional digit cells: index identity is intentional so a digit
					// changing in place replays rather than remounting.
					key={`${index}-${char}`}
				>
					{char}
				</span>
			))}
		</span>
	);
}
