import { cn } from "@ryu/ui/lib/utils";
import React from "react";
import styles from "./text-shimmer.module.css";

export interface TextShimmerProps {
	as?: React.ElementType;
	children: React.ReactNode;
	className?: string;
	delay?: number;
	duration?: number;
	spread?: number;
}

interface TextShimmerStyle extends React.CSSProperties {
	"--an-shimmer-duration": string;
	"--an-shimmer-spread": string;
}

function TextShimmerComponent({
	children,
	as: Component = "p",
	className,
	duration = 0.9,
	spread = 100,
	delay = 0,
}: TextShimmerProps) {
	const style: TextShimmerStyle = {
		"--an-shimmer-duration": `${duration}s`,
		"--an-shimmer-spread": `${spread}px`,
		animationDelay: delay > 0 ? `${delay}s` : undefined,
		animationDuration: `${duration}s`,
		animationIterationCount: "infinite",
		animationTimingFunction: "linear",
	};

	return React.createElement(
		Component,
		{
			className: cn(styles.shimmer, styles.active, className),
			style,
		},
		children
	);
}

export const TextShimmer = React.memo(TextShimmerComponent);
