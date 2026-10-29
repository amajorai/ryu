import type { CSSProperties } from "react";
import "./SkillRelationsGraph.css";
import {
	HierarchyIcon,
	PotionIcon,
	Target01Icon,
	Wrench01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { LibraryEmpty, LibraryLoading } from "@ryu/blocks/desktop/library.tsx";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import {
	Background,
	Controls,
	type Edge,
	Handle,
	MarkerType,
	type Node,
	type NodeProps,
	type NodeTypes,
	Position,
	ReactFlow,
} from "@xyflow/react";
import { useEffect, useMemo, useState } from "react";
import { layoutForceGraph } from "@/src/lib/force-directed-graph.ts";
import {
	buildSkillRelationGraph,
	filterSkillRelationGraph,
	type SkillRelationAgent,
	type SkillRelationEdge,
	type SkillRelationGraph,
	type SkillRelationNode,
	type SkillRelationSkill,
} from "@/src/lib/skill-relations.ts";

const HANDLE_CLASS = "!size-1.5 !min-w-0 !min-h-0 !border-0 !bg-foreground/20";

function flowRelationData(
	node: SkillRelationNode,
	dimmed?: boolean,
	onSelect?: () => void
) {
	return { ...node, dimmed, onSelect };
}
type FlowRelationData = ReturnType<typeof flowRelationData>;
type FlowRelationNode = Node<FlowRelationData, "relation">;

function iconFor(kind: SkillRelationNode["kind"]) {
	if (kind === "agent") {
		return Target01Icon;
	}
	if (kind === "skill") {
		return PotionIcon;
	}
	return Wrench01Icon;
}

function relationNodeClass(node: SkillRelationNode): string {
	if (node.kind === "agent") {
		return "border-primary/40 bg-primary/10";
	}
	if (node.kind === "tool") {
		return "border-border/70 bg-muted/60";
	}
	return node.enabled
		? "border-chart-2/50 bg-chart-2/10"
		: "border-dashed border-muted-foreground/40 bg-muted/55 opacity-75";
}

function nodeSize(node: SkillRelationNode): number {
	if (node.kind === "tool") {
		return 94;
	}
	if (node.kind === "agent") {
		return 96;
	}
	const usage = node.usageCount ?? 0;
	return Math.min(132, 92 + Math.round(Math.log10(usage + 1) * 14));
}

function RelationNode({ data, selected }: NodeProps<FlowRelationNode>) {
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
			className={`relative flex shrink-0 flex-col items-center justify-center rounded-full border px-2.5 py-2 text-center shadow-sm transition-[opacity,filter,box-shadow] ${relationNodeClass(data)} ${data.dimmed ? "opacity-20 grayscale" : ""} ${selected ? "ring-2 ring-ring ring-offset-2 ring-offset-background" : ""}`}
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
				<div className="type-compact line-clamp-2 break-words font-medium leading-tight">
					{data.label}
				</div>
				<div className="type-micro mt-1 truncate text-muted-foreground">
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

const NODE_TYPES = { relation: RelationNode } satisfies NodeTypes;

function layoutNodes(
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

function toFlowEdges(
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

function formatScope(node: SkillRelationNode): string | null {
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

function edgeLabel(edge: SkillRelationEdge): string {
	return edge.kind === "agent-skill" ? "Agent access" : "Declared tool";
}

function selectedRelationships(
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

export interface SkillRelationsGraphProps {
	agents: readonly SkillRelationAgent[];
	error?: boolean;
	loading?: boolean;
	onOpenCatalog: () => void;
	onRetry?: () => void;
	query?: string;
	skills: readonly SkillRelationSkill[];
	usage: ReadonlyMap<string, number>;
	usageAvailable: boolean;
}

/** Read-only, grouped React Flow view of the active node's skill relationships. */
export default function SkillRelationsGraph({
	agents,
	error = false,
	loading = false,
	onOpenCatalog,
	onRetry,
	query = "",
	skills,
	usage,
	usageAvailable,
}: SkillRelationsGraphProps) {
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [hoveredId, setHoveredId] = useState<string | null>(null);
	const graph = useMemo(
		() => buildSkillRelationGraph({ agents, skills, usage }),
		[agents, skills, usage]
	);
	const visibleGraph = useMemo(
		() => filterSkillRelationGraph(graph, query),
		[graph, query]
	);
	const connectedIds = useMemo(() => {
		if (!hoveredId) {
			return null;
		}
		const ids = new Set([hoveredId]);
		for (const edge of visibleGraph.edges) {
			if (edge.source === hoveredId || edge.target === hoveredId) {
				ids.add(edge.source);
				ids.add(edge.target);
			}
		}
		return ids;
	}, [hoveredId, visibleGraph.edges]);
	const flowNodes = useMemo(
		() =>
			layoutNodes(visibleGraph.nodes, visibleGraph.edges).map((node) => ({
				...node,
				data: {
					...node.data,
					dimmed: connectedIds !== null && !connectedIds.has(node.id),
					onSelect: () => setSelectedId(node.id),
				},
			})),
		[connectedIds, visibleGraph.edges, visibleGraph.nodes]
	);
	const flowEdges = useMemo(
		() => toFlowEdges(visibleGraph.edges, hoveredId),
		[hoveredId, visibleGraph.edges]
	);
	const selectedNode = visibleGraph.nodes.find(
		(node) => node.id === selectedId
	);

	useEffect(() => {
		if (selectedId && !selectedNode) {
			setSelectedId(null);
		}
	}, [selectedId, selectedNode]);

	if (loading) {
		return <LibraryLoading />;
	}

	if (error) {
		return (
			<LibraryEmpty
				action={
					onRetry ? (
						<Button onClick={onRetry} size="sm" variant="outline">
							Retry
						</Button>
					) : null
				}
				description="Check the active node and try again."
				icon={HierarchyIcon}
				title="Couldn't load skill relations"
			/>
		);
	}

	if (skills.length === 0) {
		return (
			<LibraryEmpty
				action={
					<Button onClick={onOpenCatalog} size="sm">
						Browse skills
					</Button>
				}
				description="Install a skill to see which agents can use it and which tools it declares."
				icon={PotionIcon}
				title="No skills installed"
			/>
		);
	}

	if (visibleGraph.nodes.length === 0) {
		return (
			<LibraryEmpty
				description="Nothing matches your search."
				icon={HierarchyIcon}
				title="No results"
			/>
		);
	}

	const relationships = selectedNode
		? selectedRelationships(selectedNode, visibleGraph)
		: [];

	return (
		<div
			className="flex min-h-0 flex-col gap-3"
			data-testid="skill-relations-graph"
		>
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<h2 className="font-medium text-sm">Skill relations</h2>
					<p className="mt-1 max-w-2xl text-muted-foreground text-xs">
						See which agents can use each skill, what tools those skills
						declare, and which skills show up in your observed usage.
					</p>
				</div>
				<div
					className="flex flex-wrap items-center gap-3 text-muted-foreground text-xs"
					data-testid="skill-relations-legend"
				>
					<span className="inline-flex items-center gap-1.5">
						<span className="size-2 rounded-full bg-primary" />
						Agents
					</span>
					<span className="inline-flex items-center gap-1.5">
						<span className="size-2 rounded-full bg-chart-2" />
						Skills
					</span>
					<span className="inline-flex items-center gap-1.5">
						<span className="size-2 rounded-full bg-muted-foreground" />
						Tools
					</span>
					<span className="inline-flex items-center gap-1.5">
						<span className="h-px w-5 bg-primary" />
						Agent access
					</span>
					<span className="inline-flex items-center gap-1.5">
						<span className="w-5 border-muted-foreground border-t border-dashed" />
						Declared tool
					</span>
				</div>
			</div>
			<div
				className="flex items-center gap-2 text-muted-foreground text-xs"
				data-testid="skill-relations-usage-note"
			>
				<HugeiconsIcon className="size-3.5" icon={HierarchyIcon} />
				{usageAvailable
					? "Your observed usage is shown as a count on matching skill nodes."
					: "Observed usage unavailable; configuration relationships are still shown."}
			</div>
			<div className="flex h-[540px] min-h-[460px] overflow-hidden rounded-2xl border border-border/60 bg-muted/15 max-sm:h-auto max-sm:flex-col max-sm:overflow-x-auto">
				<div className="relative min-w-0 flex-1 max-sm:h-[460px] max-sm:min-h-[460px] max-sm:min-w-[700px]">
					<ReactFlow
						className="!bg-transparent"
						edges={flowEdges}
						edgesFocusable={false}
						elementsSelectable
						fitView
						fitViewOptions={{ padding: 0.16 }}
						maxZoom={1.35}
						minZoom={0.35}
						nodes={flowNodes}
						nodesConnectable={false}
						nodesDraggable={false}
						nodeTypes={NODE_TYPES}
						onNodeClick={(_event, node) => setSelectedId(node.id)}
						onNodeMouseEnter={(_event, node) => setHoveredId(node.id)}
						onNodeMouseLeave={() => setHoveredId(null)}
						onPaneClick={() => setSelectedId(null)}
						proOptions={{ hideAttribution: true }}
						zoomOnDoubleClick={false}
					>
						<Background color="var(--border)" gap={22} size={1} />
						<Controls showInteractive={false} />
					</ReactFlow>
				</div>
				<div className="flex w-64 max-w-[40%] shrink-0 flex-col overflow-hidden border-border/70 border-l bg-background/95 max-sm:w-full max-sm:max-w-none max-sm:border-t max-sm:border-l-0">
					{selectedNode ? (
						<div
							className="flex min-h-0 flex-1 flex-col overflow-hidden"
							data-testid="skill-relations-details"
						>
							<div className="border-border/60 border-b px-3 py-3">
								<div className="flex items-start gap-2">
									<HugeiconsIcon
										className="mt-0.5 size-4 shrink-0 text-muted-foreground"
										icon={iconFor(selectedNode.kind)}
									/>
									<div className="min-w-0">
										<p
											className="truncate font-medium text-sm"
											title={selectedNode.label}
										>
											{selectedNode.label}
										</p>
										<p className="text-muted-foreground text-xs capitalize">
											{selectedNode.kind}
										</p>
									</div>
								</div>
							</div>
							<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
								{selectedNode.description ? (
									<p className="text-muted-foreground text-xs leading-relaxed">
										{selectedNode.description}
									</p>
								) : null}
								{formatScope(selectedNode) ? (
									<p className="text-muted-foreground text-xs leading-relaxed">
										{formatScope(selectedNode)}
									</p>
								) : null}
								{selectedNode.kind === "skill" ? (
									<div className="flex flex-wrap gap-1.5">
										<Badge
											variant={selectedNode.enabled ? "secondary" : "outline"}
										>
											{selectedNode.enabled ? "Enabled" : "Disabled"}
										</Badge>
										{selectedNode.usageCount === undefined ? null : (
											<Badge variant="outline">
												{formatCount(selectedNode.usageCount) ??
													selectedNode.usageCount}{" "}
												observed
											</Badge>
										)}
									</div>
								) : null}
								{relationships.length > 0 ? (
									<div className="space-y-2">
										<p className="font-medium text-xs">Direct relationships</p>
										<ul className="space-y-1.5">
											{relationships.map(({ edge, other }) => (
												<li
													className="flex items-center justify-between gap-2 text-xs"
													key={edge.id}
												>
													<span className="truncate" title={other.label}>
														{other.label}
													</span>
													<span className="shrink-0 text-muted-foreground">
														{edgeLabel(edge)}
													</span>
												</li>
											))}
										</ul>
									</div>
								) : (
									<p className="text-muted-foreground text-xs">
										No direct relationships.
									</p>
								)}
							</div>
						</div>
					) : (
						<div className="flex flex-1 items-center justify-center p-6 text-center text-muted-foreground text-xs">
							Select a node to inspect its direct relationships.
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
