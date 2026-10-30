import "./SkillRelationsGraph.css";
import { HierarchyIcon, PotionIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { LibraryEmpty, LibraryLoading } from "@ryu/blocks/desktop/library.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { Background, Controls, ReactFlow } from "@xyflow/react";
import { useEffect, useMemo, useState } from "react";
import {
	buildSkillRelationGraph,
	filterSkillRelationGraph,
	type SkillRelationAgent,
	type SkillRelationSkill,
} from "@/src/lib/skill-relations.ts";
import {
	edgeLabel,
	formatScope,
	iconFor,
	layoutNodes,
	NODE_TYPES,
	selectedRelationships,
	toFlowEdges,
} from "./skill-relations/skill-relations-graph-parts.tsx";

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
	const tl = useLiteralMessages();
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
			<div className="flex h-[540px] min-h-[460px] overflow-hidden rounded-2xl border border-border bg-muted/15 max-sm:h-auto max-sm:flex-col max-sm:overflow-x-auto">
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
				<div className="flex w-64 max-w-[40%] shrink-0 flex-col overflow-hidden border-border border-l bg-background/95 max-sm:w-full max-sm:max-w-none max-sm:border-t max-sm:border-l-0">
					{selectedNode ? (
						<div
							className="flex min-h-0 flex-1 flex-col overflow-hidden"
							data-testid="skill-relations-details"
						>
							<div className="border-border border-b px-3 py-3">
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
												{tl("{count} observed", {
													count:
														formatCount(selectedNode.usageCount) ??
														String(selectedNode.usageCount),
												})}
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
