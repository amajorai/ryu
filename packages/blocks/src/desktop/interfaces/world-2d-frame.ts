import type { CSSProperties } from "react";
import { SV_FRAME, SV_TEXT_INK } from "./world-2d-palette.ts";

/**
 * Stardew-style UI frames as 9-slice `border-image`s: a tiny pixel map is
 * rendered to an inline SVG (no network) already scaled to whole screen
 * pixels, so corners stay chunky and crisp at any panel size.
 *
 * Keys: o outer outline, L wood highlight, W wood, D wood shade, k inner
 * dark line, q parchment shadow, p parchment, s slot fill, S slot shade,
 * R/r selection red and its dark edge.
 */

const FRAME_COLORS: Readonly<Record<string, string>> = SV_FRAME;

/** The dialogue / menu frame: dark outline, orange wood, parchment. */
const WOOD_FRAME = [
	"..oooooooo..",
	".oLLLLLLLLo.",
	"oLLWWWWWWWDo",
	"oLWkkkkkkWDo",
	"oLWkqqqqkWDo",
	"oLWkqpppkWDo",
	"oLWkqpppkWDo",
	"oLWkqpppkWDo",
	"oLWkkkkkkWDo",
	"oWDDDDDDDDDo",
	".oDDDDDDDDo.",
	"..oooooooo..",
] as const;

/** A hotbar / inventory slot: beige well with a dark top-left inset. */
const SLOT_FRAME = [
	".SSSSSSSSSS.",
	"SkkkkkkkkkkS",
	"SkSSSSSSSSsS",
	"SkSsssssssqS",
	"SkSsssssssqS",
	"SkSsssssssqS",
	"SkSsssssssqS",
	"SkSsssssssqS",
	"SkSsssssssqS",
	"SksqqqqqqqqS",
	"SqqqqqqqqqqS",
	".SSSSSSSSSS.",
] as const;

/** The selected slot: Stardew's thick red frame around the beige well. */
const SLOT_ACTIVE_FRAME = [
	".rrrrrrrrrr.",
	"rRRRRRRRRRRr",
	"rRrrrrrrrrRr",
	"rRrsssssssRr",
	"rRrsssssssRr",
	"rRrsssssssRr",
	"rRrsssssssRr",
	"rRrsssssssRr",
	"rRrsssssssRr",
	"rRrrrrrrrrRr",
	"rRRRRRRRRRRr",
	".rrrrrrrrrr.",
] as const;

/** A toggled-on tool slot: pressed in, darker, with a deep top-left lip. */
const SLOT_PRESSED_FRAME = [
	".oooooooooo.",
	"okkkkkkkkkko",
	"okSSSSSSSSqo",
	"okSqqqqqqqqo",
	"okSqqqqqqqqo",
	"okSqqqqqqqqo",
	"okSqqqqqqqqo",
	"okSqqqqqqqqo",
	"okSqqqqqqqqo",
	"okqqqqqqqqqo",
	"okqqqqqqqqqo",
	".oooooooooo.",
] as const;

/** A small wooden plank (tooltips, buttons, name plates). */
const PLANK_FRAME = [
	".oooooooooo.",
	"oLLLLLLLLLLo",
	"oLWWWWWWWWDo",
	"oLWWWWWWWWDo",
	"oLWWWWWWWWDo",
	"oLWWWWWWWWDo",
	"oLWWWWWWWWDo",
	"oLWWWWWWWWDo",
	"oLWWWWWWWWDo",
	"oDDDDDDDDDDo",
	"oDDDDDDDDDDo",
	".oooooooooo.",
] as const;

function svgFor(rows: readonly string[], scale: number): string {
	const colors = FRAME_COLORS;
	const size = (rows[0]?.length ?? 0) * scale;
	const rects: string[] = [];
	rows.forEach((row, y) => {
		let x = 0;
		while (x < row.length) {
			const key = row[x] ?? ".";
			let run = 1;
			while (row[x + run] === key) {
				run++;
			}
			const color = colors[key];
			if (color) {
				rects.push(
					`<rect x="${x * scale}" y="${y * scale}" width="${run * scale}" height="${scale}" fill="${color}"/>`
				);
			}
			x += run;
		}
	});
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" shape-rendering="crispEdges">${rects.join("")}</svg>`;
}

export type FrameKind =
	| "plank"
	| "slot"
	| "slot-active"
	| "slot-pressed"
	| "wood";

const cache = new Map<string, CSSProperties>();

/**
 * Inline style for a framed element. `scale` is screen pixels per frame
 * pixel (3 matches the world's zoom; 2 suits small controls).
 */
export function frameStyle(kind: FrameKind, scale = 3): CSSProperties {
	const key = `${kind}|${scale}`;
	const hit = cache.get(key);
	if (hit) {
		return hit;
	}
	const rows = {
		plank: PLANK_FRAME,
		slot: SLOT_FRAME,
		"slot-active": SLOT_ACTIVE_FRAME,
		"slot-pressed": SLOT_PRESSED_FRAME,
		wood: WOOD_FRAME,
	}[kind];
	const svg = svgFor(rows, scale);
	const slice = 5 * scale;
	const style: CSSProperties = {
		borderImage: `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${slice} fill / ${slice}px / 0 stretch`,
		borderStyle: "solid",
		borderWidth: slice,
		imageRendering: "pixelated",
	};
	cache.set(key, style);
	return style;
}

/** Stardew text: dark brown with a soft tan drop shadow. */
export const SV_TEXT: CSSProperties = {
	color: SV_TEXT_INK.ink,
	textShadow: `1px 1px 0 ${SV_TEXT_INK.inkShadow}`,
};

/** Light text on wood planks. */
export const SV_PLANK_TEXT: CSSProperties = {
	color: SV_TEXT_INK.plank,
	textShadow: `1px 1px 0 ${SV_TEXT_INK.plankEdge}, 2px 2px 0 ${SV_TEXT_INK.plankShadow}`,
};
