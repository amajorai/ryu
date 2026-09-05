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
import { FACE_RADIUS_PX } from "../pass-card-shell.tsx";
import {
	FIT_STEP_PX,
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
/** The mark alone on the back, at the size the live back face draws it. */
const BACK_LOGO_PX = 48;

/** `leading-[1.02]` on the name, `leading-none` on the stat value. */
const NAME_LINE_HEIGHT = 1.02;
/** `tracking-tight`. Canvas takes it in px, so it is resolved per size. */
const NAME_TRACKING_EM = -0.025;

/**
 * The Ryu ghost, as the same 24-unit path `logo.tsx` builds. Copied rather than
 * imported because the component composes it from `scaleFactor` arithmetic
 * inside a render, with no exported d-string to reach — but it is byte-identical
 * to the `scaleFactor === 1` case, and to the path the OG raster carries.
 */
const GHOST_PATH_24 =
	"M12,24c9.2,0,12.9-4.8,12.4-14.6C24.1,0.3,12.8-3.7,8.8,5.4c-2.2,5.7,1.1,7.9-2.9,12.6c-0.9,1.1-1.8,2-2.7,3.1c-1.2,1.3,0.7,2.2,1.9,2.2C7.4,23.3,9.7,24,12,24z";
/** `logo.tsx`: eyes at (15,10) and (19,10), 1.5x3.0 in the 24-unit space... */
const EYE_LEFT_X = 15;
const EYE_RIGHT_X = 19;
const EYE_Y = 10;
const EYE_RX = 1.5;
const EYE_RY = 3;
/** ...capped in ABSOLUTE px once the mark is drawn large, exactly as the component caps them. */
const EYE_MAX_RX = 3;
const EYE_MAX_RY = 5;
/** `vector-effect: non-scaling-stroke` keeps the outline a 1.5 DEVICE-px hairline. */
const GHOST_STROKE_DEVICE_PX = 1.5;

/**
 * The mark's eyes, animated — the same two behaviours `logo.tsx` runs, replayed
 * from loop time instead of from timers.
 *
 * The component blinks on a `setInterval` of 3-5s and, once the mouse has been
 * idle for three seconds, drifts its gaze to a fresh random point every 2-4s. A
 * video has no mouse, so it is always in the idle-gaze state — but it also has to
 * LOOP, and a random walk driven by wall-clock timers cannot: the last frame
 * would not match the first, and the eyes would jump on every repeat. So the
 * gaze is a fixed keyframe ring that closes on itself and the blinks sit at fixed
 * offsets well clear of the seam.
 */
const GAZE_KEYS = [
	{ x: 0, y: 0 },
	{ x: 0.85, y: -0.45 },
	{ x: -0.75, y: 0.35 },
	{ x: 0.25, y: 0.7 },
] as const;
/** `min(size * 0.08, 8)` px in the component, which is 1.92 of the 24 units. */
const GAZE_MAX_UNITS = 1.92;
/** Seconds into the loop each blink starts, and how long it lasts. */
const BLINK_TIMES = [2.4, 6.9] as const;
const BLINK_SECONDS = 0.15;
/** How much of a keyframe's slot is spent travelling rather than holding. */
const GAZE_TRAVEL = 0.45;

export interface GhostEyes {
	blinking: boolean;
	/** Gaze offset in the mark's own 24-unit space. */
	gazeX: number;
	gazeY: number;
}

const smoothstep = (t: number): number => t * t * (3 - 2 * t);

/** The eye state at `time` seconds into a `loop`-second cycle. */
export function ghostEyesAt(time: number, loop: number): GhostEyes {
	const slot = loop / GAZE_KEYS.length;
	const index = Math.floor(time / slot) % GAZE_KEYS.length;
	const within = (time % slot) / slot;
	// Travel, then hold — the component's gaze snaps to a point and rests there,
	// so easing across the whole slot would read as a constant slow drift.
	const eased = smoothstep(Math.min(1, within / GAZE_TRAVEL));
	const from = GAZE_KEYS[index] ?? GAZE_KEYS[0];
	const to = GAZE_KEYS[(index + 1) % GAZE_KEYS.length] ?? GAZE_KEYS[0];
	return {
		blinking: BLINK_TIMES.some((at) => time >= at && time < at + BLINK_SECONDS),
		gazeX: (from.x + (to.x - from.x) * eased) * GAZE_MAX_UNITS,
		gazeY: (from.y + (to.y - from.y) * eased) * GAZE_MAX_UNITS,
	};
}

let ghostPath: Path2D | null = null;
const ghost = (): Path2D => {
	ghostPath ??= new Path2D(GHOST_PATH_24);
	return ghostPath;
};

/**
 * Draw the mark at `size` CSS px with its top-left at (x, y).
 *
 * `scale` is the supersample factor the whole face is drawn at. It is taken
 * separately from `size` because the stroke must NOT scale with it: on screen
 * the outline is a non-scaling 1.5px hairline, so at 3x supersample it is 4.5
 * device px — the same hairline, not a mark three times as heavy.
 */
export function drawGhost(
	ctx: CanvasRenderingContext2D,
	{
		color,
		eyes,
		scale,
		size,
		x,
		y,
	}: {
		color: string;
		/** Omit for the resting mark, which is what the card's own faces wear. */
		eyes?: GhostEyes;
		scale: number;
		size: number;
		x: number;
		y: number;
	}
): void {
	const unit = (size / 24) * scale;
	ctx.save();
	ctx.translate(x * scale, y * scale);
	ctx.scale(unit, unit);
	ctx.strokeStyle = color;
	ctx.fillStyle = color;
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	ctx.lineWidth = (GHOST_STROKE_DEVICE_PX * scale) / unit;
	ctx.stroke(ghost());
	const rx = Math.min(EYE_RX * unit, EYE_MAX_RX * scale) / unit;
	const ry = Math.min(EYE_RY * unit, EYE_MAX_RY * scale) / unit;
	const gazeX = eyes?.gazeX ?? 0;
	const gazeY = eyes?.gazeY ?? 0;
	if (eyes?.blinking) {
		// A blink is a closed lid, which the component draws as a stroked line
		// across the eye rather than a squashed ellipse — the same shape here.
		const lid = Math.min(Math.max(2 * unit, 1), 4) * scale;
		ctx.lineWidth = lid / unit;
		for (const cx of [EYE_LEFT_X, EYE_RIGHT_X]) {
			ctx.beginPath();
			ctx.moveTo(cx + gazeX - rx, EYE_Y + gazeY);
			ctx.lineTo(cx + gazeX + rx, EYE_Y + gazeY);
			ctx.stroke();
		}
		ctx.restore();
		return;
	}
	for (const cx of [EYE_LEFT_X, EYE_RIGHT_X]) {
		ctx.beginPath();
		ctx.ellipse(cx + gazeX, EYE_Y + gazeY, rx, ry, 0, 0, Math.PI * 2);
		ctx.fill();
	}
	ctx.restore();
}

/** The colours the face is printed in, resolved from the live theme tokens. */
export interface PassPalette {
	border: string;
	card: string;
	cardForeground: string;
	mutedForeground: string;
	primary: string;
}

/**
 * Resolve the design tokens the card uses into something canvas accepts.
 *
 * Read off a probe element rather than `getPropertyValue("--card")`, because
 * the raw custom property in this repo is an `oklch(...)` string that older
 * canvas implementations reject outright — and because the probe picks up
 * whichever theme class is actually on the tree, so a card drawn while the app
 * is in dark mode comes out dark without being told.
 */
export function readPassPalette(host: HTMLElement): PassPalette {
	const probe = document.createElement("div");
	probe.style.cssText = "position:absolute;width:0;height:0;visibility:hidden";
	host.appendChild(probe);
	const read = (token: string): string => {
		probe.style.color = "";
		probe.style.color = `var(${token})`;
		const value = getComputedStyle(probe).color;
		// An unresolvable token leaves `color` at its inherited value rather than
		// erroring, so a token that has been renamed shows up as the wrong colour
		// instead of a crash. Both are wrong; a visible black is the easier one to
		// spot in review.
		return value || "#000000";
	};
	const palette: PassPalette = {
		border: read("--border"),
		card: read("--card"),
		cardForeground: read("--card-foreground"),
		mutedForeground: read("--muted-foreground"),
		primary: read("--primary"),
	};
	probe.remove();
	return palette;
}

/** The face's own font stack — whatever the app actually loaded, not a guess. */
export function readPassFontFamily(host: HTMLElement): string {
	return getComputedStyle(host).fontFamily || "system-ui, sans-serif";
}

/** A canvas `font` string at the face's supersample. */
export const font = (
	family: string,
	weight: number,
	px: number,
	scale: number
): string => `${weight} ${px * scale}px ${family}`;

/**
 * `AutoFitText`, with `measureText` where the DOM had `scrollWidth`.
 *
 * Deliberately the same shape as the component: start at the ceiling, step down
 * by `FIT_STEP_PX` while the single line overruns, stop at the floor, and report
 * whether it still overruns there — which is the card's signal to wrap rather
 * than to shrink into the body copy.
 */
export function fitFontSize(
	ctx: CanvasRenderingContext2D,
	{
		available,
		family,
		maxPx,
		minPx,
		scale,
		stepPx = FIT_STEP_PX,
		text,
		trackingEm = 0,
		weight,
	}: {
		available: number;
		family: string;
		maxPx: number;
		minPx: number;
		scale: number;
		/** The ramp's step. Defaults to the waitlist card's; a face with its own
		 * `AutoFitText` step must pass that one or the two searches stop at
		 * different sizes for the same string. */
		stepPx?: number;
		text: string;
		trackingEm?: number;
		weight: number;
	}
): { size: number; wrapped: boolean } {
	let size = maxPx;
	const widthAt = (px: number): number => {
		ctx.font = font(family, weight, px, scale);
		setTracking(ctx, px * trackingEm * scale);
		return ctx.measureText(text).width;
	};
	while (size > minPx && widthAt(size) > available) {
		size = Math.max(minPx, size - stepPx);
	}
	return { size, wrapped: widthAt(size) > available };
}

/**
 * `ctx.letterSpacing` is recent (Chrome 99, Safari 17.4). Where it is missing
 * the card loses `tracking-tight` on the name, which is a fraction of a pixel
 * per glyph — not worth a manual per-glyph draw to recover.
 */
export function setTracking(ctx: CanvasRenderingContext2D, px: number): void {
	if ("letterSpacing" in ctx) {
		(
			ctx as CanvasRenderingContext2D & { letterSpacing: string }
		).letterSpacing = `${px}px`;
	}
}

/** Greedy wrap, used only once the name has already bottomed out on its ramp. */
export function wrapLines(
	ctx: CanvasRenderingContext2D,
	text: string,
	available: number
): string[] {
	const words = text.split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let line = "";
	for (const word of words) {
		const next = line ? `${line} ${word}` : word;
		if (line && ctx.measureText(next).width > available) {
			lines.push(line);
			line = word;
		} else {
			line = next;
		}
	}
	if (line) {
		lines.push(line);
	}
	return lines.length > 0 ? lines : [text];
}

/** A rounded rectangle path in the current transform. */
export function roundedRect(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	width: number,
	height: number,
	radius: number
): void {
	ctx.beginPath();
	ctx.roundRect(x, y, width, height, radius);
}

/**
 * The body's box on the face, in DEVICE px — the ring gutter, then `p-7`.
 *
 * Every face on this shell is laid out against the same four edges, so they are
 * computed once here rather than re-derived per painter. `available` is the
 * width a line of type has before it has to shrink or wrap.
 */
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
	palette: PassPalette;
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
	username?: string | null;
}

/** The waitlist pass, as a painter. Today's face, unchanged, behind the seam. */
export function waitlistFacePainter(content: PassFaceContent): PassFacePainter {
	return {
		front: (ctx, env) => paintFrontType(ctx, { content, ...env }),
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
	const inset = METAL_EDGE_RING_PX + CARD_PADDING_PX;
	ctx.textBaseline = "alphabetic";
	drawGhost(ctx, {
		color: palette.cardForeground,
		scale,
		size: HEADER_LOGO_PX,
		x: inset,
		y: inset,
	});
	setTracking(ctx, 0);
	ctx.font = font(family, 500, HEADER_LABEL_PX, scale);
	ctx.fillStyle = palette.cardForeground;
	ctx.textAlign = "left";
	// Centred against the mark's box rather than sat on its baseline: the live
	// header is a flex row with `items-center`, and the mark is the tall item.
	const headerMiddle = box.top + (HEADER_LOGO_PX * scale) / 2;
	ctx.fillText(
		"Ryu",
		box.left + (HEADER_LOGO_PX + HEADER_LOGO_GAP_PX) * scale,
		headerMiddle + HEADER_LABEL_PX * scale * 0.36
	);
	if (right) {
		ctx.font = font(family, 400, HEADER_DATE_PX, scale);
		ctx.fillStyle = palette.mutedForeground;
		ctx.textAlign = "right";
		ctx.fillText(
			right,
			box.right,
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
		x: number;
	}
): number {
	const { family, palette, scale } = env;
	ctx.textAlign = "left";
	ctx.textBaseline = "alphabetic";
	setTracking(ctx, 0);
	// Not named `fit`: Biome reads a bare `fit(` as a focused test and fails the
	// lint on it.
	const cut = (text: string): string =>
		maxWidth === undefined ? text : ellipsize(ctx, text, maxWidth);
	const valueBaseline = baseline - labelPx * scale * 1.1;
	ctx.font = font(family, 500, valuePx, scale);
	ctx.fillStyle = palette.cardForeground;
	ctx.fillText(cut(value), x, valueBaseline);
	ctx.font = font(family, 400, labelPx, scale);
	ctx.fillStyle = palette.mutedForeground;
	ctx.fillText(cut(label), x, baseline);
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
		palette,
		scale,
	}: PassFaceEnv & { content: PassFaceContent }
): void {
	const { available, bottom, left } = passFaceBox(scale);
	const env: PassFaceEnv = { avatar, family, palette, scale };

	ctx.textBaseline = "alphabetic";

	// Header: mark + wordmark left, join date right.
	paintPassHeader(ctx, env, content.joined);

	// Footer first, because the hero above it is bottom-aligned against whatever
	// the footer leaves — the same `flex-1` + `justify-end` the live card uses.
	let heroFloor = bottom;
	if (typeof content.position === "number") {
		const statTop = paintPassStat(ctx, env, {
			baseline: bottom,
			label: "Position",
			value: `#${content.position}`,
			x: left,
		});
		heroFloor = statTop - BLOCK_GAP_PX * scale;
	}

	// Hero, built upward from its floor: handle, then name, then the avatar.
	ctx.textAlign = "left";
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
		ctx.fillText(handle, left, cursor);
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
		ctx.fillText(lines[i] ?? "", left, cursor);
		cursor -= lineHeight;
	}
	cursor += lineHeight;
	setTracking(ctx, 0);

	if (avatar) {
		const size = AVATAR_PX * scale;
		const y = cursor - nameSize * scale - AVATAR_GAP_PX * scale - size;
		ctx.save();
		ctx.beginPath();
		ctx.arc(left + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
		ctx.clip();
		ctx.drawImage(avatar, left, y, size, size);
		ctx.restore();
		ctx.beginPath();
		ctx.arc(left + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
		ctx.strokeStyle = palette.border;
		ctx.lineWidth = scale;
		ctx.stroke();
	}
}

/** The back: the mark, centred, and nothing else — same as the live back face. */
export function paintBackType(
	ctx: CanvasRenderingContext2D,
	{ palette, scale }: { palette: PassPalette; scale: number }
): void {
	drawGhost(ctx, {
		color: palette.cardForeground,
		scale,
		size: BACK_LOGO_PX,
		x: (CARD_WIDTH_PX - BACK_LOGO_PX) / 2,
		y: (CARD_HEIGHT_PX - BACK_LOGO_PX) / 2,
	});
}

/** The face's rounded silhouette, inset by the ring gutter, in device px. */
export function faceRect(scale: number): {
	height: number;
	radius: number;
	width: number;
	x: number;
	y: number;
} {
	return {
		height: (CARD_HEIGHT_PX - METAL_EDGE_RING_PX * 2) * scale,
		radius: FACE_RADIUS_PX * scale,
		width: (CARD_WIDTH_PX - METAL_EDGE_RING_PX * 2) * scale,
		x: METAL_EDGE_RING_PX * scale,
		y: METAL_EDGE_RING_PX * scale,
	};
}

/**
 * Load an avatar without tainting the canvas.
 *
 * Fetched to a blob rather than pointed at with `img.src`: a cross-origin image
 * drawn straight in marks the canvas as origin-unclean, and `toBlob` on an
 * unclean canvas throws — so the picture would fail at the copy step rather
 * than at the draw, long after it could be diagnosed. A URL that will not fetch
 * simply returns null and the card renders as it does for a member with no
 * picture, which is a face the card already knows how to draw.
 */
export async function loadAvatar(
	url: string | null | undefined
): Promise<HTMLImageElement | null> {
	if (!url) {
		return null;
	}
	try {
		const response = await fetch(url, { mode: "cors" });
		if (!response.ok) {
			return null;
		}
		const blob = await response.blob();
		const objectUrl = URL.createObjectURL(blob);
		const image = new Image();
		image.src = objectUrl;
		await image.decode();
		URL.revokeObjectURL(objectUrl);
		return image;
	} catch {
		return null;
	}
}
