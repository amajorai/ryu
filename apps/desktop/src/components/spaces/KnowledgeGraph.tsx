import {
	Background,
	Controls,
	type Edge,
	type Node,
	ReactFlow,
} from "@xyflow/react";
import { useMemo } from "react";
import type { DocGraph } from "@/src/lib/api/spaces.ts";
import { layoutForceGraph } from "@/src/lib/force-directed-graph.ts";

const EDGE_COLOR = new Map<string, string>([
	["wiki", "var(--primary)"],
	["mention", "#3b82f6"],
	["parent", "var(--muted-foreground)"],
]);

function nodeStyle(kind: string, pending: boolean): React.CSSProperties {
	if (pending) {
		return {
			background: "var(--muted)",
			border: "1px dashed var(--muted-foreground)",
			color: "var(--muted-foreground)",
			borderRadius: 8,
			fontSize: 12,
			padding: "6px 10px",
		};
	}
	const isDatabase = kind === "database";
	return {
		background: isDatabase ? "var(--accent)" : "var(--card)",
		border: "1px solid var(--border)",
		color: "var(--foreground)",
		borderRadius: 8,
		fontSize: 12,
		fontWeight: 500,
		padding: "6px 10px",
	};
}

/**
 * Renders a document-link graph (per-space or global) with React Flow. Nodes are
 * documents plus pending link targets; edges are wiki/mention/parent links.
 * Clicking a node calls `onOpenNode`.
 */
export function KnowledgeGraph({
	graph,
	onOpenNode,
}: {
	graph: DocGraph;
	onOpenNode: (node: DocGraph["nodes"][number]) => void;
}) {
	const positions = useMemo(
		() =>
			layoutForceGraph(
				graph.nodes,
				graph.edges.map((edge) => ({ source: edge.src, target: edge.dst }))
			),
		[graph]
	);

	const nodes: Node[] = useMemo(
		() =>
			graph.nodes.map((node) => {
				const point = positions.get(node.id) ?? { x: 0, y: 0 };
				return {
					id: node.id,
					position: { x: point.x, y: point.y },
					data: { label: node.title || "Untitled" },
					style: nodeStyle(node.kind, node.pending),
				} satisfies Node;
			}),
		[graph.nodes, positions]
	);

	const edges: Edge[] = useMemo(
		() =>
			graph.edges.map((edge, i) => ({
				id: `e${i}:${edge.src}:${edge.dst}`,
				source: edge.src,
				target: edge.dst,
				animated: false,
				style: {
					stroke: EDGE_COLOR.get(edge.kind) ?? "var(--border)",
					strokeDasharray: edge.kind === "parent" ? "4 4" : undefined,
				},
			})),
		[graph.edges]
	);

	const byId = useMemo(
		() => new Map(graph.nodes.map((n) => [n.id, n])),
		[graph.nodes]
	);

	if (graph.nodes.length === 0) {
		return (
			<div className="flex h-full items-center justify-center text-muted-foreground text-sm">
				No pages yet. Create pages and link them with [[wiki links]] to grow the
				graph.
			</div>
		);
	}

	return (
		<div className="h-full w-full">
			<ReactFlow
				edges={edges}
				fitView
				nodes={nodes}
				onNodeClick={(_event, node) => {
					const domain = byId.get(node.id);
					if (domain) {
						onOpenNode(domain);
					}
				}}
				proOptions={{ hideAttribution: true }}
			>
				<Background />
				<Controls showInteractive={false} />
			</ReactFlow>
		</div>
	);
}
