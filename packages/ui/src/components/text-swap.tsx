"use client";

import { cn } from "@ryu/ui/lib/utils.ts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * transitions.dev "text states swap" (04) as a React primitive.
 *
 * Swaps the rendered string in place: the old text slides up + blurs + fades,
 * the new text enters from below. Drive it by changing `children` (e.g. a
 * button label that flips "Activate" -> "Checking..." during an async action).
 *
 * Timing is read from the `--text-swap-dur` CSS variable so it stays in sync
 * with the global motion tokens. Honors prefers-reduced-motion via the shared
 * guard in globals.css.
 */

const DEFAULT_DUR_MS = 150;

function readSwapDurationMs(): number {
	if (typeof window === "undefined") {
		return DEFAULT_DUR_MS;
	}
	const raw = getComputedStyle(document.documentElement).getPropertyValue(
		"--text-swap-dur"
	);
	const parsed = Number.parseFloat(raw);
	return Number.isFinite(parsed) ? parsed : DEFAULT_DUR_MS;
}

interface TextSwapProps {
	children: string;
	className?: string;
}

export function TextSwap({ children, className }: TextSwapProps) {
	const ref = useRef<HTMLSpanElement>(null);
	const [shown, setShown] = useState(children);
	const entering = useRef(false);

	// Phase 1: when the incoming text differs, exit the current text, then
	// commit the new value after one swap duration.
	useEffect(() => {
		if (children === shown) {
			return;
		}
		const el = ref.current;
		if (!el) {
			setShown(children);
			return;
		}
		el.classList.add("is-exit");
		const timer = setTimeout(() => {
			entering.current = true;
			setShown(children);
		}, readSwapDurationMs());
		return () => clearTimeout(timer);
	}, [children, shown]);

	// Phase 2/3: after the new text has committed to the DOM, jump it below
	// (no transition), force a reflow, then release so it animates back to rest.
	// Depends on `shown` so it re-runs on every committed swap — with `[]` it only
	// fired on mount, so `is-exit` was never cleared and swapped-in text stayed
	// invisible (stuck up + blurred + transparent).
	useLayoutEffect(() => {
		if (!entering.current) {
			return;
		}
		entering.current = false;
		const el = ref.current;
		if (!el) {
			return;
		}
		el.classList.remove("is-exit");
		el.classList.add("is-enter-start");
		el.getBoundingClientRect();
		el.classList.remove("is-enter-start");
	}, [shown]);

	return (
		<span className={cn("t-text-swap", className)} ref={ref}>
			{shown}
		</span>
	);
}
