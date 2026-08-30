import { Badge } from "@ryu/ui/components/badge";
import {
	Background,
	Controls,
	type Edge,
	type Node,
	ReactFlow,
} from "@xyflow/react";
import type { MemoryGraphSnapshot } from "@/src/lib/api/memory.ts";
import { layoutForceGraph } from "@/src/lib/force-directed-graph.ts";

const NODE_COLORS: Record<string, string> = {
	memory: "var(--card)",
	topic: "color-mix(in srgb, var(--primary) 14%, var(--card))",
	person: "color-mix(in srgb, #3b82f6 14%, var(--card))",
	category: "color-mix(in srgb, #8b5cf6 14%, var(--card))",
	scope: "color-mix(in srgb, #0d9488 14%, var(--card))",
	agent: "color-mix(in srgb, #d97706 14%, var(--card))",
};

const EDGE_COLORS: Record<string, string> = {
	has_topic: "var(--primary)",
	mentions_person: "#3b82f6",
	has_category: "#8b5cf6",
	applies_to_scope: "#0d9488",
	authored_by_agent: "#d97706",
};

const GRAPH_HALF_EXTENT = 360;

function nodeStyle(
	node: MemoryGraphSnapshot["nodes"][number]
): React.CSSProperties {
	return {
		background: NODE_COLORS[node.kind] ?? "var(--card)",
		border: node.sensitive
			? "1px solid color-mix(in srgb, var(--destructive) 65%, var(--border))"
			: "1px solid var(--border)",
		borderRadius: node.kind === "memory" ? 10 : 999,
		color: "var(--foreground)",
		fontSize: 12,
		fontWeight: node.kind === "memory" ? 500 : 600,
		maxWidth: node.kind === "memory" ? 220 : 180,
		padding: "7px 10px",
		whiteSpace: "normal",
	};
}

/**
 * Renders the access-filtered typed memory graph. This is a projection view:
 * Core has already applied caller, scope, agent, and sensitive-topic policy.
 */
export function MemoryGraph({ graph }: { graph: MemoryGraphSnapshot }) {
	const positions = layoutForceGraph(
		graph.nodes,
		graph.edges.map((edge) => ({ source: edge.source, target: edge.target }))
	);
	const extent = Math.max(
		1,
		...graph.nodes.map((node) => {
			const point = positions.get(node.id) ?? { x: 0, y: 0 };
			return Math.max(Math.abs(point.x), Math.abs(point.y));
		})
	);
	const positionScale = Math.min(1, GRAPH_HALF_EXTENT / extent);
	const nodes: Node[] = graph.nodes.map((node) => {
		const point = positions.get(node.id) ?? { x: 0, y: 0 };
		return {
			id: node.id,
			position: {
				x: point.x * positionScale,
				y: point.y * positionScale,
			},
			data: { label: node.label },
			style: nodeStyle(node),
			draggable: false,
			selectable: false,
		} satisfies Node;
	});
	const edges: Edge[] = graph.edges.map((edge, index) => ({
		id: `memory-edge-${index}:${edge.source}:${edge.target}`,
		source: edge.source,
		target: edge.target,
		style: {
			stroke: EDGE_COLORS[edge.kind] ?? "var(--border)",
			strokeWidth: Math.max(1, Math.min(2.5, edge.weight)),
		},
	}));

	if (graph.nodes.length === 0) {
		return (
			<div className="flex h-full items-center justify-center text-muted-foreground text-sm">
				No graphable memories are visible for this node and consent setting.
			</div>
		);
	}

	return (
		<div className="relative h-full w-full">
			<div className="pointer-events-none absolute top-3 left-3 z-10 flex flex-wrap gap-1.5 rounded-lg border bg-background/90 p-2 shadow-sm backdrop-blur">
				<Badge variant="secondary">{graph.memoryCount} memories</Badge>
				<Badge variant="outline">Topics</Badge>
				<Badge variant="outline">People</Badge>
				<Badge variant="outline">Categories</Badge>
				<Badge variant="outline">Scopes</Badge>
				<Badge variant="outline">Agents</Badge>
				{graph.truncated ? (
					<Badge variant="destructive">Graph capped</Badge>
				) : null}
			</div>
			<ReactFlow
				edges={edges}
				fitView
				fitViewOptions={{ padding: 0.16 }}
				minZoom={0.1}
				nodes={nodes}
				proOptions={{ hideAttribution: true }}
			>
				<Background />
				<Controls showInteractive={false} />
			</ReactFlow>
		</div>
	);
}
