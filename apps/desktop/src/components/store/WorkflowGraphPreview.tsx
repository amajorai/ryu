// apps/desktop/src/components/store/WorkflowGraphPreview.tsx
//
// A READ-ONLY React Flow canvas that previews a workflow template's graph in the
// Store detail pane. Templates carry nodes + edges but NO positions (position is a
// UI concern), so we auto-lay them out left-to-right by longest-path depth — a DAG
// reads best that way. Interaction is fully disabled (no drag/connect/zoom/select):
// this is a picture of the workflow, not the editor (that lives in the sandboxed
// com.ryu.workflows companion). React Flow's base CSS is already imported globally
// in index.css.

import {
	Background,
	type Edge,
	MarkerType,
	type Node,
	ReactFlow,
} from "@xyflow/react";
import { useMemo } from "react";
import type { WorkflowEdge, WorkflowNode } from "@/src/lib/api/workflows.ts";

const LAYER_X = 200;
const ROW_Y = 74;
const NODE_WIDTH = 150;

/** Longest-path layering: x = depth (edge distance from a root), y = order within
 *  the layer. Nodes in a cycle (durable `while` bodies) that never resolve keep
 *  depth 0 and cluster at the left — acceptable for a small preview. */
function layoutNodes(nodes: WorkflowNode[], edges: WorkflowEdge[]): Node[] {
	const remaining = new Map<string, number>();
	for (const n of nodes) {
		remaining.set(n.id, 0);
	}
	for (const e of edges) {
		remaining.set(e.to, (remaining.get(e.to) ?? 0) + 1);
	}

	const adjacency = new Map<string, string[]>();
	for (const e of edges) {
		const list = adjacency.get(e.from) ?? [];
		list.push(e.to);
		adjacency.set(e.from, list);
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
			data: { label: n.id },
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

function toFlowEdges(edges: WorkflowEdge[]): Edge[] {
	return edges.map((e, i) => ({
		id: `e-${e.from}-${e.to}-${i}`,
		source: e.from,
		target: e.to,
		label: e.branch ?? undefined,
		type: "smoothstep",
		markerEnd: { type: MarkerType.ArrowClosed },
		style: { stroke: "var(--muted-foreground)" },
	}));
}

export default function WorkflowGraphPreview({
	nodes,
	edges,
}: {
	nodes: WorkflowNode[];
	edges: WorkflowEdge[];
}) {
	const flowNodes = useMemo(() => layoutNodes(nodes, edges), [nodes, edges]);
	const flowEdges = useMemo(() => toFlowEdges(edges), [edges]);

	if (nodes.length === 0) {
		return null;
	}

	return (
		<div className="h-56 w-full overflow-hidden rounded-xl border border-border/60 bg-muted/20">
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
