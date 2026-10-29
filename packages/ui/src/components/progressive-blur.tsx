import type { CSSProperties } from "react";
import { cn } from "../lib/utils.ts";

import styles from "./progressive-blur.module.css";

interface ProgressiveBlurDrawingStyle extends CSSProperties {
	"--progressive-blur-background"?: string;
	"--progressive-blur-filter"?: string;
	"--progressive-blur-height"?: string;
}

export interface ProgressiveBlurProps {
	backgroundColor?: string;
	blurAmount?: string;
	className?: string;
	height?: string;
	position?: "top" | "bottom";
	/**
	 * @deprecated The blur now always derives from the live `--background`
	 * theme token, so it tracks the active theme (light/dark and every preset)
	 * without this flag. Retained for API compatibility; it has no effect.
	 */
	useThemeBackground?: boolean;
}

/**
 * ProgressiveBlur creates a frosted glass blur effect with a gradient mask.
 * Used for title bar backgrounds and other overlay effects.
 *
 * The fade color defaults to `var(--background)` — the CSS custom property that
 * the theme system writes onto `<html>` for the active preset (see
 * `@ryu/ui/theme/apply`). That makes the blur follow whatever theme is set in
 * settings, in both light and dark mode, and update live when it changes.
 * Callers may still pass an explicit `backgroundColor` to override it.
 */
export function ProgressiveBlur({
	className = "",
	backgroundColor,
	position = "top",
	height = "150px",
	blurAmount = "4px",
}: ProgressiveBlurProps) {
	const isTop = position === "top";

	// Track the active theme by default: `--background` is set per-preset on
	// <html>, so this resolves (and re-resolves live) to the current theme color.
	const bgColor = backgroundColor ?? "var(--background)";
	const surfaceStyle: ProgressiveBlurDrawingStyle = {
		"--progressive-blur-height": height,
		"--progressive-blur-background": isTop
			? `linear-gradient(to top, transparent, ${bgColor})`
			: `linear-gradient(to bottom, transparent, ${bgColor})`,
	};
	const layerClasses = isTop
		? [styles.topEighth, styles.topQuarter, styles.topHalf, styles.topFull]
		: [
				styles.bottomEighth,
				styles.bottomQuarter,
				styles.bottomHalf,
				styles.bottomFull,
			];

	return (
		<div
			className={`pointer-events-none absolute left-0 w-full select-none ${styles.surface} ${isTop ? styles.topSurface : styles.bottomSurface} ${className}`}
			style={surfaceStyle}
		>
			{[0.125, 0.25, 0.5, 1].map((strength, index) => {
				const layerStyle: ProgressiveBlurDrawingStyle = {
					"--progressive-blur-filter": `blur(calc(${blurAmount} * ${strength}))`,
				};
				return (
					<div
						aria-hidden
						className={cn(layerClasses[index], styles.layer)}
						key={strength}
						style={layerStyle}
					/>
				);
			})}
		</div>
	);
}
