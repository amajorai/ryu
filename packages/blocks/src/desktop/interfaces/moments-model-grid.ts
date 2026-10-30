/** Step an index by delta, clamped to the list. */
export function momentsStep(index: number, delta: number, length: number) {
	if (length === 0) {
		return 0;
	}
	return Math.min(length - 1, Math.max(0, index + delta));
}

/** A card's place on screen, as the timeline grid lays it out. */
export interface MomentsRect {
	height: number;
	left: number;
	top: number;
}

/**
 * The card an arrow key moves to in the timeline grid. "row" steps to the
 * nearest card in the next row down (or up), keeping the column; "column"
 * steps to the neighbour in the same row, else the next card in list order.
 * At the grid's edge it stays put. Null when there is no layout to read
 * (nothing measured), so callers fall back to list order.
 */
export function momentsGridStep(
	rects: MomentsRect[],
	index: number,
	axis: "column" | "row",
	delta: 1 | -1
): number | null {
	const from = rects[index];
	if (!from || from.height === 0) {
		return null;
	}
	let best: number | null = null;
	let bestScore = Number.POSITIVE_INFINITY;
	for (const [candidate, rect] of rects.entries()) {
		if (candidate === index) {
			continue;
		}
		const sameRow = Math.abs(rect.top - from.top) < from.height / 2;
		let score = Number.POSITIVE_INFINITY;
		if (axis === "column") {
			const dx = (rect.left - from.left) * delta;
			score = sameRow && dx > 0 ? dx : score;
		} else {
			const dy = (rect.top - from.top) * delta;
			if (!sameRow && dy > 0) {
				// The nearest row first, then the closest column within it.
				score = dy * 10_000 + Math.abs(rect.left - from.left);
			}
		}
		if (score < bestScore) {
			bestScore = score;
			best = candidate;
		}
	}
	if (best === null && axis === "column") {
		return Math.min(rects.length - 1, Math.max(0, index + delta));
	}
	return best ?? index;
}
