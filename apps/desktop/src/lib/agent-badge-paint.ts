// apps/desktop/src/lib/agent-badge-paint.ts
//
// Canvas primitives for the agent Lanyard badge (`agent-badge.ts`): the landing
// dither, the Ryu mark, the QR code, and text fitting. Text helpers keep
// non-Latin scripts intact: per-glyph tracking would break Arabic joining and
// Indic shaping, so those strings are drawn whole.

import { createQRCodeGeometry } from "@ryu/ui/lib/qr-code.ts";

const QR_QUIET_ZONE = 12;
const CARD_TOP = "#ffffff";
const RE_WHITESPACE = /\s+/;
/** Text tracking may letter-space: Latin, Greek and Cyrillic, which never join. */
const RE_TRACKABLE =
	/^[\u0020-\u024F\u0370-\u03FF\u0400-\u04FF\u2000-\u206F]*$/u;

const LANDING_DITHER = {
	color: "#B497CF",
	edgeFade: 0.5,
	enableRipples: true,
	patternDensity: 1,
	patternScale: 2,
	pixelSize: 3,
	rippleIntensityScale: 1,
	rippleSpeed: 0.3,
	rippleThickness: 0.1,
	speed: 0.5,
	transparent: true,
	variant: "square",
} as const;

// The Ryu mark, straight from /assets/logos/ryu_*.svg (viewBox 0 0 24 24).
const RYU_PATH =
	"M12,24c9.2,0,12.9-4.8,12.4-14.6C24.1,0.3,12.8-3.7,8.8,5.4c-2.2,5.7,1.1,7.9-2.9,12.6c-0.9,1.1-1.8,2-2.7,3.1c-1.2,1.3,0.7,2.2,1.9,2.2C7.4,23.3,9.7,24,12,24z";

/** Shrink a font until the text fits `maxWidth`, returning the chosen px size. */
export function fitFontSize(
	ctx: CanvasRenderingContext2D,
	text: string,
	font: (px: number) => string,
	startPx: number,
	minPx: number,
	maxWidth: number
): number {
	let size = startPx;
	while (size > minPx) {
		ctx.font = font(size);
		if (ctx.measureText(text).width <= maxWidth) {
			break;
		}
		size -= 2;
	}
	return size;
}

/** Word-wrap `text` to at most `maxLines`, ellipsizing the final line if needed. */
export function wrapLines(
	ctx: CanvasRenderingContext2D,
	text: string,
	maxWidth: number,
	maxLines: number
): string[] {
	// Scripts written without spaces (Chinese, Japanese, Thai) wrap per glyph.
	const spaced = RE_WHITESPACE.test(text.trim());
	const gap = spaced ? " " : "";
	const words = spaced
		? text.trim().split(RE_WHITESPACE).filter(Boolean)
		: Array.from(text.trim());
	const lines: string[] = [];
	let current = "";
	let consumed = 0;
	for (const word of words) {
		const candidate = current ? `${current}${gap}${word}` : word;
		if (ctx.measureText(candidate).width <= maxWidth || !current) {
			current = candidate;
			consumed += 1;
			continue;
		}
		lines.push(current);
		current = "";
		if (lines.length === maxLines) {
			break;
		}
		current = word;
		consumed += 1;
	}
	if (lines.length < maxLines && current) {
		lines.push(current);
	}
	// If we ran out of lines with text remaining, ellipsize the last line.
	const lastIndex = lines.length - 1;
	if (consumed < words.length && lastIndex >= 0) {
		let last = lines[lastIndex] ?? "";
		while (ctx.measureText(`${last}…`).width > maxWidth && last.length > 1) {
			last = last.slice(0, -1).trimEnd();
		}
		lines[lastIndex] = `${last}…`;
	}
	return lines;
}

export function drawLandingDither(
	ctx: CanvasRenderingContext2D,
	width: number,
	height: number
): void {
	const pixel = LANDING_DITHER.pixelSize;
	const noiseCell = 8 * pixel;
	const centerX = width / 2;
	const centerY = height / 2;
	const maxDistance = Math.hypot(centerX, centerY);

	ctx.save();
	ctx.fillStyle = LANDING_DITHER.color;
	for (let y = 0; y < height; y += pixel) {
		for (let x = 0; x < width; x += pixel) {
			const noiseX = Math.floor((x - centerX) / noiseCell);
			const noiseY = Math.floor((y - centerY) / noiseCell);
			const grain = hashFloat(
				noiseX * 127.1 + noiseY * 311.7 + LANDING_DITHER.patternScale * 57.3
			);
			const threshold = bayer8(x / pixel, y / pixel);
			const feed =
				grain * 0.74 - 0.22 + (LANDING_DITHER.patternDensity - 0.5) * 0.3;
			if (feed + threshold - 0.5 < 0.5) {
				continue;
			}
			const distance = Math.hypot(x - centerX, y - centerY) / maxDistance;
			const fade = Math.max(0, 1 - distance * (1 + LANDING_DITHER.edgeFade));
			const wave =
				Math.sin(
					(x + y) * LANDING_DITHER.rippleThickness +
						LANDING_DITHER.speed * LANDING_DITHER.rippleSpeed * 10
				) *
					0.08 *
					LANDING_DITHER.rippleIntensityScale +
				0.12;
			ctx.globalAlpha = Math.max(0, Math.min(0.2, fade * wave));
			ctx.fillRect(x, y, pixel, pixel);
		}
	}
	ctx.restore();
}

function hashFloat(value: number): number {
	return fract(Math.sin(value) * 43_758.5453);
}

function fract(value: number): number {
	return value - Math.floor(value);
}

function bayer2(x: number, y: number): number {
	const ax = Math.floor(x);
	const ay = Math.floor(y);
	return fract(ax / 2 + ay * ay * 0.75);
}

function bayer4(x: number, y: number): number {
	return bayer2(0.5 * x, 0.5 * y) * 0.25 + bayer2(x, y);
}

function bayer8(x: number, y: number): number {
	return bayer4(0.5 * x, 0.5 * y) * 0.25 + bayer2(x, y);
}

/** Draw the Ryu mark, centred at `cx`, `height` tall, in `color`. */
export function drawLogo(
	ctx: CanvasRenderingContext2D,
	cx: number,
	topY: number,
	height: number,
	color: string
): void {
	const scale = height / 24;
	const width = 24 * scale;
	ctx.save();
	ctx.translate(cx - width / 2, topY);
	ctx.scale(scale, scale);
	const outline = new Path2D(RYU_PATH);
	ctx.strokeStyle = color;
	ctx.lineWidth = 1.5;
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	ctx.stroke(outline);
	ctx.fillStyle = color;
	for (const eyeX of [15, 19]) {
		ctx.beginPath();
		ctx.ellipse(eyeX, 10, 1.5, 3, 0, 0, Math.PI * 2);
		ctx.fill();
	}
	ctx.restore();
}

/** Rasterize a scannable QR for `text`, top-left at `x,y`, `size` px square. */
export function drawQr(
	ctx: CanvasRenderingContext2D,
	text: string,
	x: number,
	y: number,
	size: number,
	color: string
): void {
	const codeSize = size - QR_QUIET_ZONE * 2;
	const codeX = x + QR_QUIET_ZONE;
	const codeY = y + QR_QUIET_ZONE;
	const geometry = createQRCodeGeometry(text, codeSize);
	if (!geometry) {
		return;
	}

	const {
		circleRadius,
		circles,
		finderPositions,
		finderSize,
		innerBlackSize,
		innerPadding,
		innerWhiteSize,
		moduleSize,
	} = geometry;

	ctx.fillStyle = CARD_TOP;
	ctx.beginPath();
	ctx.roundRect(x, y, size, size, 12);
	ctx.fill();

	for (const [row, column] of finderPositions) {
		const finderX = codeX + column * moduleSize;
		const finderY = codeY + row * moduleSize;

		ctx.fillStyle = color;
		ctx.beginPath();
		ctx.roundRect(finderX, finderY, finderSize, finderSize, 12);
		ctx.fill();

		ctx.fillStyle = CARD_TOP;
		ctx.beginPath();
		ctx.roundRect(
			finderX + innerPadding,
			finderY + innerPadding,
			innerWhiteSize,
			innerWhiteSize,
			8
		);
		ctx.fill();

		ctx.fillStyle = color;
		ctx.beginPath();
		ctx.roundRect(
			finderX + innerPadding * 2,
			finderY + innerPadding * 2,
			innerBlackSize,
			innerBlackSize,
			3
		);
		ctx.fill();
	}

	ctx.fillStyle = color;
	for (const { cx, cy } of circles) {
		ctx.beginPath();
		ctx.arc(codeX + cx, codeY + cy, circleRadius, 0, Math.PI * 2);
		ctx.fill();
	}
}

/** Draw `text` with manual letter-spacing (canvas has no letterSpacing here). */
export function drawTracked(
	ctx: CanvasRenderingContext2D,
	text: string,
	cx: number,
	y: number,
	tracking: number
): void {
	if (!RE_TRACKABLE.test(text)) {
		ctx.fillText(text, cx, y);
		return;
	}
	const widths = [...text].map((ch) => ctx.measureText(ch).width + tracking);
	const total = widths.reduce((a, b) => a + b, 0) - tracking;
	const prevAlign = ctx.textAlign;
	ctx.textAlign = "left";
	let x = cx - total / 2;
	for (let i = 0; i < text.length; i++) {
		ctx.fillText(text[i] ?? "", x, y);
		x += widths[i] ?? 0;
	}
	ctx.textAlign = prevAlign;
}

/** Trim `text` with an ellipsis so it fits `maxWidth` at the current font. */
export function ellipsize(
	ctx: CanvasRenderingContext2D,
	text: string,
	maxWidth: number
): string {
	if (ctx.measureText(text).width <= maxWidth) {
		return text;
	}
	let out = text;
	while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) {
		out = out.slice(0, -1);
	}
	return `${out.trimEnd()}…`;
}
