// apps/desktop/src/components/store/StoreDetailGraph.tsx
//
// A READ-ONLY React Flow canvas that draws the graph a Store tab declares through
// `spec.detail.graph` (see `StoreDetailGraphSpec`). It began life as the workflow
// template preview and is now the generic primitive behind it: any app whose
// catalog rows have a shape — a workflow, a pipeline, a routing table — declares
// the graph in its manifest instead of the shell allowlisting a component for it.
//
// Rows carry nodes + edges but NO positions (position is a UI concern), so we
// auto-lay them out left-to-right by longest-path depth — a DAG reads best that
// way. Interaction is fully disabled (no drag/connect/zoom/select): this is a
// picture, not an editor. React Flow's base CSS is imported globally in index.css.

import type { StoreGraphEdge, StoreGraphNode } from "@ryu/app-host/views";
import {
	Background,
	type Edge,
	MarkerType,
	type Node,
	ReactFlow,
} from "@xyflow/react";
import { useMemo } from "react";

const LAYER_X = 200;
const ROW_Y = 74;
const NODE_WIDTH = 150;

/** Longest-path layering: x = depth (edge distance from a root), y = order within
 *  the layer. Nodes in a cycle (durable `while` bodies) that never resolve keep
 *  depth 0 and cluster at the left — acceptable for a small preview. */
function layoutNodes(nodes: StoreGraphNode[], edges: StoreGraphEdge[]): Node[] {
	const remaining = new Map<string, number>();
	for (const n of nodes) {
		remaining.set(n.id, 0);
	}
	for (const e of edges) {
		remaining.set(e.target, (remaining.get(e.target) ?? 0) + 1);
	}

	const adjacency = new Map<string, string[]>();
	for (const e of edges) {
		const list = adjacency.get(e.source) ?? [];
		list.push(e.target);
		adjacency.set(e.source, list);
	}

	const depth = new Map<string, number>();
	const queue: string[] = [];
	for (const n of nodes) {
		if ((remaining.get(n.id) ?? 0) === 0) {
			depth.set(n.id, 0);
			queue.push(n.id);
		}
	}

	let head = 0;
	while (head < queue.length) {
		const id = queue[head];
		head += 1;
		const d = depth.get(id) ?? 0;
		for (const to of adjacency.get(id) ?? []) {
			depth.set(to, Math.max(depth.get(to) ?? 0, d + 1));
			remaining.set(to, (remaining.get(to) ?? 1) - 1);
			if ((remaining.get(to) ?? 0) === 0) {
				queue.push(to);
			}
		}
	}

	const rowsPerLayer = new Map<number, number>();
	return nodes.map((n) => {
		const d = depth.get(n.id) ?? 0;
		const row = rowsPerLayer.get(d) ?? 0;
		rowsPerLayer.set(d, row + 1);
		return {
			id: n.id,
			position: { x: d * LAYER_X, y: row * ROW_Y },
			data: { label: n.label },
			style: {
				width: NODE_WIDTH,
				padding: "6px 10px",
				borderRadius: 10,
				border: "1px solid var(--border)",
				background: "var(--card)",
				color: "var(--foreground)",
				fontSize: 11,
			},
		} satisfies Node;
	});
}

function toFlowEdges(edges: StoreGraphEdge[]): Edge[] {
	return edges.map((e, i) => ({
		id: `e-${e.source}-${e.target}-${i}`,
		source: e.source,
		target: e.target,
		label: e.label,
		type: "smoothstep",
		markerEnd: { type: MarkerType.ArrowClosed },
		style: { stroke: "var(--muted-foreground)" },
	}));
}

export default function StoreDetailGraph({
	nodes,
	edges,
}: {
	edges: StoreGraphEdge[];
	nodes: StoreGraphNode[];
}) {
	const flowNodes = useMemo(() => layoutNodes(nodes, edges), [nodes, edges]);
	const flowEdges = useMemo(() => toFlowEdges(edges), [edges]);

	if (nodes.length === 0) {
		return null;
	}

	return (
		<div className="h-56 w-full overflow-hidden rounded-xl border border-border bg-muted/20">
			<ReactFlow
				edges={flowEdges}
				edgesFocusable={false}
				elementsSelectable={false}
				fitView
				fitViewOptions={{ padding: 0.18 }}
				nodes={flowNodes}
				nodesConnectable={false}
				nodesDraggable={false}
				nodesFocusable={false}
				panOnDrag={false}
				panOnScroll={false}
				preventScrolling={false}
				proOptions={{ hideAttribution: true }}
				zoomOnDoubleClick={false}
				zoomOnPinch={false}
				zoomOnScroll={false}
			>
				<Background gap={16} />
			</ReactFlow>
		</div>
	);
}
