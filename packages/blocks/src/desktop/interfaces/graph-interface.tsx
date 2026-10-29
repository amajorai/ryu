import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import {
	type GraphEdge,
	type GraphNode,
	type InterfaceAgent,
	type InterfaceParamsByRenderer,
	type InterfaceSnapshot,
	projectGraph,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { SquarePen } from "lucide-react";
import {
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { GraphCanvas, usePrefersReducedMotion } from "./graph-canvas.tsx";
import {
	GRAPH_NODE_SIZE,
	type GraphEmphasis,
	graphSummary,
	groupForNode,
	linkedAgentIds,
	neighborhood,
	settleGroups,
	threadNodeIds,
	threadsForNode,
} from "./graph-model.ts";
import type {
	GraphFlowEdge,
	GraphFlowNode,
	GraphMapContextValue,
} from "./graph-nodes.tsx";
import { GraphNodePanel, GraphThreadPanel } from "./graph-panel.tsx";
import {
	arrowDirection,
	nearestInDirection,
	urgentStatus,
} from "./graph-view.ts";
import { isInterfaceCovered } from "./interface-keys.ts";
import type { InterfaceRendererProps } from "./interface-renderer.ts";

const NODE_STYLE = { pointerEvents: "all" } as const;

/** Edges paint in this order, so live spokes sit above memberships. */
const EDGE_LAYER: Record<GraphEdge["kind"], number> = {
	collaborates: 1,
	member: 0,
	talks: 2,
};

function isEditableTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return (
		target.isContentEditable ||
		target.tagName === "INPUT" ||
		target.tagName === "TEXTAREA" ||
		target.tagName === "SELECT"
	);
}

function agentsFor(
	snapshot: InterfaceSnapshot,
	ids: readonly string[]
): InterfaceAgent[] {
	const wanted = new Set(ids);
	return snapshot.agents.filter((agent) => wanted.has(agent.id));
}

function plural(count: number, one: string): string {
	return `${count} ${one}${count === 1 ? "" : "s"}`;
}

function nodeDescription(
	snapshot: InterfaceSnapshot,
	node: GraphNode,
	agent: InterfaceAgent | undefined,
	linkedCount: number
): string {
	switch (node.kind) {
		case "agent":
			return agent?.description.trim() || "Agent";
		case "team":
			return `Team · ${plural(linkedCount, "member")}`;
		case "project":
			return `Project · ${plural(linkedCount, "agent")}`;
		default:
			return `Everyone you work with · ${plural(snapshot.agents.length, "agent")}`;
	}
}

function GraphLoading() {
	return (
		<div
			aria-busy="true"
			aria-label="Loading the map"
			className="relative flex size-full items-center justify-center bg-background"
			data-testid="interface-graph"
			role="status"
		>
			<div aria-hidden="true" className="relative size-80">
				<Skeleton className="absolute top-1/2 left-1/2 size-24 -translate-x-1/2 -translate-y-1/2 rounded-full" />
				{[0, 1, 2, 3, 4, 5].map((index) => {
					const angle = (index / 6) * Math.PI * 2 - Math.PI / 2;
					return (
						<Skeleton
							className="absolute size-12 -translate-x-1/2 -translate-y-1/2 rounded-full"
							key={index}
							style={{
								left: `${50 + Math.cos(angle) * 40}%`,
								top: `${50 + Math.sin(angle) * 40}%`,
							}}
						/>
					);
				})}
			</div>
			<span className="sr-only">Loading the map…</span>
		</div>
	);
}

/**
 * Graph interface: a live map of who works with whom. You sit at the hub,
 * agents ring around you (spoke weight = threads together), and teams and
 * projects sit beside their members. Picking a node lists its threads and
 * starts new ones; an open thread shows the host's real chat surface.
 */
export function GraphInterface({
	activeThreadId,
	loading,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<InterfaceParamsByRenderer["graph"]>) {
	const summaryId = useId();
	const rootRef = useRef<HTMLDivElement>(null);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const focusHeadingRef = useRef(false);
	const reducedMotion = usePrefersReducedMotion();
	const [pickedId, setPickedId] = useState<string | null>(null);
	const [focusedId, setFocusedId] = useState("you");

	const graph = useMemo(() => settleGroups(projectGraph(snapshot)), [snapshot]);
	const nodeById = useMemo(
		() => new Map(graph.nodes.map((node) => [node.id, node])),
		[graph]
	);
	// A pick the snapshot no longer has (a removed agent) simply clears.
	const selected = pickedId ? nodeById.get(pickedId) : undefined;
	const selectedId = selected?.id ?? null;
	const activeThread = activeThreadId
		? snapshot.threads.find((thread) => thread.id === activeThreadId)
		: undefined;
	const threadOpen = threadView !== null && threadView !== undefined;

	// Focus: the open thread's people, else the picked node.
	const focusIds = useMemo(() => {
		if (threadOpen && activeThread) {
			return threadNodeIds(activeThread);
		}
		return new Set(selectedId ? [selectedId] : []);
	}, [activeThread, selectedId, threadOpen]);
	const relatedIds = useMemo(
		() => neighborhood(graph.edges, focusIds),
		[focusIds, graph.edges]
	);
	const emphasis = useCallback(
		(nodeId: string): GraphEmphasis => {
			if (focusIds.size === 0) {
				return "normal";
			}
			if (focusIds.has(nodeId)) {
				return "focus";
			}
			// "You" stays lit: every thread is yours.
			return relatedIds.has(nodeId) || nodeId === "you" ? "related" : "dimmed";
		},
		[focusIds, relatedIds]
	);

	const agentsById = useMemo(
		() => new Map(snapshot.agents.map((agent) => [agent.id, agent])),
		[snapshot.agents]
	);
	const nodes = useMemo<GraphFlowNode[]>(
		() =>
			graph.nodes.map((node) => {
				const threads = threadsForNode(snapshot, node);
				return {
					data: {
						agent: node.refId ? agentsById.get(node.refId) : undefined,
						node,
						urgent: node.kind === "you" ? null : urgentStatus(threads),
						yourTurn: threads.filter(
							(thread) => threadStatus(thread) === "your-turn"
						).length,
					},
					height: GRAPH_NODE_SIZE[node.kind].height,
					id: node.id,
					position: { x: node.x, y: node.y },
					// Nodes are not React Flow-selectable (their buttons are), so
					// opt back into pointer events for those buttons.
					style: NODE_STYLE,
					type: node.kind,
					width: GRAPH_NODE_SIZE[node.kind].width,
				};
			}),
		[agentsById, graph.nodes, snapshot]
	);
	const edges = useMemo<GraphFlowEdge[]>(
		() =>
			[...graph.edges]
				.sort((a, b) => EDGE_LAYER[a.kind] - EDGE_LAYER[b.kind])
				.map((edge) => {
					const touchesFocus =
						focusIds.has(edge.source) || focusIds.has(edge.target);
					let edgeEmphasis: GraphEmphasis = "normal";
					if (focusIds.size > 0) {
						edgeEmphasis = touchesFocus ? "focus" : "dimmed";
					}
					const target = nodeById.get(edge.target);
					const live = edge.kind === "talks" && target?.status === "working";
					return {
						data: {
							emphasis: edgeEmphasis,
							kind: edge.kind,
							live,
							motion: !reducedMotion,
							weight: edge.weight,
						},
						id: edge.id,
						source: edge.source,
						target: edge.target,
						type: "graph",
					};
				}),
		[focusIds, graph.edges, nodeById, reducedMotion]
	);

	const focusNode = useCallback((nodeId: string) => {
		setFocusedId(nodeId);
		const button = rootRef.current?.querySelector<HTMLElement>(
			`[data-graph-node="${CSS.escape(nodeId)}"]`
		);
		button?.focus({ preventScroll: true });
	}, []);
	const select = useCallback((nodeId: string, keyboard: boolean) => {
		focusHeadingRef.current = keyboard;
		setFocusedId(nodeId);
		setPickedId((current) => (current === nodeId && !keyboard ? null : nodeId));
	}, []);
	// Arrow keys walk the map spatially; the map itself is one tab stop.
	const onNodeKeyDown = useCallback(
		(nodeId: string, event: KeyboardEvent<HTMLButtonElement>) => {
			const direction = arrowDirection(event.key);
			if (!direction) {
				return;
			}
			event.preventDefault();
			const next = nearestInDirection(graph.nodes, nodeId, direction);
			if (next) {
				focusNode(next);
			}
		},
		[focusNode, graph.nodes]
	);
	const tabStopId = nodeById.has(focusedId) ? focusedId : "you";
	const context = useMemo<GraphMapContextValue>(
		() => ({
			emphasis,
			onNodeFocus: setFocusedId,
			onNodeKeyDown,
			select,
			selectedId,
			tabStopId,
		}),
		[emphasis, onNodeKeyDown, select, selectedId, tabStopId]
	);

	// Move focus to the new content after a keyboard pick, a thread opening or
	// closing, so keyboard and screen-reader users never fall back to <body>.
	useEffect(() => {
		if (!focusHeadingRef.current) {
			return;
		}
		focusHeadingRef.current = false;
		if (headingRef.current) {
			headingRef.current.focus();
		} else if (!(selectedId || threadOpen)) {
			focusNode("you");
		}
	}, [focusNode, selectedId, threadOpen]);

	const closeThread = () => {
		focusHeadingRef.current = true;
		// Coming back from a thread lands on the node it belongs to.
		if (!selectedId && activeThread?.agentIds[0]) {
			setPickedId(`agent:${activeThread.agentIds[0]}`);
		}
		port.closeThread();
	};
	const clearSelection = () => {
		const previous = selectedId;
		setPickedId(null);
		if (previous) {
			window.requestAnimationFrame(() => focusNode(previous));
		}
	};
	const openThread = (threadId: string) => {
		focusHeadingRef.current = true;
		port.openThread(threadId);
	};
	const onEscape = (event: globalThis.KeyboardEvent) => {
		if (threadOpen) {
			event.preventDefault();
			closeThread();
		} else if (selectedId) {
			event.preventDefault();
			clearSelection();
		}
	};
	const onEscapeRef = useRef(onEscape);
	onEscapeRef.current = onEscape;

	// Escape steps back (thread → node → map) from anywhere in the interface,
	// including when focus has fallen to <body>; typing fields keep their Esc.
	useEffect(() => {
		const onKeyDown = (event: globalThis.KeyboardEvent) => {
			if (isInterfaceCovered(rootRef.current)) {
				return;
			}
			const target = event.target;
			const inside =
				target === document.body ||
				(target instanceof Node && rootRef.current?.contains(target));
			if (
				event.key !== "Escape" ||
				event.defaultPrevented ||
				!inside ||
				isEditableTarget(target)
			) {
				return;
			}
			onEscapeRef.current(event);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	const summary = useMemo(
		() => graphSummary(snapshot, graph),
		[graph, snapshot]
	);
	const workingCount = snapshot.agents.filter(
		(agent) => agent.status === "working"
	).length;
	const stats = `${plural(snapshot.agents.length, "agent")} · ${workingCount} working · ${plural(snapshot.threads.length, "thread")}`;

	if (
		loading &&
		snapshot.agents.length === 0 &&
		snapshot.threads.length === 0
	) {
		return <GraphLoading />;
	}

	if (snapshot.agents.length === 0 && snapshot.threads.length === 0) {
		return (
			<div
				className="@container relative flex size-full min-h-0 bg-background text-foreground"
				data-testid="interface-graph"
			>
				<Empty className="m-auto max-w-md">
					<EmptyHeader>
						<EmptyTitle>No one on the map yet</EmptyTitle>
						<EmptyDescription>
							Agents you add, and the threads you start with them, appear here
							as a map of who works with whom.
						</EmptyDescription>
					</EmptyHeader>
					<EmptyContent>
						<Button onClick={() => port.startThread({})} type="button">
							<SquarePen aria-hidden="true" data-icon="inline-start" />
							New thread
						</Button>
					</EmptyContent>
				</Empty>
				{threadOpen ? (
					<GraphThreadPanel
						backLabel="Close thread"
						headingRef={headingRef}
						onBack={port.closeThread}
						snapshot={snapshot}
						thread={activeThread}
						threadView={threadView}
					/>
				) : null}
			</div>
		);
	}

	let panel: ReactNode = null;
	if (threadOpen) {
		const backTarget =
			selected ??
			(activeThread?.agentIds[0]
				? nodeById.get(`agent:${activeThread.agentIds[0]}`)
				: undefined);
		panel = (
			<GraphThreadPanel
				backLabel={
					backTarget && backTarget.kind !== "you"
						? `Back to ${backTarget.label}`
						: "Back to the map"
				}
				headingRef={headingRef}
				onBack={closeThread}
				snapshot={snapshot}
				thread={activeThread}
				threadView={threadView}
			/>
		);
	} else if (selected) {
		const agent = selected.refId ? agentsById.get(selected.refId) : undefined;
		const linked = agentsFor(snapshot, linkedAgentIds(graph, selected.id));
		const group = groupForNode(snapshot, selected);
		let composerAgents: InterfaceAgent[] = [];
		if (selected.kind === "you") {
			composerAgents = snapshot.agents;
		} else if (selected.kind === "project") {
			composerAgents = linked.length > 0 ? linked : snapshot.agents;
		}
		let linkedLabel = "Works with";
		if (selected.kind === "team") {
			linkedLabel = "Members";
		} else if (selected.kind === "project") {
			linkedLabel = "Agents on this project";
		}
		panel = (
			<GraphNodePanel
				activeThreadId={activeThreadId}
				agent={agent}
				composerAgents={composerAgents}
				description={nodeDescription(snapshot, selected, agent, linked.length)}
				headingRef={headingRef}
				linkedAgents={selected.kind === "you" ? [] : linked}
				linkedLabel={linkedLabel}
				node={selected}
				onClose={clearSelection}
				onOpenThread={openThread}
				onSelectNode={(nodeId) => {
					setPickedId(nodeId);
					window.requestAnimationFrame(() => focusNode(nodeId));
				}}
				onStart={({ agentId, prompt }) => {
					focusHeadingRef.current = true;
					switch (selected.kind) {
						case "agent":
							port.startThread({
								agentId: selected.refId ?? undefined,
								prompt,
							});
							break;
						case "team":
							port.startThread({ prompt, teamId: group?.id });
							break;
						case "project":
							port.startThread({ agentId, projectId: group?.id, prompt });
							break;
						default:
							port.startThread({ agentId, prompt });
					}
				}}
				snapshot={snapshot}
				threads={threadsForNode(snapshot, selected)}
			/>
		);
	}

	let layoutKey = "map";
	if (threadOpen) {
		layoutKey = "thread";
	} else if (selected) {
		layoutKey = "node";
	}
	// Frame what matters: an open thread's people, or a pick and its neighbors.
	let frameIds: string[] = [];
	if (threadOpen && focusIds.size > 0) {
		frameIds = [...focusIds, "you"];
	} else if (focusIds.size > 0) {
		frameIds = [...focusIds, ...relatedIds, "you"];
	}

	return (
		<div
			aria-busy={loading || undefined}
			className="@container relative flex size-full min-h-0 overflow-hidden bg-background text-foreground"
			data-testid="interface-graph"
			ref={rootRef}
		>
			<div className="relative min-w-0 flex-1">
				<GraphCanvas
					context={context}
					describedBy={summaryId}
					edges={edges}
					frameIds={[...new Set(frameIds)]}
					graphNodes={graph.nodes}
					layoutKey={layoutKey}
					nodes={nodes}
					stats={stats}
				/>
				<div className="sr-only" id={summaryId}>
					{summary.map((line) => (
						<p key={line}>{line}</p>
					))}
					<p>
						Use the arrow keys to move between the people on the map and press
						Enter to see their threads.
					</p>
				</div>
			</div>
			{panel}
		</div>
	);
}
