import { isNativeNumber } from "../../lib/native-primitive-observation.ts";
/**
 * The two faces of the pass, painted into 2D canvases.
 *
 * This is the one part of the card that cannot be reused wholesale: the live
 * pass is DOM, and a `<canvas>` is what a recorder and a clipboard can both
 * read. Everything ELSE about the card — the warp shader behind the type, the
 * metal ring around it — is the real thing, sampled from the real WebGL
 * canvases in `scene.ts`. Only the text layer is redrawn here.
 *
 * The rule that keeps that redraw honest: no independent constants. Every size
 * comes from `pass-card-shell.tsx` / `waitlist-pass.tsx`, and the name is fitted
 * by MEASURING it exactly as `AutoFitText` does — the same ramp, the same step,
 * the same loop, with `measureText` standing in for `scrollWidth`. The previous
 * raster (`apps/web/src/lib/pass-card.tsx`) estimated width from character count
 * against its own `SCALE`, and that is precisely why it stopped looking like the
 * card it was a picture of.
 *
 * There is more than one card printed on this shell now, so the face is a SEAM
 * (`PassFacePainter`) rather than a function: `waitlistFacePainter` below is the
 * waitlist pass, `paint-tier.ts` is the paid-tier card. Everything a sibling
 * painter needs to obey the no-independent-constants rule — the measuring
 * helpers, the box, the shared header — is exported from here rather than
 * copied, so a second face cannot drift from the first by retyping a number.
 */

import { METAL_EDGE_RING_PX } from "../metal-edge.tsx";
import {
	HANDLE_MAX_PX,
	HANDLE_MIN_PX,
	NAME_MAX_PX,
	NAME_MIN_PX,
} from "../waitlist-pass.tsx";

/**
 * The card's own box, in CSS px. The live card is laid out by Tailwind rather
 * than by numbers — `max-w-sm` inside a `minmax(0,20rem)` column, and a
 * `min-h-[27rem]` body — so these are that layout resolved, and the only two
 * figures here with no constant to import.
 */
import { activePassTranslate, type PassTranslate } from "./labels.ts";
import { paintBackQr } from "./paint-back.ts";
import { passInline, withPassDirection } from "./paint-direction.ts";
import { drawGhost } from "./paint-ghost.ts";
import {
	fitFontSize,
	font,
	type PassPalette,
	setTracking,
	wrapLines,
} from "./paint-text.ts";

export {
	faceRect,
	loadAvatar,
	paintBackQr,
	paintBackType,
} from "./paint-back.ts";
export { drawGhost, type GhostEyes, ghostEyesAt } from "./paint-ghost.ts";
export {
	fitFontSize,
	font,
	type PassPalette,
	readPassFontFamily,
	readPassPalette,
	roundedRect,
	setTracking,
	wrapLines,
} from "./paint-text.ts";

export const CARD_WIDTH_PX = 320;
export const CARD_HEIGHT_PX = 432;
/** `p-7` on the body. */
const CARD_PADDING_PX = 28;
/** `gap-6` between header, hero and footer. */
export const BLOCK_GAP_PX = 24;
/** `gap-1.5` inside the hero block. */
export const HERO_GAP_PX = 6;
/** The header lockup: a 20px mark, `gap-2`, then `text-sm` at `font-medium`. */
const HEADER_LOGO_PX = 20;
const HEADER_LOGO_GAP_PX = 8;
const HEADER_LABEL_PX = 14;
/** `text-[11px]` on the join date. */
const HEADER_DATE_PX = 11;
/** `text-xl` value over a `text-xs` label. */
export const STAT_VALUE_PX = 20;
export const STAT_LABEL_PX = 12;
/** The avatar disc: `size-14` with a `mb-3`. */
const AVATAR_PX = 56;
const AVATAR_GAP_PX = 12;

/** `leading-[1.02]` on the name, `leading-none` on the stat value. */
const NAME_LINE_HEIGHT = 1.02;
/** `tracking-tight`. Canvas takes it in px, so it is resolved per size. */
const NAME_TRACKING_EM = -0.025;

export interface PassFaceBox {
	available: number;
	bottom: number;
	left: number;
	right: number;
	top: number;
}

export function passFaceBox(scale: number): PassFaceBox {
	const inset = METAL_EDGE_RING_PX + CARD_PADDING_PX;
	return {
		available: (CARD_WIDTH_PX - inset * 2) * scale,
		bottom: (CARD_HEIGHT_PX - inset) * scale,
		left: inset * scale,
		right: (CARD_WIDTH_PX - inset) * scale,
		top: inset * scale,
	};
}

/**
 * Everything a face painter is handed that is not its own content: the theme it
 * is printed in, the font the app actually loaded, the supersample it is drawn
 * at, and the member's picture if one was fetched.
 *
 * The avatar arrives here rather than on the content object because the fetch
 * that produces it is `loadAvatar`'s taint-safe blob path, which the studio owns
 * — a painter must not be able to hand the scene a raw cross-origin image and
 * poison the canvas the export reads from.
 */
export interface PassFaceEnv {
	avatar?: CanvasImageSource | null;
	family: string;
	isDark: boolean;
	palette: PassPalette;
	/**
	 * Paint the face right-to-left (see `paint-direction.ts`). Set by the face
	 * painter from its translator, not by the scene: a face pinned to English
	 * stays LTR whatever the UI's language.
	 */
	rtl?: boolean;
	scale: number;
}

/**
 * One card's type layer. The seam that lets the same scene, recorder and format
 * ladder serve more than one kind of pass — see the file header.
 */
export interface PassFacePainter {
	/** Defaults to the centred mark, which is already tier-agnostic. */
	back?(ctx: CanvasRenderingContext2D, env: PassFaceEnv): void;
	front(ctx: CanvasRenderingContext2D, env: PassFaceEnv): void;
}

export interface PassFaceContent {
	/** Already formatted by `formatPassDate`; the card prints it verbatim. */
	joined?: string | null;
	name: string;
	/** Already gated by `QUEUE_STATS_MIN` upstream — drawn if present, hidden if not. */
	position?: number | null;
	/** Absolute invite destination for the QR on a waitlist pass export. */
	referralUrl?: string | null;
	username?: string | null;
}

/** The waitlist pass, as a painter. Today's face, unchanged, behind the seam. */
export function waitlistFacePainter(
	content: PassFaceContent,
	tl: PassTranslate = activePassTranslate
): PassFacePainter {
	return {
		back: (ctx, env) =>
			paintBackQr(ctx, {
				caption: tl("Scan to invite"),
				env: withPassDirection(ctx, env, tl),
				seed: content.username || content.name || "ryu",
				tl,
				value: content.referralUrl,
			}),
		front: (ctx, env) =>
			paintFrontType(ctx, {
				content,
				tl,
				...withPassDirection(ctx, env, tl),
			}),
	};
}

/**
 * The header lockup every face shares: the mark and the wordmark on the left,
 * one line of meta on the right.
 *
 * Shared rather than reimplemented per painter because it is the part of the
 * card that says which card it is — a tier pass whose lockup sat a pixel off
 * the waitlist pass's would read as a different product.
 */
export function paintPassHeader(
	ctx: CanvasRenderingContext2D,
	env: PassFaceEnv,
	right?: string | null
): void {
	const { family, palette, scale } = env;
	const box = passFaceBox(scale);
	const inline = passInline(env);
	const inset = METAL_EDGE_RING_PX + CARD_PADDING_PX;
	ctx.textBaseline = "alphabetic";
	drawGhost(ctx, {
		color: palette.cardForeground,
		scale,
		size: HEADER_LOGO_PX,
		x: inline.boxCss(inset, HEADER_LOGO_PX),
		y: inset,
	});
	setTracking(ctx, 0);
	ctx.font = font(family, 500, HEADER_LABEL_PX, scale);
	ctx.fillStyle = palette.cardForeground;
	ctx.textAlign = inline.start;
	// Centred against the mark's box rather than sat on its baseline: the live
	// header is a flex row with `items-center`, and the mark is the tall item.
	const headerMiddle = box.top + (HEADER_LOGO_PX * scale) / 2;
	ctx.fillText(
		"Ryu",
		inline.x(box.left + (HEADER_LOGO_PX + HEADER_LOGO_GAP_PX) * scale),
		headerMiddle + HEADER_LABEL_PX * scale * 0.36
	);
	if (right) {
		ctx.font = font(family, 400, HEADER_DATE_PX, scale);
		ctx.fillStyle = palette.mutedForeground;
		ctx.textAlign = inline.end;
		ctx.fillText(
			right,
			inline.x(box.right),
			headerMiddle + HEADER_DATE_PX * scale * 0.36
		);
	}
}

/**
 * Trim a line to `maxWidth` with an ellipsis, the way Tailwind's `truncate`
 * does. NOT `fillText`'s own `maxWidth`, which condenses the glyphs instead of
 * cutting the string — a squeezed name is a different typeface, and the whole
 * point of measuring is that the card's type is the card's type.
 */
export function ellipsize(
	ctx: CanvasRenderingContext2D,
	text: string,
	maxWidth: number
): string {
	if (ctx.measureText(text).width <= maxWidth) {
		return text;
	}
	let trimmed = text;
	while (trimmed && ctx.measureText(`${trimmed}…`).width > maxWidth) {
		trimmed = trimmed.slice(0, -1);
	}
	return `${trimmed}…`;
}

/**
 * One footer stat — a value over its label, the pair the live cards build with
 * `flex flex-col`. Returns the y the block's TOP sits at, so a caller stacking
 * upward knows where its floor is.
 *
 * The two sizes are arguments rather than fixed because each card declares its
 * own (the waitlist pass's `text-xl`/`text-xs`, the tier card's
 * `TIER_STAT_VALUE_PX`/`TIER_META_PX`) — they happen to agree today, and taking
 * them from the caller is what stops that agreement from becoming an assumption.
 */
export function paintPassStat(
	ctx: CanvasRenderingContext2D,
	env: PassFaceEnv,
	{
		baseline,
		label,
		labelPx = STAT_LABEL_PX,
		maxWidth,
		value,
		valuePx = STAT_VALUE_PX,
		x,
	}: {
		baseline: number;
		label: string;
		labelPx?: number;
		/** Device px. Both lines are cut to it, as the live stat's `truncate` does. */
		maxWidth?: number;
		value: string;
		valuePx?: number;
		/** The stat's START edge in device px; mirrored when the face is RTL. */
		x: number;
	}
): number {
	const { family, palette, scale } = env;
	const inline = passInline(env);
	ctx.textAlign = inline.start;
	ctx.textBaseline = "alphabetic";
	setTracking(ctx, 0);
	// Not named `fit`: Biome reads a bare `fit(` as a focused test and fails the
	// lint on it.
	const cut = (text: string): string =>
		maxWidth === undefined ? text : ellipsize(ctx, text, maxWidth);
	const valueBaseline = baseline - labelPx * scale * 1.1;
	ctx.font = font(family, 500, valuePx, scale);
	ctx.fillStyle = palette.cardForeground;
	ctx.fillText(cut(value), inline.x(x), valueBaseline);
	ctx.font = font(family, 400, labelPx, scale);
	ctx.fillStyle = palette.mutedForeground;
	ctx.fillText(cut(label), inline.x(x), baseline);
	return valueBaseline - valuePx * scale;
}

/**
 * The type layer of the front face: everything the live card renders as DOM,
 * and nothing it renders as a shader. The backdrop, the ring and the foil are
 * composited under and over this in `scene.ts`, which is what keeps them the
 * real ones.
 *
 * Drawn on a TRANSPARENT canvas so the caller owns the stacking order.
 */
export function paintFrontType(
	ctx: CanvasRenderingContext2D,
	{
		avatar,
		content,
		family,
		isDark,
		palette,
		rtl,
		scale,
		tl = activePassTranslate,
	}: PassFaceEnv & { content: PassFaceContent; tl?: PassTranslate }
): void {
	const { available, bottom, left } = passFaceBox(scale);
	const env: PassFaceEnv = { avatar, family, isDark, palette, rtl, scale };
	const inline = passInline(env);

	ctx.textBaseline = "alphabetic";

	// Header: mark + wordmark left, join date right.
	paintPassHeader(ctx, env, content.joined);

	// Footer first, because the hero above it is bottom-aligned against whatever
	// the footer leaves — the same `flex-1` + `justify-end` the live card uses.
	let heroFloor = bottom;
	if (isNativeNumber(content.position)) {
		const statTop = paintPassStat(ctx, env, {
			baseline: bottom,
			label: tl("Position"),
			value: `#${content.position}`,
			x: left,
		});
		heroFloor = statTop - BLOCK_GAP_PX * scale;
	}

	// Hero, built upward from its floor: handle, then name, then the avatar.
	ctx.textAlign = inline.start;
	let cursor = heroFloor;
	if (content.username) {
		const handle = `@${content.username}`;
		const { size } = fitFontSize(ctx, {
			available,
			family,
			maxPx: HANDLE_MAX_PX,
			minPx: HANDLE_MIN_PX,
			scale,
			text: handle,
			weight: 400,
		});
		ctx.font = font(family, 400, size, scale);
		setTracking(ctx, 0);
		ctx.fillStyle = palette.mutedForeground;
		ctx.fillText(handle, inline.x(left), cursor);
		cursor -= size * scale + HERO_GAP_PX * scale;
	}

	const { size: nameSize, wrapped } = fitFontSize(ctx, {
		available,
		family,
		maxPx: NAME_MAX_PX,
		minPx: NAME_MIN_PX,
		scale,
		text: content.name,
		trackingEm: NAME_TRACKING_EM,
		weight: 600,
	});
	ctx.font = font(family, 500, nameSize, scale);
	setTracking(ctx, nameSize * NAME_TRACKING_EM * scale);
	ctx.fillStyle = palette.cardForeground;
	const lines = wrapped
		? wrapLines(ctx, content.name, available)
		: [content.name];
	const lineHeight = nameSize * NAME_LINE_HEIGHT * scale;
	for (let i = lines.length - 1; i >= 0; i--) {
		ctx.fillText(lines[i] ?? "", inline.x(left), cursor);
		cursor -= lineHeight;
	}
	cursor += lineHeight;
	setTracking(ctx, 0);

	if (avatar) {
		const size = AVATAR_PX * scale;
		const y = cursor - nameSize * scale - AVATAR_GAP_PX * scale - size;
		const x = inline.box(left, size);
		ctx.save();
		ctx.beginPath();
		ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
		ctx.clip();
		ctx.drawImage(avatar, x, y, size, size);
		ctx.restore();
		ctx.beginPath();
		ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
		ctx.strokeStyle = palette.border;
		ctx.lineWidth = scale;
		ctx.stroke();
	}
}

/** Paint the same dot QR used by the live waitlist/referral pass backs. */
