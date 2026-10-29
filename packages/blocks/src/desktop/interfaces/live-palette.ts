import type { LiveArtSpec } from "./live-model.ts";

/**
 * Live's art palette. A stream frame is video, not chrome, so it keeps its own
 * dark broadcast look in every theme: a stage lit in the channel's colour
 * (the hue its dither avatar is drawn in) with light type. Category box art
 * uses the same system, coloured per category.
 *
 * This is the one Live file allowed to spell color functions.
 */

function hsl(
	hue: number,
	saturation: number,
	lightness: number,
	alpha = 1
): string {
	const base = `${hue.toString()} ${saturation.toString()}% ${lightness.toString()}%`;
	return alpha === 1 ? `hsl(${base})` : `hsl(${base} / ${alpha.toString()})`;
}

export interface LiveStageColors {
	/** The channel colour as type: segment labels and the name plate. */
	accent: string;
	/** The facecam's frame and the name plate's ground. */
	frame: string;
	/** Ink on the frame colour. */
	frameText: string;
	ground: string;
	muted: string;
	text: string;
}

/** Colours for a stream's stage, from the channel's hue. */
export function liveStage(spec: Pick<LiveArtSpec, "hue" | "neutral">) {
	const saturation = spec.neutral ? 0 : 1;
	const hue = spec.hue;
	return {
		accent: hsl(hue, 90 * saturation, 74),
		frame: hsl(hue, 80 * saturation, 60),
		frameText: "hsl(0 0% 6%)",
		ground: [
			`radial-gradient(70% 90% at 88% 8%, ${hsl(hue, 85 * saturation, 52, 0.42)} 0%, transparent 65%)`,
			"radial-gradient(circle at 1px 1px, hsl(0 0% 100% / 0.07) 1px, transparent 1.4px) 0 0 / 2.4cqw 2.4cqw",
			`linear-gradient(140deg, ${hsl(hue, 40 * saturation, 17)} 0%, ${hsl(hue, 30 * saturation, 8)} 100%)`,
		].join(", "),
		muted: "hsl(0 0% 100% / 0.62)",
		text: "hsl(0 0% 98%)",
	} satisfies LiveStageColors;
}

/** A category's colour: a hue of its own, from its id. */
export function liveCategoryStage(hue: number): LiveStageColors {
	return liveStage({ hue, neutral: false });
}
