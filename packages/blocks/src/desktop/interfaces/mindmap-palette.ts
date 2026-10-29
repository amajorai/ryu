/**
 * Mind Map branch colours, derived from the user's theme rather than fixed:
 * each first-level branch takes the theme's primary colour turned around the
 * hue wheel, with lightness and chroma held in a band that reads on both light
 * and dark backgrounds. A monochrome theme still gets distinct branches (the
 * chroma floor), and a browser without relative colour syntax falls back to
 * the inherited foreground tone (see `MINDMAP_BRANCH_FALLBACK`).
 *
 * This is the renderer's only colour source; everything else uses semantic
 * tokens.
 */

/**
 * Hue turns from the primary colour, in degrees, in branch order. The first
 * turns sit far from the primary hue, so branches never read as the primary
 * "your turn" mark.
 */
const HUE_TURNS = [180, 290, 70, 125, 235, 20] as const;

function branchColor(turn: number): string {
	return `oklch(from var(--primary) clamp(0.6, l, 0.7) max(c, 0.13) calc(h + ${turn}))`;
}

export const MINDMAP_BRANCH_COLORS: readonly string[] =
	HUE_TURNS.map(branchColor);

/** Class for the SVG layer, so a branch without a colour reads as muted. */
export const MINDMAP_BRANCH_FALLBACK = "fill-muted-foreground/60";

/** Colour for a first-level branch slot (wraps around). */
export function mindmapBranchColor(branch: number): string {
	if (branch < 0) {
		return "var(--foreground)";
	}
	return (
		MINDMAP_BRANCH_COLORS[branch % MINDMAP_BRANCH_COLORS.length] ??
		"var(--foreground)"
	);
}
