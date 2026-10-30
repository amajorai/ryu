"use client";

// The live gateway canvas (managed guardrails spec 07): requests flowing from
// clients through the gateway, its admission checks, the policy ladder and
// screeners to the router and providers, with click-to-edit on every node.
// Built once here and hosted by the desktop Gateway dialog and the web
// console; each host passes an adapter for its topology, feed and editors.

import { cn } from "@ryu/ui/lib/utils";
import {
	Background,
	BackgroundVariant,
	Panel,
	ReactFlow,
	ReactFlowProvider,
	useReactFlow,
} from "@xyflow/react";
import {
	type KeyboardEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { usePrefersReducedMotion } from "../interfaces/graph-canvas.tsx";
import {
	AssignPolicyDialog,
	type AssignRequest,
	PolicyPalette,
} from "./assign.tsx";
import {
	CANVAS_EDGE_TYPES,
	type CanvasFlowEdge,
	PulseLayer,
} from "./edges.tsx";
import {
	buildEdges,
	buildNodes,
	readingOrder,
} from "./gateway-canvas-build.ts";
import {
	type CanvasView,
	EDGE_MARGIN,
	FIT_VIEW_OPTIONS,
	FLOW_THEME,
	type GatewayCanvasProps,
	OVERLAY,
	PANEL_CLEARANCE,
	PRO_OPTIONS,
	SWEEP_MS,
} from "./gateway-canvas-constants.ts";
import {
	FeedStatus,
	useNarrow,
	ViewSwitch,
	ZoomControls,
} from "./gateway-canvas-controls.tsx";
import { CanvasLegend } from "./gateway-canvas-legend.tsx";
import { CANVAS_NODE_WIDTH, layoutTopology } from "./layout.ts";
import { createCanvasLiveStore } from "./live-store.ts";
import type { CanvasNode } from "./model.ts";
import {
	CANVAS_NODE_TYPES,
	CanvasContext,
	type CanvasContextValue,
	type CanvasFlowNode,
} from "./nodes.tsx";
import { CanvasNodePanel } from "./panel.tsx";
import { CanvasTableView } from "./table-view.tsx";

export type {
	CanvasView,
	GatewayCanvasProps,
} from "./gateway-canvas-constants.ts";

function GatewayCanvasInner({
	adapter,
	className,
	defaultView,
	feed,
	label,
	onNodesBuilt,
	toolbar,
}: GatewayCanvasProps) {
	const [store] = useState(() => createCanvasLiveStore());
	const reducedMotion = usePrefersReducedMotion();
	const motion = !reducedMotion;
	const duration = motion ? 300 : 0;
	const wrapperRef = useRef<HTMLDivElement>(null);
	const narrow = useNarrow(wrapperRef);
	const [chosenView, setChosenView] = useState<CanvasView | null>(
		defaultView ?? null
	);
	const view: CanvasView = chosenView ?? (narrow ? "table" : "map");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [dragging, setDragging] = useState(false);
	const [assignRequest, setAssignRequest] = useState<AssignRequest | null>(
		null
	);
	const [assignNotice, setAssignNotice] = useState<string | null>(null);
	// With no feed (or no access to one) there are no numbers: nodes draw no
	// counts rather than a row of zeros that reads as "no traffic".
	const counted = feed.status !== "off" && feed.status !== "denied";

	useEffect(() => {
		store.setMotion(motion);
	}, [motion, store]);

	const { subscribe } = adapter;
	useEffect(() => {
		if (!subscribe) {
			return;
		}
		return subscribe(
			(pulse) => store.ingest(pulse),
			(counters, links) => store.replaceCounters(counters, links)
		);
	}, [store, subscribe]);

	useEffect(() => {
		const timer = window.setInterval(() => store.sweep(), SWEEP_MS);
		return () => window.clearInterval(timer);
	}, [store]);

	// Everything React Flow is given depends on the topology version alone.
	const { topology } = adapter;
	const topologyRef = useRef(topology);
	topologyRef.current = topology;
	const version = topology.version;
	const onBuiltRef = useRef(onNodesBuilt);
	onBuiltRef.current = onNodesBuilt;
	// The version is the rebuild key; the topology is read through a ref.
	const { edges, layout, nodes, order } = useMemo(() => {
		const current = topologyRef.current;
		const placed = layoutTopology(current);
		onBuiltRef.current?.();
		return {
			edges: buildEdges(current, placed),
			layout: placed,
			nodes: buildNodes(current, placed),
			order: readingOrder(placed),
		};
	}, [version]);

	const selected = selectedId
		? (topology.nodes.find((node) => node.id === selectedId) ?? null)
		: null;

	// Drag-to-assign: only for editors, only onto layers with a scope to take
	// the policy.
	const assignment =
		adapter.canEdit && adapter.assignment?.policies.length
			? adapter.assignment
			: null;
	const acceptsDrop = useCallback(
		(node: CanvasNode) =>
			assignment !== null &&
			node.kind === "scope" &&
			assignment.targets(node).length > 0,
		[assignment]
	);
	const layers = useMemo(
		() => topology.nodes.filter((node) => acceptsDrop(node)),
		[acceptsDrop, topology]
	);

	// Keep the selected node in view beside the panel rather than under it.
	const flow = useReactFlow();
	useEffect(() => {
		const wrapper = wrapperRef.current;
		const placed = selectedId ? layout[selectedId] : undefined;
		if (!(wrapper && placed) || view !== "map" || narrow) {
			return;
		}
		const { width } = wrapper.getBoundingClientRect();
		const open = width - PANEL_CLEARANCE;
		const viewport = flow.getViewport();
		const left = viewport.x + placed.x * viewport.zoom;
		const right = left + CANVAS_NODE_WIDTH * viewport.zoom;
		if (left >= EDGE_MARGIN && right <= open - EDGE_MARGIN) {
			return;
		}
		const centerX = (placed.x + CANVAS_NODE_WIDTH / 2) * viewport.zoom;
		flow.setViewport({ ...viewport, x: open / 2 - centerX }, { duration });
	}, [duration, flow, layout, narrow, selectedId, view]);

	const focusNode = useCallback((id: string) => {
		wrapperRef.current
			?.querySelector<HTMLElement>(`[data-canvas-node="${CSS.escape(id)}"]`)
			?.focus();
	}, []);

	// Move focus back to the node (or its table row) before the panel goes,
	// so focus is never dropped and a host focus trap has nothing to catch.
	const close = useCallback(() => {
		if (selectedId) {
			if (view === "table") {
				wrapperRef.current
					?.querySelector<HTMLElement>(
						`[data-canvas-row="${CSS.escape(selectedId)}"] button`
					)
					?.focus();
			} else {
				focusNode(selectedId);
			}
		}
		setSelectedId(null);
	}, [focusNode, selectedId, view]);

	const context = useMemo<CanvasContextValue>(
		() => ({
			acceptsDrop,
			counted,
			dragging,
			dropPolicy: (nodeId: string, policyId: string) => {
				setDragging(false);
				setAssignNotice(null);
				setAssignRequest({ nodeId, policyId });
			},
			onNodeKeyDown: (id: string, event: KeyboardEvent<HTMLButtonElement>) => {
				const at = order.indexOf(id);
				let next: string | undefined;
				if (event.key === "ArrowDown" || event.key === "ArrowRight") {
					next = order[(at + 1) % order.length];
				} else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
					next = order[(at - 1 + order.length) % order.length];
				} else if (event.key === "Escape" && selectedId) {
					// Close the panel first; a second Escape reaches the host
					// (the Gateway dialog closes on it).
					event.stopPropagation();
					setSelectedId(null);
					return;
				}
				if (next) {
					event.preventDefault();
					focusNode(next);
				}
			},
			select: (id: string) => setSelectedId(id),
			selectedId,
			store,
		}),
		[acceptsDrop, counted, dragging, focusNode, order, selectedId, store]
	);

	const palette = assignment ? (
		<PolicyPalette
			assignment={assignment}
			notice={assignNotice}
			onDragChange={setDragging}
			onOpen={(request) => {
				setAssignNotice(null);
				setAssignRequest(request);
			}}
		/>
	) : null;

	const panel = selected ? (
		<CanvasNodePanel
			counted={counted}
			key={selected.id}
			node={selected}
			onClose={close}
			store={store}
		>
			{adapter.renderEditor(selected)}
		</CanvasNodePanel>
	) : null;

	const header = (
		<div className={cn(OVERLAY, "max-w-full flex-wrap gap-y-0.5")}>
			<FeedStatus feed={feed} store={store} />
			<span aria-hidden="true" className="mx-0.5 h-4 w-px bg-border" />
			<CanvasLegend motion={motion} />
			<ViewSwitch onChange={setChosenView} view={view} />
			{toolbar}
		</div>
	);

	return (
		<CanvasContext.Provider value={context}>
			<div
				className={cn("@container relative flex size-full min-h-0", className)}
				data-canvas-view={view}
				ref={wrapperRef}
			>
				{view === "table" ? (
					<div className="flex min-h-0 w-full flex-col gap-3 overflow-y-auto p-1">
						<div className="flex">{header}</div>
						{palette}
						<CanvasTableView
							counted={counted}
							onOpen={setSelectedId}
							order={order}
							selectedId={selectedId}
							store={store}
							topology={topology}
						/>
						{panel}
					</div>
				) : (
					<ReactFlow<CanvasFlowNode, CanvasFlowEdge>
						aria-label={label}
						className="text-foreground"
						edges={edges}
						edgeTypes={CANVAS_EDGE_TYPES}
						elementsSelectable={false}
						fitView
						fitViewOptions={FIT_VIEW_OPTIONS}
						maxZoom={1.6}
						minZoom={0.2}
						nodes={nodes}
						nodesConnectable={false}
						nodesDraggable={false}
						nodesFocusable={false}
						nodeTypes={CANVAS_NODE_TYPES}
						// Also makes nodes take pointer events: React Flow turns them off
						// on nodes that are neither selectable nor draggable.
						onNodeClick={(_event, node) => setSelectedId(node.id)}
						onPaneClick={() => setSelectedId(null)}
						proOptions={PRO_OPTIONS}
						style={FLOW_THEME}
					>
						<Background
							color="var(--border)"
							gap={20}
							size={1}
							variant={BackgroundVariant.Dots}
						/>
						<Panel position="top-left">{header}</Panel>
						<ZoomControls duration={duration} />
						{palette && !panel ? (
							<Panel position="bottom-right">{palette}</Panel>
						) : null}
						{motion ? <PulseLayer layout={layout} store={store} /> : null}
						{panel ? (
							<Panel
								className={cn(
									"!m-3 flex max-h-[calc(100%-24px)]",
									narrow ? "w-[calc(100%-24px)]" : "w-[400px]"
								)}
								position="top-right"
							>
								{panel}
							</Panel>
						) : null}
					</ReactFlow>
				)}
				{assignment ? (
					<AssignPolicyDialog
						assignment={assignment}
						layers={layers}
						onAssigned={setAssignNotice}
						onClose={() => setAssignRequest(null)}
						request={assignRequest}
					/>
				) : null}
			</div>
		</CanvasContext.Provider>
	);
}

/**
 * The canvas. React Flow measures the DOM, so it renders only once mounted
 * on the client (no hydration mismatch on the web console).
 */
export function GatewayCanvas(props: GatewayCanvasProps) {
	const [mounted, setMounted] = useState(false);
	useEffect(() => {
		setMounted(true);
	}, []);
	if (!mounted) {
		return (
			<div
				aria-busy="true"
				aria-label={props.label}
				className={cn("size-full min-h-0", props.className)}
				role="region"
			/>
		);
	}
	return (
		<ReactFlowProvider>
			<GatewayCanvasInner {...props} />
		</ReactFlowProvider>
	);
}
