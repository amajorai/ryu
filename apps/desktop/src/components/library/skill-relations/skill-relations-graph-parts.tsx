import {
	PotionIcon,
	Target01Icon,
	Wrench01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import {
	type Edge,
	Handle,
	MarkerType,
	type Node,
	type NodeProps,
	type NodeTypes,
	Position,
} from "@xyflow/react";
import type { CSSProperties } from "react";
import { layoutForceGraph } from "@/src/lib/force-directed-graph.ts";
import type {
	SkillRelationEdge,
	SkillRelationGraph,
	SkillRelationNode,
} from "@/src/lib/skill-relations.ts";

// The skill-relations graph's node renderer, layout and edge/label helpers.

export const HANDLE_CLASS =
	"!size-1.5 !min-w-0 !min-h-0 !border-0 !bg-foreground/20";

export function flowRelationData(
	node: SkillRelationNode,
	dimmed?: boolean,
	onSelect?: () => void
) {
	return { ...node, dimmed, onSelect };
}
export type FlowRelationData = ReturnType<typeof flowRelationData>;
export type FlowRelationNode = Node<FlowRelationData, "relation">;

export function iconFor(kind: SkillRelationNode["kind"]) {
	if (kind === "agent") {
		return Target01Icon;
	}
	if (kind === "skill") {
		return PotionIcon;
	}
	return Wrench01Icon;
}

export function relationNodeClass(node: SkillRelationNode): string {
	if (node.kind === "agent") {
		return "border-primary/40 bg-primary/10";
	}
	if (node.kind === "tool") {
		return "border-border bg-muted/60";
	}
	return node.enabled
		? "border-chart-2/50 bg-chart-2/10"
		: "border-border bg-muted opacity-75";
}

export function nodeSize(node: SkillRelationNode): number {
	if (node.kind === "tool") {
		return 94;
	}
	if (node.kind === "agent") {
		return 96;
	}
	const usage = node.usageCount ?? 0;
	return Math.min(132, 92 + Math.round(Math.log10(usage + 1) * 14));
}

export function RelationNode({ data, selected }: NodeProps<FlowRelationNode>) {
	const usage =
		data.usageCount === undefined
			? null
			: (formatCount(data.usageCount) ?? String(data.usageCount));
	const relationNodeVariables1: CSSProperties & {
		"--skill-relation-size": string;
	} = { "--skill-relation-size": `${nodeSize(data)}px` };
	return (
		<div
			aria-label={`${data.kind}: ${data.label}`}
			className={`relative flex shrink-0 flex-col items-center justify-center rounded-full border px-2 py-2 text-center transition-[opacity,filter] ${relationNodeClass(data)} ${data.dimmed ? "opacity-20 grayscale" : ""} ${selected ? "ring-2 ring-ring ring-offset-2 ring-offset-background" : ""}`}
			data-skill-relation-size=""
			data-testid={`skill-relation-node-${data.kind}`}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					data.onSelect?.();
				}
			}}
			role="button"
			style={relationNodeVariables1}
			tabIndex={0}
		>
			<Handle className={HANDLE_CLASS} position={Position.Left} type="target" />
			<HugeiconsIcon
				className="size-4 shrink-0 text-muted-foreground"
				icon={iconFor(data.kind)}
			/>
			<div className="mt-1 min-w-0 max-w-full">
				<div className="line-clamp-2 break-words font-medium text-xs leading-tight">
					{data.label}
				</div>
				<div className="mt-1 truncate text-muted-foreground text-xs">
					{data.kind === "agent"
						? data.scope === "all-enabled"
							? "All enabled skills"
							: data.scope === "none"
								? "No skills"
								: "Skill allowlist"
						: data.kind === "skill"
							? data.enabled
								? "Installed · enabled"
								: "Installed · disabled"
							: "Declared tool"}
				</div>
			</div>
			{usage === null ? null : (
				<Badge
					className="absolute right-[-4px] bottom-[-2px] shrink-0"
					typography="code-micro"
					variant="secondary"
				>
					{usage}
				</Badge>
			)}
			<Handle
				className={HANDLE_CLASS}
				position={Position.Right}
				type="source"
			/>
		</div>
	);
}

export const NODE_TYPES = { relation: RelationNode } satisfies NodeTypes;

export function layoutNodes(
	nodes: readonly SkillRelationNode[],
	edges: readonly SkillRelationEdge[]
): FlowRelationNode[] {
	const positions = layoutForceGraph(nodes, edges);
	return nodes.map((node) => ({
		data: flowRelationData(node),
		draggable: false,
		id: node.id,
		position: positions.get(node.id) ?? { x: 0, y: 0 },
		type: "relation",
	}));
}

export function toFlowEdges(
	edges: readonly SkillRelationEdge[],
	hoveredId: string | null
): Edge[] {
	return edges.map((edge) => ({
		id: edge.id,
		markerEnd: { type: MarkerType.ArrowClosed },
		source: edge.source,
		style: {
			stroke:
				edge.kind === "skill-tool"
					? "var(--muted-foreground)"
					: "var(--primary)",
			strokeDasharray: edge.kind === "skill-tool" ? "5 4" : undefined,
			strokeWidth:
				hoveredId && (edge.source === hoveredId || edge.target === hoveredId)
					? 2.8
					: edge.kind === "skill-tool"
						? 1.2
						: 1.8,
			opacity:
				hoveredId && edge.source !== hoveredId && edge.target !== hoveredId
					? 0.12
					: 1,
		},
		target: edge.target,
		type: "straight",
	}));
}

export function formatScope(node: SkillRelationNode): string | null {
	if (node.kind !== "agent") {
		return null;
	}
	if (node.scopeUnavailable) {
		return "Scope unavailable; showing the all-enabled default.";
	}
	if (node.scope === "all-enabled") {
		return "Can use every enabled skill on this node.";
	}
	if (node.scope === "none") {
		return "Explicitly configured with no skills.";
	}
	return "Can use the skills in its allowlist that are enabled on this node.";
}

export function edgeLabel(edge: SkillRelationEdge): string {
	return edge.kind === "agent-skill" ? "Agent access" : "Declared tool";
}

export function selectedRelationships(
	node: SkillRelationNode,
	graph: SkillRelationGraph
): { edge: SkillRelationEdge; other: SkillRelationNode }[] {
	const byId = new Map(
		graph.nodes.map((candidate) => [candidate.id, candidate])
	);
	return graph.edges.flatMap((edge) => {
		if (edge.source !== node.id && edge.target !== node.id) {
			return [];
		}
		const otherId = edge.source === node.id ? edge.target : edge.source;
		const other = byId.get(otherId);
		return other ? [{ edge, other }] : [];
	});
}
