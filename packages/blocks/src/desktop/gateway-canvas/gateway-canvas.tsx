"use client";

// The live gateway canvas (managed guardrails spec 07): requests flowing from
// clients through the gateway, its admission checks, the policy ladder and
// screeners to the router and providers, with click-to-edit on every node.
// Built once here and hosted by the desktop Gateway dialog and the web
// console; each host passes an adapter for its topology, feed and editors.

import { Button } from "@ryu/ui/components/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover";
import { cn } from "@ryu/ui/lib/utils";
import {
	Background,
	BackgroundVariant,
	type FitViewOptions,
	Panel,
	type ProOptions,
	ReactFlow,
	ReactFlowProvider,
	useReactFlow,
} from "@xyflow/react";
import { Lock, Maximize, Minus, Plus } from "lucide-react";
import {
	type CSSProperties,
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
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
	EDGE_STROKE,
	OUTCOME_COLOR,
	PulseLayer,
} from "./edges.tsx";
import {
	CANVAS_NODE_WIDTH,
	type CanvasLayout,
	layoutTopology,
	linkEnds,
} from "./layout.ts";
import { type CanvasLiveStore, createCanvasLiveStore } from "./live-store.ts";
import {
	type CanvasEdgeKind,
	type CanvasFeedState,
	type CanvasNode,
	type CanvasTopology,
	formatCount,
	type GatewayCanvasAdapter,
	MAX_PULSES_PER_SECOND,
	OUTCOME_LABELS,
	type PulseOutcome,
} from "./model.ts";
import {
	CANVAS_NODE_TYPES,
	CanvasContext,
	type CanvasContextValue,
	type CanvasFlowNode,
	HealthDot,
} from "./nodes.tsx";
import { CanvasNodePanel } from "./panel.tsx";
import { CanvasTableView } from "./table-view.tsx";

// Module level so React Flow never sees new objects (spec 07.5, the
// getSnapshot loop guard).
const PRO_OPTIONS: ProOptions = { hideAttribution: true };
const FIT_VIEW_OPTIONS: FitViewOptions = { maxZoom: 1, padding: 0.06 };
const FLOW_THEME = {
	"--xy-background-color": "transparent",
	"--xy-edge-stroke": "var(--border)",
	"--xy-node-border-radius": "var(--radius)",
} as CSSProperties;

/** Below this width the table is the default view and the panel stacks. */
const NARROW_WIDTH = 640;
const SWEEP_MS = 400;
/** The side panel's width plus its margins, in screen pixels. */
const PANEL_CLEARANCE = 424;
const EDGE_MARGIN = 24;

const OVERLAY =
	"m-0 flex min-w-0 items-center rounded-lg border border-border bg-background p-0.5 text-foreground";
const META = "text-xs";

export type CanvasView = "map" | "table";

export interface GatewayCanvasProps {
	adapter: GatewayCanvasAdapter;
	className?: string;
	/** Defaults to the map, or the table on narrow containers. */
	defaultView?: CanvasView;
	feed: CanvasFeedState;
	/** The canvas's accessible name. */
	label: string;
	/**
	 * Called whenever the React Flow node array is built. A traffic tick must
	 * never build it; hosts and tests use this to hold that budget.
	 */
	onNodesBuilt?: () => void;
	/** Host actions shown beside the view switch (an expand button). */
	toolbar?: ReactNode;
}

/** Reading order: columns left to right, then the infrastructure band. */
function readingOrder(layout: CanvasLayout): string[] {
	return Object.entries(layout)
		.sort(([, a], [, b]) => {
			const columnA = a.column < 0 ? Number.MAX_SAFE_INTEGER : a.column;
			const columnB = b.column < 0 ? Number.MAX_SAFE_INTEGER : b.column;
			return columnA - columnB || a.y - b.y || a.x - b.x;
		})
		.map(([id]) => id);
}

function buildNodes(
	topology: CanvasTopology,
	layout: CanvasLayout
): CanvasFlowNode[] {
	return topology.nodes.map((node) => ({
		data: { node },
		draggable: false,
		id: node.id,
		position: { x: layout[node.id]?.x ?? 0, y: layout[node.id]?.y ?? 0 },
		selectable: false,
		type: "gateway-canvas",
	}));
}

function buildEdges(
	topology: CanvasTopology,
	layout: CanvasLayout
): CanvasFlowEdge[] {
	const edges: CanvasFlowEdge[] = [];
	for (const edge of topology.edges) {
		const from = layout[edge.from];
		const to = layout[edge.to];
		if (!(from && to)) {
			continue;
		}
		const { source, target } = linkEnds(from, to);
		edges.push({
			data: {
				d: `M${source.x},${source.y} L${target.x},${target.y}`,
				kind: edge.kind,
			},
			focusable: false,
			id: edge.id,
			selectable: false,
			source: edge.from,
			target: edge.to,
			type: "gateway-canvas",
		});
	}
	return edges;
}

function LegendLine({ kind }: { kind: CanvasEdgeKind }) {
	return (
		<svg aria-hidden="true" height="12" viewBox="0 0 24 12" width="24">
			<line style={EDGE_STROKE[kind]} x1="2" x2="22" y1="6" y2="6" />
		</svg>
	);
}

function LegendDot({ outcome }: { outcome: PulseOutcome }) {
	return (
		<span
			aria-hidden="true"
			className="size-2 rounded-full"
			style={{ background: OUTCOME_COLOR[outcome] }}
		/>
	);
}

const LEGEND_OUTCOMES: PulseOutcome[] = [
	"allow",
	"redacted",
	"block",
	"cache_hit",
	"degraded",
	"error",
];

function CanvasLegend({ motion }: { motion: boolean }) {
	return (
		<Popover>
			<PopoverTrigger
				render={
					<Button
						className={cn(
							"h-7 px-2 text-muted-foreground hover:text-foreground aria-expanded:text-foreground",
							META
						)}
						size="xs"
						type="button"
						variant="ghost"
					/>
				}
			>
				Legend
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className="w-64 gap-0 rounded-lg border-border bg-background p-3 shadow-none"
				side="bottom"
				sideOffset={6}
			>
				<ul aria-label="Legend" className={cn("flex flex-col gap-2", META)}>
					{LEGEND_OUTCOMES.map((outcome) => (
						<li className="flex h-4 items-center gap-2" key={outcome}>
							<span className="flex w-6 justify-center">
								<LegendDot outcome={outcome} />
							</span>
							{OUTCOME_LABELS[outcome]}
						</li>
					))}
					<li className="flex h-4 items-center gap-2">
						<LegendLine kind="traffic" />
						Request path
					</li>
					<li className="flex h-4 items-center gap-2">
						<LegendLine kind="control" />
						Configuration and health
					</li>
					<li className="flex h-4 items-center gap-2">
						<span className="flex w-6 justify-center">
							<Lock aria-hidden="true" className="size-3" />
						</span>
						Fixed by Ryu or the pipeline
					</li>
					<li className="flex h-4 items-center gap-2">
						<span className="flex w-6 justify-center">
							<HealthDot health="degraded" />
						</span>
						Degraded or down
					</li>
				</ul>
				<p className={cn("mt-3 text-muted-foreground", META)}>
					{motion
						? `A blocked request stops at the layer that refused it. At most ${MAX_PULSES_PER_SECOND} requests a second are drawn; counts include every request.`
						: "Motion is reduced, so requests are counted but not animated."}
				</p>
			</PopoverContent>
		</Popover>
	);
}

const FEED_LABEL: Record<CanvasFeedState["status"], string> = {
	aggregated: "Per-minute totals",
	connecting: "Connecting",
	denied: "No access to live traffic",
	live: "Live",
	off: "No live feed",
	unavailable: "Feed unavailable",
};

function FeedStatus({
	feed,
	store,
}: {
	feed: CanvasFeedState;
	store: CanvasLiveStore;
}) {
	const totals = useSyncExternalStore(
		store.subscribe,
		store.totals,
		store.totals
	);
	const live = feed.status === "live";
	const parts = [feed.message ?? FEED_LABEL[feed.status]];
	if (live || totals.requests > 0) {
		if (live) {
			parts.push(
				`${totals.perSecond.toFixed(totals.perSecond < 10 ? 1 : 0)}/s`
			);
		}
		parts.push(`${formatCount(totals.requests)} requests`);
		parts.push(`${formatCount(totals.blocked)} blocked`);
	}
	return (
		<p
			aria-live="off"
			className={cn(
				"flex min-w-0 items-center gap-1.5 truncate px-2 tabular-nums",
				META
			)}
		>
			<span
				aria-hidden="true"
				className={cn(
					"size-1.5 shrink-0 rounded-full",
					live ? "bg-success" : "bg-muted-foreground/50"
				)}
			/>
			<span className="truncate">{parts.join(" · ")}</span>
		</p>
	);
}

function ViewSwitch({
	onChange,
	view,
}: {
	onChange: (view: CanvasView) => void;
	view: CanvasView;
}) {
	return (
		<fieldset aria-label="View" className="flex items-center gap-0.5">
			{(["map", "table"] as const).map((option) => (
				<Button
					aria-pressed={view === option}
					className={cn(
						"h-7 px-2 text-muted-foreground aria-pressed:bg-muted aria-pressed:text-foreground",
						META
					)}
					key={option}
					onClick={() => onChange(option)}
					size="xs"
					type="button"
					variant="ghost"
				>
					{option === "map" ? "Map" : "Table"}
				</Button>
			))}
		</fieldset>
	);
}

function ZoomControls({ duration }: { duration: number }) {
	const flow = useReactFlow();
	return (
		<Panel position="bottom-left">
			<fieldset aria-label="Zoom" className={OVERLAY}>
				<Button
					aria-label="Zoom out"
					className="size-7 text-muted-foreground"
					onClick={() => flow.zoomOut({ duration })}
					size="icon-sm"
					type="button"
					variant="ghost"
				>
					<Minus aria-hidden="true" className="size-4" />
				</Button>
				<Button
					aria-label="Zoom in"
					className="size-7 text-muted-foreground"
					onClick={() => flow.zoomIn({ duration })}
					size="icon-sm"
					type="button"
					variant="ghost"
				>
					<Plus aria-hidden="true" className="size-4" />
				</Button>
				<span aria-hidden="true" className="mx-0.5 h-4 w-px bg-border" />
				<Button
					aria-label="Fit map to view"
					className="size-7 text-muted-foreground"
					onClick={() => flow.fitView({ ...FIT_VIEW_OPTIONS, duration })}
					size="icon-sm"
					type="button"
					variant="ghost"
				>
					<Maximize aria-hidden="true" className="size-4" />
				</Button>
			</fieldset>
		</Panel>
	);
}

/** Tracks whether the canvas is narrower than {@link NARROW_WIDTH}. */
function useNarrow(ref: React.RefObject<HTMLElement | null>): boolean | null {
	const [narrow, setNarrow] = useState<boolean | null>(null);
	useEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		const measure = () =>
			setNarrow(element.getBoundingClientRect().width < NARROW_WIDTH);
		measure();
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return narrow;
}

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
