// The back face (the dot QR or the centred mark), the face silhouette and the
// avatar loader. Split from `paint.ts`, which re-exports them.

import { passQrColors } from "../../lib/pass-qr.ts";
import { createQRCodeGeometry } from "../../lib/qr-code.ts";
import { ditherAvatarHue } from "../dither-kit/avatar.tsx";
import { METAL_EDGE_RING_PX } from "../metal-edge.tsx";
import { FACE_RADIUS_PX } from "../pass-card-shell.tsx";
import { activePassTranslate, type PassTranslate } from "./labels.ts";
import { CARD_HEIGHT_PX, CARD_WIDTH_PX, type PassFaceEnv } from "./paint.ts";
import { drawGhost } from "./paint-ghost.ts";
import { font, type PassPalette } from "./paint-text.ts";

/** The mark alone on the back, at the size the live back face draws it. */
const BACK_LOGO_PX = 48;

export function paintBackQr(
	ctx: CanvasRenderingContext2D,
	{
		caption,
		env,
		seed,
		tl = activePassTranslate,
		value,
	}: {
		caption: string;
		env: PassFaceEnv;
		seed: string;
		/** Translates the placeholder shown while the link is not ready yet. */
		tl?: PassTranslate;
		value?: string | null;
	}
): void {
	const { family, isDark, scale } = env;
	const size = 224 * scale;
	const left = (CARD_WIDTH_PX * scale - size) / 2;
	const top = (CARD_HEIGHT_PX * scale - size) / 2 - 8 * scale;
	const colors = passQrColors(ditherAvatarHue(seed), isDark);
	const geometry = value ? createQRCodeGeometry(value.trim(), size, "H") : null;

	ctx.save();
	ctx.fillStyle = colors.surface;
	ctx.shadowColor = colors.glow;
	ctx.shadowBlur = 24 * scale;
	ctx.beginPath();
	ctx.roundRect(
		left - 14 * scale,
		top - 14 * scale,
		size + 28 * scale,
		size + 28 * scale,
		26 * scale
	);
	ctx.fill();
	ctx.shadowBlur = 0;

	if (geometry) {
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
		ctx.fillStyle = colors.foreground;
		for (const [row, column] of finderPositions) {
			const x = left + column * moduleSize;
			const y = top + row * moduleSize;
			ctx.beginPath();
			ctx.roundRect(x, y, finderSize, finderSize, 12 * scale);
			ctx.fill();
			ctx.fillStyle = colors.surface;
			ctx.beginPath();
			ctx.roundRect(
				x + innerPadding,
				y + innerPadding,
				innerWhiteSize,
				innerWhiteSize,
				8 * scale
			);
			ctx.fill();
			ctx.fillStyle = colors.foreground;
			ctx.beginPath();
			ctx.roundRect(
				x + innerPadding * 2,
				y + innerPadding * 2,
				innerBlackSize,
				innerBlackSize,
				3 * scale
			);
			ctx.fill();
		}
		ctx.fillStyle = colors.foreground;
		for (const { cx, cy } of circles) {
			ctx.beginPath();
			ctx.arc(left + cx, top + cy, circleRadius, 0, Math.PI * 2);
			ctx.fill();
		}

		const logoPlate = 40 * scale;
		ctx.fillStyle = colors.surface;
		ctx.beginPath();
		ctx.roundRect(
			left + (size - logoPlate) / 2,
			top + (size - logoPlate) / 2,
			logoPlate,
			logoPlate,
			10 * scale
		);
		ctx.fill();
		drawGhost(ctx, {
			color: colors.foreground,
			scale,
			size: 25,
			x: (CARD_WIDTH_PX - 25) / 2,
			y: (CARD_HEIGHT_PX - 25) / 2 - 8,
		});
	} else {
		ctx.strokeStyle = colors.glow;
		ctx.lineWidth = scale;
		ctx.setLineDash([4 * scale, 4 * scale]);
		ctx.beginPath();
		ctx.roundRect(left, top, size, size, 24 * scale);
		ctx.stroke();
		ctx.setLineDash([]);
	}

	ctx.font = font(family, 500, 10, scale);
	ctx.fillStyle = colors.foreground;
	ctx.textAlign = "center";
	ctx.fillText(
		(geometry ? caption : tl("Invite link is preparing")).toUpperCase(),
		(CARD_WIDTH_PX * scale) / 2,
		(CARD_HEIGHT_PX - 52) * scale
	);
	ctx.restore();
}

/** The legacy default back for passes that do not carry a share destination. */
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
export function faceRect(scale: number) {
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
