"use client";
import { cn } from "@ryu/ui/lib/utils";
import type { CSSProperties } from "react";
import styles from "./progressive-blur.module.css";

interface ProgressiveBlurProps {
	backgroundColor?: string;
	blurAmount?: string;
	className?: string;
	height?: string;
	position?: "top" | "bottom";
	useThemeBackground?: boolean;
}

export function ProgressiveBlur({
	className = "",
	backgroundColor,
	position = "top",
	height = "150px",
	blurAmount = "4px",
}: ProgressiveBlurProps) {
	const isTop = position === "top";

	const bgColor = backgroundColor ?? "var(--background)";

	return (
		<div
			className={cn(
				"pointer-events-none absolute left-0 w-full select-none",
				styles.blur,
				isTop ? styles.top : styles.bottom,
				className
			)}
			style={
				{
					"--blur-height": height,
					"--blur-background": isTop
						? `linear-gradient(to top, transparent, ${bgColor})`
						: `linear-gradient(to bottom, transparent, ${bgColor})`,
					"--blur-amount": blurAmount,
				} satisfies BlurStyle as BlurStyle
			}
		/>
	);
}

interface BlurStyle extends CSSProperties {
	"--blur-amount": string;
	"--blur-background": string;
	"--blur-height": string;
}
