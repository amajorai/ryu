import type { CanvasFlowEdge } from "./edges.tsx";
import { type CanvasLayout, linkEnds } from "./layout.ts";
import type { CanvasTopology } from "./model.ts";
import type { CanvasFlowNode } from "./nodes.tsx";

/** Reading order: columns left to right, then the infrastructure band. */
export function readingOrder(layout: CanvasLayout): string[] {
	return Object.entries(layout)
		.sort(([, a], [, b]) => {
			const columnA = a.column < 0 ? Number.MAX_SAFE_INTEGER : a.column;
			const columnB = b.column < 0 ? Number.MAX_SAFE_INTEGER : b.column;
			return columnA - columnB || a.y - b.y || a.x - b.x;
		})
		.map(([id]) => id);
}

export function buildNodes(
	topology: CanvasTopology,
	layout: CanvasLayout
): CanvasFlowNode[] {
	return topology.nodes.map((node) => ({
		data: { node },
		draggable: false,
		id: node.id,
		position: { x: layout[node.id]?.x ?? 0, y: layout[node.id]?.y ?? 0 },
		selectable: false,
		type: "gateway-canvas",
	}));
}

export function buildEdges(
	topology: CanvasTopology,
	layout: CanvasLayout
): CanvasFlowEdge[] {
	const edges: CanvasFlowEdge[] = [];
	for (const edge of topology.edges) {
		const from = layout[edge.from];
		const to = layout[edge.to];
		if (!(from && to)) {
			continue;
		}
		const { source, target } = linkEnds(from, to);
		edges.push({
			data: {
				d: `M${source.x},${source.y} L${target.x},${target.y}`,
				kind: edge.kind,
			},
			focusable: false,
			id: edge.id,
			selectable: false,
			source: edge.from,
			target: edge.to,
			type: "gateway-canvas",
		});
	}
	return edges;
}
