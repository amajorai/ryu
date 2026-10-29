// Longest-path layering for the gateway canvas (spec 07.5): no layout
// library. Nodes that share a `group` collapse into one column and stack in
// traffic order; every other node gets the column one past its deepest
// predecessor. Infrastructure without traffic edges sits in a band below.

import type { CanvasTopology } from "./model.ts";

export const CANVAS_NODE_WIDTH = 168;
export const CANVAS_NODE_HEIGHT = 60;
const COLUMN_GAP = 52;
const ROW_GAP = 20;
const INFRA_GAP = 72;

export interface CanvasPlacement {
	column: number;
	/** Top-left corner, in flow coordinates. */
	x: number;
	y: number;
}

export type CanvasLayout = Record<string, CanvasPlacement>;

function groupKey(topology: CanvasTopology): Map<string, string> {
	return new Map(
		topology.nodes.map((node) => [node.id, node.group ?? node.id])
	);
}

/** Column of each condensed key by longest path over traffic edges. */
function layerKeys(
	topology: CanvasTopology,
	keyOf: Map<string, string>
): Map<string, number> {
	const preds = new Map<string, Set<string>>();
	for (const node of topology.nodes) {
		const key = keyOf.get(node.id) ?? node.id;
		if (!preds.has(key)) {
			preds.set(key, new Set());
		}
	}
	for (const edge of topology.edges) {
		if (edge.kind !== "traffic") {
			continue;
		}
		const from = keyOf.get(edge.from);
		const to = keyOf.get(edge.to);
		if (from && to && from !== to) {
			preds.get(to)?.add(from);
		}
	}
	const layer = new Map<string, number>();
	const visiting = new Set<string>();
	const visit = (key: string): number => {
		const known = layer.get(key);
		if (known !== undefined) {
			return known;
		}
		if (visiting.has(key)) {
			// A cycle cannot come from the builder; break it rather than recurse.
			return 0;
		}
		visiting.add(key);
		let depth = 0;
		for (const pred of preds.get(key) ?? []) {
			depth = Math.max(depth, visit(pred) + 1);
		}
		visiting.delete(key);
		layer.set(key, depth);
		return depth;
	};
	for (const key of preds.keys()) {
		visit(key);
	}
	return layer;
}

/** Nodes with no traffic edge at all: the infrastructure band. */
function detachedIds(topology: CanvasTopology): Set<string> {
	const linked = new Set<string>();
	for (const edge of topology.edges) {
		if (edge.kind === "traffic") {
			linked.add(edge.from);
			linked.add(edge.to);
		}
	}
	return new Set(
		topology.nodes.filter((node) => !linked.has(node.id)).map((node) => node.id)
	);
}

export function layoutTopology(topology: CanvasTopology): CanvasLayout {
	const keyOf = groupKey(topology);
	const detached = detachedIds(topology);
	const layers = layerKeys(topology, keyOf);

	// Columns keep node order, which the builder emits in traffic order.
	const columns: string[][] = [];
	for (const node of topology.nodes) {
		if (detached.has(node.id)) {
			continue;
		}
		const column = layers.get(keyOf.get(node.id) ?? node.id) ?? 0;
		columns[column] ??= [];
		columns[column].push(node.id);
	}

	const tallest = Math.max(1, ...columns.map((ids) => ids?.length ?? 0));
	const height = (count: number) =>
		count * CANVAS_NODE_HEIGHT + Math.max(0, count - 1) * ROW_GAP;
	const span = height(tallest);
	const layout: CanvasLayout = {};
	columns.forEach((ids, column) => {
		if (!ids) {
			return;
		}
		const top = (span - height(ids.length)) / 2;
		ids.forEach((id, row) => {
			layout[id] = {
				column,
				x: column * (CANVAS_NODE_WIDTH + COLUMN_GAP),
				y: top + row * (CANVAS_NODE_HEIGHT + ROW_GAP),
			};
		});
	});

	const band = topology.nodes.filter((node) => detached.has(node.id));
	band.forEach((node, index) => {
		layout[node.id] = {
			column: -1,
			x: (index + 1) * (CANVAS_NODE_WIDTH + COLUMN_GAP),
			y: span + INFRA_GAP,
		};
	});
	return layout;
}

export interface CanvasPoint {
	x: number;
	y: number;
}

/**
 * Where a link between two placed nodes leaves and enters: bottom to top
 * inside one column, right to left between columns. Pulses travel these
 * same points, so a dot always rides its edge.
 */
export function linkEnds(
	from: CanvasPlacement,
	to: CanvasPlacement
): { source: CanvasPoint; vertical: boolean; target: CanvasPoint } {
	const vertical = from.column === to.column;
	if (vertical) {
		const down = to.y >= from.y;
		return {
			source: {
				x: from.x + CANVAS_NODE_WIDTH / 2,
				y: down ? from.y + CANVAS_NODE_HEIGHT : from.y,
			},
			target: {
				x: to.x + CANVAS_NODE_WIDTH / 2,
				y: down ? to.y : to.y + CANVAS_NODE_HEIGHT,
			},
			vertical,
		};
	}
	return {
		source: {
			x: from.x + CANVAS_NODE_WIDTH,
			y: from.y + CANVAS_NODE_HEIGHT / 2,
		},
		target: { x: to.x, y: to.y + CANVAS_NODE_HEIGHT / 2 },
		vertical,
	};
}

/** An SVG path through every link of a pulse, or null if a node is unplaced. */
export function pulsePath(
	path: readonly string[],
	layout: CanvasLayout
): string | null {
	if (path.length < 2) {
		return null;
	}
	const parts: string[] = [];
	for (let index = 1; index < path.length; index += 1) {
		const from = layout[path[index - 1] ?? ""];
		const to = layout[path[index] ?? ""];
		if (!(from && to)) {
			return null;
		}
		const { source, target } = linkEnds(from, to);
		parts.push(
			`${index === 1 ? "M" : "L"}${source.x},${source.y}`,
			`L${target.x},${target.y}`
		);
	}
	return parts.join(" ");
}
