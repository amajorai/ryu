import type { IslandMaterialContour } from "./ipc.ts";

const MAX_MASK_DIMENSION = 1024;
const MAX_MASK_CONTOURS = 8;

export interface MaterialMask {
	height: number;
	shapes: IslandMaterialContour[];
	width: number;
}

export interface MaskRect {
	height: number;
	width: number;
	x: number;
	y: number;
}

/** Bound renderer geometry before it reaches a native window or bitmap. */
export function normalizeMaterialMask(
	width: number,
	height: number,
	contours: readonly IslandMaterialContour[]
): MaterialMask | null {
	if (
		!(Number.isFinite(width) && Number.isFinite(height)) ||
		width < 1 ||
		height < 1 ||
		width > MAX_MASK_DIMENSION ||
		height > MAX_MASK_DIMENSION ||
		!Array.isArray(contours) ||
		contours.length < 1 ||
		contours.length > MAX_MASK_CONTOURS
	) {
		return null;
	}

	const maskWidth = Math.round(width);
	const maskHeight = Math.round(height);
	const normalized: IslandMaterialContour[] = [];
	for (const contour of contours) {
		if (
			!(
				Number.isFinite(contour?.x) &&
				Number.isFinite(contour?.y) &&
				Number.isFinite(contour?.width) &&
				Number.isFinite(contour?.height) &&
				Number.isFinite(contour?.radius)
			) ||
			contour.width < 1 ||
			contour.height < 1 ||
			contour.radius < 0
		) {
			return null;
		}
		const x = Math.round(contour.x);
		const y = Math.round(contour.y);
		const contourWidth = Math.round(contour.width);
		const contourHeight = Math.round(contour.height);
		if (
			x < 0 ||
			y < 0 ||
			contourWidth < 1 ||
			contourHeight < 1 ||
			x + contourWidth > maskWidth ||
			y + contourHeight > maskHeight
		) {
			return null;
		}
		normalized.push({
			x,
			y,
			width: contourWidth,
			height: contourHeight,
			radius: Math.min(contour.radius, contourWidth / 2, contourHeight / 2),
		});
	}
	return { width: maskWidth, height: maskHeight, shapes: normalized };
}

function roundedDistance(
	x: number,
	y: number,
	contour: IslandMaterialContour
): number {
	const halfWidth = contour.width / 2;
	const halfHeight = contour.height / 2;
	const dx =
		Math.abs(x - (contour.x + halfWidth)) - (halfWidth - contour.radius);
	const dy =
		Math.abs(y - (contour.y + halfHeight)) - (halfHeight - contour.radius);
	return (
		Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) +
		Math.min(Math.max(dx, dy), 0) -
		contour.radius
	);
}

/** AppKit uses this alpha channel to confine vibrancy to Island surfaces. */
export function materialMaskBitmap(mask: MaterialMask): Buffer {
	const bitmap = Buffer.alloc(mask.width * mask.height * 4);
	for (let y = 0; y < mask.height; y += 1) {
		for (let x = 0; x < mask.width; x += 1) {
			let distance = Number.POSITIVE_INFINITY;
			for (const contour of mask.shapes) {
				distance = Math.min(
					distance,
					roundedDistance(x + 0.5, y + 0.5, contour)
				);
			}
			const alpha = Math.round(255 * Math.min(1, Math.max(0, 0.5 - distance)));
			const index = (y * mask.width + x) * 4;
			bitmap[index] = alpha;
			bitmap[index + 1] = alpha;
			bitmap[index + 2] = alpha;
			bitmap[index + 3] = alpha;
		}
	}
	return bitmap;
}

/** Electron setShape accepts rectangles; merge equal scanlines to keep it small. */
export function materialMaskRects(mask: MaterialMask): MaskRect[] {
	const rects: MaskRect[] = [];
	let previous = new Map<string, MaskRect>();
	for (let y = 0; y < mask.height; y += 1) {
		const current = new Map<string, MaskRect>();
		let start = -1;
		for (let x = 0; x <= mask.width; x += 1) {
			const inside =
				x < mask.width &&
				mask.shapes.some(
					(contour) => roundedDistance(x + 0.5, y + 0.5, contour) <= 0
				);
			if (inside && start === -1) {
				start = x;
			} else if (!inside && start !== -1) {
				const key = `${start}:${x - start}`;
				const continuing = previous.get(key);
				if (continuing) {
					continuing.height += 1;
					current.set(key, continuing);
				} else {
					const rect = { x: start, y, width: x - start, height: 1 };
					rects.push(rect);
					current.set(key, rect);
				}
				start = -1;
			}
		}
		previous = current;
	}
	return rects;
}
