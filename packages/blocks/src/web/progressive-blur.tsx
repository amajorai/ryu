"use client";

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
			className={`pointer-events-none absolute left-0 w-full select-none ${className}`}
			style={{
				[isTop ? "top" : "bottom"]: 0,
				height,
				background: isTop
					? `linear-gradient(to top, transparent, ${bgColor})`
					: `linear-gradient(to bottom, transparent, ${bgColor})`,
				maskImage: isTop
					? "linear-gradient(to bottom, black 50%, transparent)"
					: "linear-gradient(to top, black 50%, transparent)",
				WebkitBackdropFilter: `blur(${blurAmount})`,
				backdropFilter: `blur(${blurAmount})`,
				WebkitUserSelect: "none",
				userSelect: "none",
			}}
		/>
	);
}
