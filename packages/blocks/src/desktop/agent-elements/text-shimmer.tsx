import { cn } from "@ryu/ui/lib/utils";
import React from "react";

export interface TextShimmerProps {
	as?: React.ElementType;
	children: React.ReactNode;
	className?: string;
	delay?: number;
	duration?: number;
	spread?: number;
}

function TextShimmerComponent({
	children,
	as: Component = "p",
	className,
	duration = 2,
	spread = 100,
	delay = 0,
}: TextShimmerProps) {
	const style = {
		"--an-shimmer-duration": `${duration}s`,
		"--an-shimmer-spread": `${spread}px`,
		animationDelay: delay > 0 ? `${delay}s` : undefined,
		animationDuration: `${duration}s`,
		animationIterationCount: "infinite",
		animationTimingFunction: "linear",
	} as React.CSSProperties;

	return (
		<Component
			className={cn("an-text-shimmer", "an-text-shimmer--active", className)}
			style={style}
		>
			{children}
		</Component>
	);
}

export const TextShimmer = React.memo(TextShimmerComponent);
