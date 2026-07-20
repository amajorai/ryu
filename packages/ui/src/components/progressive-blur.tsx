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

	return (
		<div
			className={`pointer-events-none absolute left-0 w-full select-none ${className}`}
			style={{
				[isTop ? "top" : "bottom"]: 0,
				height,
				background: isTop
					? `linear-gradient(to top, transparent, ${bgColor})`
					: `linear-gradient(to bottom, transparent, ${bgColor})`,
				// The mask only reads the alpha channel, so use an opaque color
				// (`black`) rather than the theme token — this keeps the fade shape
				// identical regardless of the theme's background lightness.
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
