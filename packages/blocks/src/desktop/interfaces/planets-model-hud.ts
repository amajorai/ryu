export const FIT_SAMPLES = 72;

/** A rectangle in scene pixels (from the scene's top-left corner). */
export interface Box {
	bottom: number;
	left: number;
	right: number;
	top: number;
}

/** Where the HUD's floating pieces sit over the scene, measured live. */
export interface HudLayout {
	card: Box | null;
	controls: Box | null;
	legend: Box | null;
}

export const EMPTY_HUD: HudLayout = {
	card: null,
	controls: null,
	legend: null,
};

/** Insets (px) that leave a free region of the scene for the picture. */
export interface Insets {
	bottom: number;
	left: number;
	right: number;
	top: number;
}

/** Breathing room between the HUD and the picture. */
export const HUD_GAP = 12;
/**
 * Room name plates need around the outermost bodies: they hang below a body
 * and reach about half their width to each side.
 */
export const PLATE_PAD = { bottom: 22, side: 46, top: 8 } as const;

/** Side padding for plates: less on a narrow screen, where they slide in. */
export function sidePad(width: number): number {
	return Math.min(PLATE_PAD.side, Math.max(14, width * 0.035));
}

export const OVERVIEW_ELEVATION = 0.68;
