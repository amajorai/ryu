import type { Point3 } from "../../kit/iso-kit.ts";
import { createSketch, type Sketch } from "../static/sketch.tsx";
import type { StaticDrawing } from "../static/static-figure.tsx";

/*
 * Bento card drawings: one small object per card, in the same quiet look as
 * the product figures, sized for a third of a section's width.
 */

export const CARD_WIDTH = 360;
export const CARD_HEIGHT = 200;

/** A group's drawings, keyed by the exact title of the bento item they draw. */
export type BentoDrawings = Readonly<Record<string, StaticDrawing>>;

/** A sketch fitted to the card canvas around the drawing's world bounds. */
export function createCardSketch(bounds: Point3[]): Sketch {
	return createSketch(bounds, CARD_WIDTH, CARD_HEIGHT, { pad: 14 });
}

/** Freeze a finished card sketch into a drawing. */
export function cardDrawing(s: Sketch): StaticDrawing {
	return { width: CARD_WIDTH, height: CARD_HEIGHT, nodes: s.nodes() };
}
