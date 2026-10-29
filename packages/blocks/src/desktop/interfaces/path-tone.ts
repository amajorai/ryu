import type { PathTone } from "./path-model.ts";

/**
 * Class sets for a unit's color role. Every value is a theme token, so the
 * path follows the user's palette: the first unit takes the theme's primary,
 * the next its warning role, then a berry (the primary turned toward the
 * destructive hue in OKLCH), then a teal (the success and info roles mixed at
 * a fixed lightness, `--path-teal` in path-palette.ts, so it reads the same
 * in light and dark themes). Teal
 * differs from the primary in hue as well as lightness, so it never repeats
 * its neighbor in a lilac or blue theme. The theme's chart tokens are not used:
 * every stock preset leaves them grayscale, which would flatten the units.
 */
export interface PathToneClasses {
	/** Outlines in the unit color (callout bubbles). */
	border: string;
	/** Solid fill: unit banners and finished stops. */
	fill: string;
	/** Text in the unit color on the page background (callouts). */
	ink: string;
	/** Text and icons on `fill`. */
	onFill: string;
	/** Faces cut out of a banner (avatar rings). */
	ring: string;
	/** SVG strokes (progress arcs). */
	stroke: string;
}

export const PATH_TONES = {
	berry: {
		border:
			"border-[color-mix(in_oklch,var(--color-primary)_62%,var(--color-destructive))]",
		fill: "bg-[color-mix(in_oklch,var(--color-primary)_62%,var(--color-destructive))]",
		ink: "text-[color-mix(in_oklch,color-mix(in_oklch,var(--color-primary)_62%,var(--color-destructive))_80%,var(--color-foreground))]",
		onFill: "text-primary-foreground",
		ring: "ring-[color-mix(in_oklch,var(--color-primary)_62%,var(--color-destructive))]",
		stroke:
			"stroke-[color-mix(in_oklch,var(--color-primary)_62%,var(--color-destructive))]",
	},
	primary: {
		border: "border-primary",
		fill: "bg-primary",
		ink: "text-primary",
		onFill: "text-primary-foreground",
		ring: "ring-primary",
		stroke: "stroke-primary",
	},
	teal: {
		border: "border-(--path-teal)",
		fill: "bg-(--path-teal)",
		ink: "text-(--path-teal-ink)",
		onFill: "text-white",
		ring: "ring-(--path-teal)",
		stroke: "stroke-(--path-teal)",
	},
	warning: {
		border: "border-warning",
		fill: "bg-warning",
		ink: "text-status-warning",
		onFill: "text-warning-foreground",
		ring: "ring-warning",
		stroke: "stroke-warning",
	},
} as const satisfies Record<PathTone, PathToneClasses>;

/**
 * The neutral stop face (waiting, not started, the `+`): muted foreground
 * mixed into the page background, so it reads as "not yet" in light and dark.
 */
export const PATH_NEUTRAL_FILL =
	"bg-[color-mix(in_oklab,var(--color-muted-foreground)_24%,var(--color-background))]";
