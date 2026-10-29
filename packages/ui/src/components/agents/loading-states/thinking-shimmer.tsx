import { TextShimmer } from "@ryu/ui/components/motion/text-shimmer.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ReactNode } from "react";

export interface ThinkingShimmerProps {
	/** Loading message shown to the user. */
	children?: ReactNode;
	className?: string;
	/** Seconds taken for one shimmer pass. */
	duration?: number;
}

export function ThinkingShimmer({
	children = "Thinking…",
	duration = 0.9,
	className,
}: ThinkingShimmerProps) {
	return (
		<TextShimmer
			as="span"
			className={cn("font-medium", className)}
			duration={duration}
		>
			{children}
		</TextShimmer>
	);
}
