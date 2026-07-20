"use client";

import { cn } from "@ryu/ui/lib/utils.ts";
import type { ReactNode } from "react";

/**
 * transitions.dev "icon swap" (09) as a React primitive.
 *
 * Cross-fades two icons stacked in the same grid cell — copy <-> check,
 * download <-> remove, play <-> pause. Both stay mounted; the inactive one
 * fades out with blur + scale. Pure CSS, driven by the `state` prop. Honors
 * prefers-reduced-motion via the shared guard in globals.css.
 */

interface IconSwapProps {
	a: ReactNode;
	b: ReactNode;
	className?: string;
	state: "a" | "b";
}

export function IconSwap({ state, a, b, className }: IconSwapProps) {
	return (
		<span className={cn("t-icon-swap", className)} data-state={state}>
			<span className="t-icon" data-icon="a">
				{a}
			</span>
			<span className="t-icon" data-icon="b">
				{b}
			</span>
		</span>
	);
}
