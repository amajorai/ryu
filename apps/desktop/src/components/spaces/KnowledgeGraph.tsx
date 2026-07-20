import {
	Background,
	Controls,
	type Edge,
	type Node,
	ReactFlow,
} from "@xyflow/react";
import { useMemo } from "react";
import type { DocGraph } from "@/src/lib/api/spaces.ts";

interface Point {
	x: number;
	y: number;
}

// A tiny deterministic force-directed layout (Fruchterman–Reingold). Kept in the
// component (no extra dependency) — the graphs are modest and this reads far
// better than a circle. Deterministic: seeded from node index, no randomness.
const IDEAL_DISTANCE = 130;
const SEED_RADIUS = 320;

function layoutGraph(graph: DocGraph): Map<string, Point> {
	const nodes = graph.nodes;
	const count = nodes.length;
	const positions: Point[] = nodes.map((_, i) => {
		const angle = (2 * Math.PI * i) / Math.max(1, count);
		return {
			x: Math.cos(angle) * SEED_RADIUS,
			y: Math.sin(angle) * SEED_RADIUS,
		};
	});
	const indexOf = new Map(nodes.map((node, i) => [node.id, i]));
	const links = graph.edges
		.map((e) => [indexOf.get(e.src), indexOf.get(e.dst)] as const)
		.filter((pair): pair is [number, number] =>
			pair.every((v) => v !== undefined)
		);

	// Cap total work so a large graph never blocks the UI thread for long.
	const iterations = Math.max(
		60,
		Math.min(300, Math.round(20_000 / (count + 1)))
	);
	const k = IDEAL_DISTANCE;

	for (let iter = 0; iter < iterations; iter += 1) {
		const disp: Point[] = positions.map(() => ({ x: 0, y: 0 }));
		// Repulsion between every pair.
		for (let i = 0; i < count; i += 1) {
			for (let j = i + 1; j < count; j += 1) {
				const dx = positions[i].x - positions[j].x;
				const dy = positions[i].y - positions[j].y;
				const dist = Math.hypot(dx, dy) || 0.01;
				const force = (k * k) / dist;
				const ux = dx / dist;
				const uy = dy / dist;
				disp[i].x += ux * force;
				disp[i].y += uy * force;
				disp[j].x -= ux * force;
				disp[j].y -= uy * force;
			}
		}
		// Attraction along edges.
		for (const [a, b] of links) {
			const dx = positions[a].x - positions[b].x;
			const dy = positions[a].y - positions[b].y;
			const dist = Math.hypot(dx, dy) || 0.01;
			const force = (dist * dist) / k;
			const ux = dx / dist;
			const uy = dy / dist;
			disp[a].x -= ux * force;
			disp[a].y -= uy * force;
			disp[b].x += ux * force;
			disp[b].y += uy * force;
		}
		// Apply, cooling over time.
		const temp = 12 * (1 - iter / iterations);
		for (let i = 0; i < count; i += 1) {
			const d = Math.hypot(disp[i].x, disp[i].y) || 0.01;
			positions[i].x += (disp[i].x / d) * Math.min(d, temp);
			positions[i].y += (disp[i].y / d) * Math.min(d, temp);
		}
	}

	return new Map(nodes.map((node, i) => [node.id, positions[i]]));
}

const EDGE_COLOR: Record<string, string> = {
	wiki: "var(--primary)",
	mention: "#3b82f6",
	parent: "var(--muted-foreground)",
};

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
	const positions = useMemo(() => layoutGraph(graph), [graph]);

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
					stroke: EDGE_COLOR[edge.kind] ?? "var(--border)",
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
