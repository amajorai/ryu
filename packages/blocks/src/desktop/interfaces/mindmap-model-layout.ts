import type {
	MindmapKind,
	MindmapNode,
	MindmapSide,
	MindmapTree,
} from "./mindmap-model.ts";

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface MindmapSize {
	height: number;
	width: number;
}

/** Fixed row heights per kind; widths come from the label (or a measurement). */
export const MINDMAP_HEIGHT: Record<MindmapKind, number> = {
	agent: 28,
	group: 32,
	more: 24,
	root: 44,
	thread: 24,
};

/** Widest a thread leaf grows before its title truncates. */
export const MINDMAP_THREAD_MAX_WIDTH = 280;

/** Rough label widths before the DOM measures the real ones. */
export function estimateSize(node: MindmapNode): MindmapSize {
	const chars = node.label.length;
	const height = MINDMAP_HEIGHT[node.kind];
	switch (node.kind) {
		case "root":
			return { height, width: Math.round(40 + chars * 8.6) };
		case "group":
			return { height, width: Math.round(8 + chars * 8.4) };
		case "agent":
			return {
				height,
				width: Math.round(40 + chars * 7.9 + (node.working ? 14 : 0)),
			};
		case "thread": {
			const mark =
				node.status === "quiet" || node.status === "waiting" ? 0 : 14;
			return {
				height,
				width: Math.min(
					MINDMAP_THREAD_MAX_WIDTH,
					Math.round(8 + mark + chars * 7.4)
				),
			};
		}
		default:
			return { height, width: Math.round(8 + chars * 6.6) };
	}
}

/** Space between a parent's outer edge and its children, by child kind. */
const GAP_X: Record<MindmapKind, number> = {
	agent: 48,
	group: 88,
	more: 52,
	root: 0,
	thread: 52,
};

/** Space between sibling subtrees, by kind. */
const GAP_Y: Record<MindmapKind, number> = {
	agent: 22,
	group: 64,
	more: 8,
	root: 0,
	thread: 10,
};

/** Branch thickness where an edge starts and ends, by child depth. */
const TAPER: readonly [number, number][] = [
	[0, 0],
	[8, 3],
	[3, 2],
	[2, 1.25],
];

export interface MindmapPlaced extends MindmapSize {
	id: string;
	/** Left edge, world units (You is centred on the origin). */
	x: number;
	/** Top edge. */
	y: number;
}

export interface MindmapEdge {
	branch: number;
	childId: string;
	/** The same outline shrunk onto the parent's anchor: where it grows from. */
	collapsedPath: string;
	/** A filled, tapered outline: curve, then the child's underline if any. */
	path: string;
}

export interface MindmapPoint {
	x: number;
	y: number;
}

export interface MindmapBounds {
	maxX: number;
	maxY: number;
	minX: number;
	minY: number;
}

export interface MindmapLayout {
	bounds: MindmapBounds;
	edges: MindmapEdge[];
	/** Visible node ids in reading order (tree pre-order). */
	order: string[];
	placed: Map<string, MindmapPlaced>;
}

export type SizeOf = (node: MindmapNode) => MindmapSize;

/** Children shown on the map: none while folded. */
export function visibleChildren(
	tree: MindmapTree,
	node: MindmapNode,
	collapsed: ReadonlySet<string>
): MindmapNode[] {
	if (node.kind !== "root" && collapsed.has(node.id)) {
		return [];
	}
	const children: MindmapNode[] = [];
	for (const id of node.childIds) {
		const child = tree.nodes.get(id);
		if (child) {
			children.push(child);
		}
	}
	return children;
}

/** Labels sit on an underline (MindNode style) except You and agents. */
export function hasUnderline(kind: MindmapKind): boolean {
	return kind === "group" || kind === "thread" || kind === "more";
}

function blockHeights(
	tree: MindmapTree,
	collapsed: ReadonlySet<string>,
	sizeOf: SizeOf
): Map<string, number> {
	const heights = new Map<string, number>();
	const visit = (node: MindmapNode): number => {
		const children = visibleChildren(tree, node, collapsed);
		let stack = 0;
		for (const [index, child] of children.entries()) {
			stack += visit(child) + (index > 0 ? GAP_Y[child.kind] : 0);
		}
		const own = sizeOf(node).height;
		const height = Math.max(own, stack);
		heights.set(node.id, height);
		return height;
	};
	const root = tree.nodes.get(tree.rootId);
	if (root) {
		visit(root);
	}
	return heights;
}

function round(value: number): number {
	return Math.round(value * 10) / 10;
}

const TAPER_STEPS = 16;

/**
 * A filled branch that tapers from `startWidth` to `endWidth` along a smooth
 * horizontal S-curve, then (for underlined labels) runs flat to `underlineTo`.
 * The outline offsets the curve along its normal, so steep stretches keep
 * their thickness. Same command count for every edge, so paths can morph.
 */
export function taperPath(
	start: MindmapPoint,
	end: MindmapPoint,
	startWidth: number,
	endWidth: number,
	underlineTo: number = end.x
): string {
	const midX = (start.x + end.x) / 2;
	const top: string[] = [];
	const bottom: string[] = [];
	for (let step = 0; step <= TAPER_STEPS; step++) {
		const t = step / TAPER_STEPS;
		const inverse = 1 - t;
		// Cubic Bézier with horizontal tangents at both ends.
		const x =
			inverse ** 3 * start.x +
			3 * inverse ** 2 * t * midX +
			3 * inverse * t ** 2 * midX +
			t ** 3 * end.x;
		const y =
			inverse ** 3 * start.y +
			3 * inverse ** 2 * t * start.y +
			3 * inverse * t ** 2 * end.y +
			t ** 3 * end.y;
		const dx =
			3 * inverse ** 2 * (midX - start.x) + 3 * t ** 2 * (end.x - midX);
		const dy = 6 * inverse * t * (end.y - start.y);
		const length = Math.hypot(dx, dy) || 1;
		const half = (startWidth + (endWidth - startWidth) * t ** 0.8) / 2;
		const normalX = (-dy / length) * half;
		const normalY = (dx / length) * half;
		top.push(`${round(x + normalX)} ${round(y + normalY)}`);
		bottom.push(`${round(x - normalX)} ${round(y - normalY)}`);
	}
	const half = endWidth / 2;
	bottom.reverse();
	return `M${top.join("L")}L${round(underlineTo)} ${round(end.y + (end.x <= start.x ? -half : half))}L${round(underlineTo)} ${round(end.y + (end.x <= start.x ? half : -half))}L${bottom.join("L")}Z`;
}

function anchorY(node: MindmapNode, placed: MindmapPlaced): number {
	if (hasUnderline(node.kind)) {
		return placed.y + placed.height - 1;
	}
	return placed.y + placed.height / 2;
}

/** Where branches leave a node toward its children. */
export function outerAnchor(
	node: MindmapNode,
	placed: MindmapPlaced,
	side: MindmapSide
): MindmapPoint {
	if (node.kind === "root") {
		// Start inside You, so thick roots tuck under the centre label.
		const inset = Math.min(16, placed.width / 4);
		return {
			x: side === "right" ? placed.x + placed.width - inset : placed.x + inset,
			y: placed.y + placed.height / 2,
		};
	}
	return {
		x: side === "right" ? placed.x + placed.width : placed.x,
		y: anchorY(node, placed),
	};
}

function innerAnchor(
	node: MindmapNode,
	placed: MindmapPlaced,
	side: MindmapSide
): MindmapPoint {
	return {
		x: side === "right" ? placed.x : placed.x + placed.width,
		y: anchorY(node, placed),
	};
}

/**
 * Lay the visible tree out: You centred on the origin, each side's branches
 * stacked around it, every subtree centred on its parent.
 */
export function layoutMindmap(
	tree: MindmapTree,
	collapsed: ReadonlySet<string>,
	sizeOf: SizeOf = estimateSize
): MindmapLayout {
	const placed = new Map<string, MindmapPlaced>();
	const edges: MindmapEdge[] = [];
	const order: string[] = [];
	const bounds: MindmapBounds = {
		maxX: Number.NEGATIVE_INFINITY,
		maxY: Number.NEGATIVE_INFINITY,
		minX: Number.POSITIVE_INFINITY,
		minY: Number.POSITIVE_INFINITY,
	};
	const root = tree.nodes.get(tree.rootId);
	if (!root) {
		return {
			bounds: { maxX: 0, maxY: 0, minX: 0, minY: 0 },
			edges,
			order,
			placed,
		};
	}
	const heights = blockHeights(tree, collapsed, sizeOf);
	const grow = (box: MindmapPlaced) => {
		bounds.minX = Math.min(bounds.minX, box.x);
		bounds.minY = Math.min(bounds.minY, box.y);
		bounds.maxX = Math.max(bounds.maxX, box.x + box.width);
		bounds.maxY = Math.max(bounds.maxY, box.y + box.height);
	};
	const rootSize = sizeOf(root);
	const rootBox: MindmapPlaced = {
		...rootSize,
		id: root.id,
		x: -rootSize.width / 2,
		y: -rootSize.height / 2,
	};
	placed.set(root.id, rootBox);
	order.push(root.id);
	grow(rootBox);

	const placeChildren = (
		parent: MindmapNode,
		children: readonly MindmapNode[],
		side: MindmapSide
	) => {
		const parentBox = placed.get(parent.id);
		if (!parentBox || children.length === 0) {
			return;
		}
		const from = outerAnchor(parent, parentBox, side);
		let total = 0;
		for (const [index, child] of children.entries()) {
			total +=
				(heights.get(child.id) ?? 0) + (index > 0 ? GAP_Y[child.kind] : 0);
		}
		let cursor = parentBox.y + parentBox.height / 2 - total / 2;
		for (const [index, child] of children.entries()) {
			if (index > 0) {
				cursor += GAP_Y[child.kind];
			}
			const block = heights.get(child.id) ?? 0;
			const size = sizeOf(child);
			const edgeX =
				side === "right"
					? parentBox.x + parentBox.width + GAP_X[child.kind]
					: parentBox.x - GAP_X[child.kind];
			const box: MindmapPlaced = {
				...size,
				id: child.id,
				x: side === "right" ? edgeX : edgeX - size.width,
				y: cursor + block / 2 - size.height / 2,
			};
			placed.set(child.id, box);
			order.push(child.id);
			grow(box);
			const to = innerAnchor(child, box, side);
			const [startWidth, endWidth] = TAPER[Math.min(child.depth, 3)] ?? [2, 1];
			const underlineTo = hasUnderline(child.kind)
				? outerAnchor(child, box, side).x
				: to.x;
			edges.push({
				branch: child.branch,
				childId: child.id,
				collapsedPath: taperPath(from, from, 0, 0, from.x),
				path: taperPath(from, to, startWidth, endWidth, underlineTo),
			});
			placeChildren(child, visibleChildren(tree, child, collapsed), side);
			cursor += block;
		}
	};

	const rootChildren = visibleChildren(tree, root, collapsed);
	placeChildren(
		root,
		rootChildren.filter((child) => child.side !== "left"),
		"right"
	);
	placeChildren(
		root,
		rootChildren.filter((child) => child.side === "left"),
		"left"
	);
	return { bounds, edges, order, placed };
}
