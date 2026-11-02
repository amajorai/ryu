/**
 * Which way a face reads, and the inline axis that follows from it.
 *
 * The type layers are painted into DETACHED canvases (see `scene.ts`), whose
 * `direction: "inherit"` resolves to LTR whatever the page's `dir` is. So a face
 * printed in a right-to-left language has to say so itself: `ctx.direction`
 * sets the bidi base its strings are ordered in (an Intl "١٢ يومًا" day count,
 * "Ryu" beside Arabic), and the anchors below mirror the layout so the lockup,
 * the hero and the stat grid start from the right, the way the live card does
 * under `dir="rtl"`.
 *
 * Painters keep laying out in START-relative coordinates (`box.left` is the
 * start edge, a second stat column sits at `left + column + gap`) and convert at
 * the draw call through `PassInline`. In LTR every conversion is the identity
 * and the alignments are the physical ones they always were, so an English card
 * paints exactly what it painted before.
 */

import { activeDirection } from "@ryu/i18n/lite";
import {
	activePassTranslate,
	englishPassTranslate,
	type PassTranslate,
} from "./labels.ts";
import { CARD_WIDTH_PX } from "./paint.ts";

/** The direction-dependent half of a face's environment. */
export interface PassDirectionEnv {
	/** Paint the face right-to-left. Absent means left-to-right. */
	rtl?: boolean;
	scale: number;
}

export interface PassInline {
	/** Left edge of a `width`-wide box whose START edge is at `x` (device px). */
	box(x: number, width: number): number;
	/** Left edge of a `size`-wide box at START-relative CSS px `x` (e.g. a mark). */
	boxCss(x: number, size: number): number;
	/** The physical alignment of text that ends a line (a header's meta). */
	end: CanvasTextAlign;
	rtl: boolean;
	/** The physical alignment of text that starts a line. */
	start: CanvasTextAlign;
	/** A start-relative device-px anchor as a physical x. */
	x(x: number): number;
}

/**
 * Whether a face whose labels come from `tl` reads right-to-left. A face pinned
 * to English (the certificate's default) stays LTR in any UI language.
 */
export function passIsRtl(tl: PassTranslate = activePassTranslate): boolean {
	return tl !== englishPassTranslate && activeDirection() === "rtl";
}

/** The inline axis for a face drawn at `scale`. */
export function passInline({
	rtl = false,
	scale,
}: PassDirectionEnv): PassInline {
	const width = CARD_WIDTH_PX * scale;
	return {
		box: (x, size) => (rtl ? width - x - size : x),
		boxCss: (x, size) => (rtl ? CARD_WIDTH_PX - x - size : x),
		end: rtl ? "left" : "right",
		rtl,
		start: rtl ? "right" : "left",
		x: (x) => (rtl ? width - x : x),
	};
}

/**
 * Set the context's bidi base from the language `tl` paints in, and return the
 * env with `rtl` on it so a painter hands one value to every helper it calls.
 * Decided at paint time, like the labels themselves.
 */
export function withPassDirection<T extends PassDirectionEnv>(
	ctx: CanvasRenderingContext2D,
	env: T,
	tl: PassTranslate
): T & { rtl: boolean } {
	const rtl = passIsRtl(tl);
	ctx.direction = rtl ? "rtl" : "ltr";
	return { ...env, rtl };
}
