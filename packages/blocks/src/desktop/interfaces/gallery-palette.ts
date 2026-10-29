import type { GalleryCoverSpec } from "./gallery-model.ts";

/**
 * Gallery's cover palette. Each cover is coloured by its lead agent, in the
 * hue that agent's dither avatar is drawn in, mixed with the theme's own card and
 * foreground so covers sit on light and dark themes alike. Status covers use
 * the theme's success and destructive tokens.
 *
 * This is the one Gallery file allowed to spell color functions.
 */

function hue(cover: GalleryCoverSpec): string {
	return cover.hue.toString();
}

/**
 * The agent's colour, in the HSL its dither avatar is drawn with, at a given
 * saturation and lightness (greys when there is no agent).
 */
function agent(cover: GalleryCoverSpec, saturation: number, lightness: number) {
	const tone = cover.neutral ? 0 : saturation;
	return `hsl(${hue(cover)} ${tone.toString()}% ${lightness.toString()}%)`;
}

export interface GalleryCoverColors {
	/** Accent marks: the quote glyph, rules, the stat numeral. */
	accent: string;
	ground: string;
	/** Secondary text on the ground. */
	muted: string;
	text: string;
}

/** Paper tinted with the agent's colour, for quotes and stats. */
function tinted(cover: GalleryCoverSpec): GalleryCoverColors {
	return {
		accent: `color-mix(in oklab, ${agent(cover, 80, 46)} 82%, var(--foreground))`,
		ground: `color-mix(in oklab, ${agent(cover, 85, 62)} 13%, var(--card))`,
		muted: "color-mix(in oklab, var(--foreground) 62%, transparent)",
		text: "var(--foreground)",
	};
}

/** A deep field of the agent's colour with light type, for posters. */
function poster(cover: GalleryCoverSpec): GalleryCoverColors {
	return {
		accent: agent(cover, 90, 84),
		ground: `linear-gradient(160deg, ${agent(cover, 58, 42)} 0%, ${agent(cover, 62, 26)} 100%)`,
		muted: "oklch(0.98 0 0 / 0.72)",
		text: "oklch(0.99 0 0)",
	};
}

/** A console for runs: green while working, red once it failed. */
function status(cover: GalleryCoverSpec): GalleryCoverColors {
	const signal =
		cover.status === "attention" ? "var(--destructive)" : "var(--success)";
	return {
		accent: signal,
		ground: `color-mix(in oklab, ${signal} 10%, var(--card))`,
		muted: "color-mix(in oklab, var(--foreground) 62%, transparent)",
		text: "var(--foreground)",
	};
}

export function galleryCoverColors(
	cover: GalleryCoverSpec
): GalleryCoverColors {
	if (cover.kind === "poster") {
		return poster(cover);
	}
	if (cover.kind === "status") {
		return status(cover);
	}
	return tinted(cover);
}
