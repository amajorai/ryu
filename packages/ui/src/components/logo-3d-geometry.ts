import {
	BufferGeometry,
	Shape as ContourPath,
	Float32BufferAttribute,
	Vector3,
} from "three";

/** Loft the canonical ghost contour through rounded horizontal cross-sections.
 * This avoids carrying the tail's concavity across the face as a radial ridge.
 */
let cachedGeometry: BufferGeometry | undefined;
const sections: { center: number; width: number; depth: number; y: number }[] =
	[];

function frontDepth(x: number, y: number): number | undefined {
	for (let index = 1; index < sections.length; index += 1) {
		const below = sections[index - 1];
		const above = sections[index];
		if (!(below && above) || y < below.y || y > above.y) {
			continue;
		}
		const t = (y - below.y) / (above.y - below.y);
		const center = below.center + (above.center - below.center) * t;
		const width = below.width + (above.width - below.width) * t;
		const depth = below.depth + (above.depth - below.depth) * t;
		const u = (x - center) / width;
		if (Math.abs(u) >= 1) {
			return;
		}
		return depth * Math.sqrt(1 - u * u);
	}
}

/** Constant-cost surface placement for moving eyes, without per-frame raycasts. */
export function sampleGhostSurface(x: number, y: number) {
	const z = frontDepth(x, y);
	if (z === undefined) {
		return;
	}
	const step = 0.01;
	const dx =
		((frontDepth(x + step, y) ?? z) - (frontDepth(x - step, y) ?? z)) /
		(2 * step);
	const dy =
		((frontDepth(x, y + step) ?? z) - (frontDepth(x, y - step) ?? z)) /
		(2 * step);
	return {
		position: new Vector3(x, y, z),
		normal: new Vector3(-dx, -dy, 1).normalize(),
	};
}

export function createGhostGeometry() {
	if (cachedGeometry) {
		return cachedGeometry.clone();
	}
	const outline = new ContourPath();
	outline.moveTo(12, 24);
	outline.bezierCurveTo(21.2, 24, 24.9, 19.2, 24.4, 9.4);
	outline.bezierCurveTo(24.1, 0.3, 12.8, -3.7, 8.8, 5.4);
	outline.bezierCurveTo(6.6, 11.1, 9.9, 13.3, 5.9, 18);
	outline.bezierCurveTo(5, 19.1, 4.1, 20, 3.2, 21.1);
	outline.bezierCurveTo(2, 22.4, 3.9, 23.3, 5.1, 23.3);
	outline.bezierCurveTo(7.4, 23.3, 9.7, 24, 12, 24);
	let contour = outline.getSpacedPoints(256).slice(0, -1);
	// Smooth the small tangent discontinuities at the original SVG curve joins.
	for (let pass = 0; pass < 8; pass += 1) {
		contour = contour.map((point, index) => {
			const previous = contour[(index + contour.length - 1) % contour.length];
			const next = contour[(index + 1) % contour.length];
			return previous && next
				? point
						.clone()
						.multiplyScalar(0.5)
						.addScaledVector(previous, 0.25)
						.addScaledVector(next, 0.25)
				: point;
		});
	}

	const levels = 80;
	const segments = 128;
	const minimumY = Math.min(...contour.map((point) => point.y));
	const maximumY = Math.max(...contour.map((point) => point.y));
	const top = contour.reduce((a, b) => (a.y < b.y ? a : b));
	const bottom = contour.reduce((a, b) => (a.y > b.y ? a : b));
	const positions: number[] = [bottom.x - 14, 12 - maximumY, 0];
	const indices: number[] = [];
	// Each horizontal slice is a complete ellipse. The face has no radial seams
	// from the asymmetric tail, and both sides share one continuous surface.
	for (let level = 1; level < levels; level += 1) {
		const latitude = -Math.PI / 2 + (level / levels) * Math.PI;
		const y = minimumY + ((maximumY - minimumY) * (1 - Math.sin(latitude))) / 2;
		const crossings: number[] = [];
		for (const [index, point] of contour.entries()) {
			const next = contour[(index + 1) % contour.length];
			if (next && point.y > y !== next.y > y) {
				crossings.push(
					point.x + ((next.x - point.x) * (y - point.y)) / (next.y - point.y)
				);
			}
		}
		const left = Math.min(...crossings);
		const right = Math.max(...crossings);
		const center = (left + right) / 2 - 14;
		const width = (right - left) / 2;
		sections.push({ center, width, depth: 7 * Math.cos(latitude), y: 12 - y });
		for (let segment = 0; segment < segments; segment += 1) {
			const angle = (segment / segments) * Math.PI * 2;
			positions.push(
				center + width * Math.cos(angle),
				12 - y,
				7 * Math.cos(latitude) * Math.sin(angle)
			);
		}
	}
	const topIndex = positions.length / 3;
	positions.push(top.x - 14, 12 - minimumY, 0);
	for (let segment = 0; segment < segments; segment += 1) {
		const next = (segment + 1) % segments;
		indices.push(0, 1 + segment, 1 + next);
		for (let level = 0; level < levels - 2; level += 1) {
			const a = 1 + level * segments + segment;
			const b = 1 + level * segments + next;
			indices.push(a, a + segments, b, b, a + segments, b + segments);
		}
		const last = 1 + (levels - 2) * segments;
		indices.push(last + segment, topIndex, last + next);
	}
	const geometry = new BufferGeometry();
	geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
	geometry.setIndex(indices);
	geometry.computeVertexNormals();
	geometry.computeBoundingSphere();
	cachedGeometry = geometry;
	return geometry.clone();
}
