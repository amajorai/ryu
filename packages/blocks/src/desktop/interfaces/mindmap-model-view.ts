import type { MindmapNode, MindmapSide, MindmapTree } from "./mindmap-model.ts";
import {
	type MindmapBounds,
	type MindmapLayout,
	type MindmapPlaced,
	type MindmapPoint,
	type MindmapSize,
	visibleChildren,
} from "./mindmap-model-layout.ts";

// ---------------------------------------------------------------------------
// View (pan and zoom)
// ---------------------------------------------------------------------------

export interface MindmapView {
	/** Scale. */
	k: number;
	/** Screen offset of the world origin. */
	x: number;
	y: number;
}

export const MINDMAP_MIN_ZOOM = 0.25;
export const MINDMAP_MAX_ZOOM = 2;

export function clampZoom(k: number): number {
	return Math.min(MINDMAP_MAX_ZOOM, Math.max(MINDMAP_MIN_ZOOM, k));
}

/**
 * Frame the whole map, never above `maxZoom` (100% unless the caller lets a
 * small map grow into the window), centred in the viewport. `minZoom` lets
 * automatic framing keep labels legible (the map may then overflow).
 */
export function fitView(
	bounds: MindmapBounds,
	viewport: MindmapSize,
	minZoom = MINDMAP_MIN_ZOOM,
	padding = 56,
	maxZoom = 1
): MindmapView {
	const width = Math.max(1, bounds.maxX - bounds.minX);
	const height = Math.max(1, bounds.maxY - bounds.minY);
	const k = clampZoom(
		Math.max(
			minZoom,
			Math.min(
				maxZoom,
				(viewport.width - padding * 2) / width,
				(viewport.height - padding * 2) / height
			)
		)
	);
	return {
		k,
		x: viewport.width / 2 - (bounds.minX + width / 2) * k,
		y: viewport.height / 2 - (bounds.minY + height / 2) * k,
	};
}

/** Zoom by `factor` keeping the screen point `at` fixed. */
export function zoomAt(
	view: MindmapView,
	factor: number,
	at: MindmapPoint
): MindmapView {
	const k = clampZoom(view.k * factor);
	const ratio = k / view.k;
	return {
		k,
		x: at.x - (at.x - view.x) * ratio,
		y: at.y - (at.y - view.y) * ratio,
	};
}

/** The smallest pan that brings `box` inside the viewport (with a margin). */
export function revealBox(
	view: MindmapView,
	box: MindmapPlaced,
	viewport: MindmapSize,
	margin = 48
): MindmapView {
	const left = view.x + box.x * view.k;
	const top = view.y + box.y * view.k;
	const right = left + box.width * view.k;
	const bottom = top + box.height * view.k;
	let dx = 0;
	let dy = 0;
	if (left < margin) {
		dx = margin - left;
	} else if (right > viewport.width - margin) {
		dx = Math.max(viewport.width - margin - right, margin - left);
	}
	if (top < margin) {
		dy = margin - top;
	} else if (bottom > viewport.height - margin) {
		dy = Math.max(viewport.height - margin - bottom, margin - top);
	}
	if (dx === 0 && dy === 0) {
		return view;
	}
	return { k: view.k, x: view.x + dx, y: view.y + dy };
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

export type MindmapMove =
	| { kind: "expand"; id: string }
	| { kind: "focus"; id: string };

function centreY(box: MindmapPlaced): number {
	return box.y + box.height / 2;
}

function closestByY(
	ids: readonly string[],
	layout: MindmapLayout,
	targetY: number
): string | null {
	let best: string | null = null;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const id of ids) {
		const box = layout.placed.get(id);
		if (!box) {
			continue;
		}
		const distance = Math.abs(centreY(box) - targetY);
		if (distance < bestDistance) {
			best = id;
			bestDistance = distance;
		}
	}
	return best;
}

function verticalNeighbour(
	tree: MindmapTree,
	layout: MindmapLayout,
	node: MindmapNode,
	direction: -1 | 1
): string | null {
	const from = layout.placed.get(node.id);
	if (!from) {
		return null;
	}
	const y = centreY(from);
	let best: string | null = null;
	let bestScore = Number.POSITIVE_INFINITY;
	for (const id of layout.order) {
		const other = tree.nodes.get(id);
		const box = layout.placed.get(id);
		if (
			!(other && box) ||
			other.id === node.id ||
			other.depth !== node.depth ||
			other.side !== node.side
		) {
			continue;
		}
		const dy = (centreY(box) - y) * direction;
		if (dy <= 0) {
			continue;
		}
		// Prefer siblings, then the nearest row at the same depth.
		const score = dy + (other.parentId === node.parentId ? 0 : 10_000);
		if (score < bestScore) {
			best = id;
			bestScore = score;
		}
	}
	return best;
}

/**
 * Arrow keys follow the map: outward goes to a child (unfolding a folded
 * node first), inward to the parent, up and down to the neighbour at the same
 * level. On You, left and right pick a side.
 */
export function moveFocus(
	tree: MindmapTree,
	layout: MindmapLayout,
	collapsed: ReadonlySet<string>,
	fromId: string,
	key: string
): MindmapMove | null {
	const node = tree.nodes.get(fromId);
	if (!node) {
		return null;
	}
	if (key === "Home") {
		return { id: tree.rootId, kind: "focus" };
	}
	if (key === "ArrowUp" || key === "ArrowDown") {
		const next = verticalNeighbour(
			tree,
			layout,
			node,
			key === "ArrowUp" ? -1 : 1
		);
		return next ? { id: next, kind: "focus" } : null;
	}
	if (key !== "ArrowLeft" && key !== "ArrowRight") {
		return null;
	}
	const pressed: MindmapSide = key === "ArrowRight" ? "right" : "left";
	const box = layout.placed.get(node.id);
	if (node.kind === "root") {
		const children = visibleChildren(tree, node, collapsed)
			.filter((child) => child.side === pressed)
			.map((child) => child.id);
		const next = closestByY(children, layout, box ? centreY(box) : 0);
		return next ? { id: next, kind: "focus" } : null;
	}
	if (pressed !== node.side) {
		return node.parentId ? { id: node.parentId, kind: "focus" } : null;
	}
	if (node.childIds.length === 0) {
		return null;
	}
	if (collapsed.has(node.id)) {
		return { id: node.id, kind: "expand" };
	}
	const next = closestByY(node.childIds, layout, box ? centreY(box) : 0);
	return next ? { id: next, kind: "focus" } : null;
}

/** The nearest ancestor still on the map (folding hides descendants). */
export function visibleAncestor(
	tree: MindmapTree,
	layout: MindmapLayout,
	id: string
): string {
	let current = tree.nodes.get(id);
	while (current && !layout.placed.has(current.id)) {
		current = current.parentId ? tree.nodes.get(current.parentId) : undefined;
	}
	return current?.id ?? tree.rootId;
}
