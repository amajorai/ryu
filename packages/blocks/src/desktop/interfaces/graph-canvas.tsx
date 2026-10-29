import { Button } from "@ryu/ui/components/button.tsx";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type GraphNode,
	THREAD_STATUS_LABELS,
} from "@ryuhq/protocol/interfaces";
import {
	Background,
	BackgroundVariant,
	MiniMap,
	type MiniMapNodeProps,
	Panel,
	ReactFlow,
	ReactFlowProvider,
	type ReactFlowState,
	useReactFlow,
	useStore,
	useViewport,
} from "@xyflow/react";
import { Maximize, Minus, Plus } from "lucide-react";
import {
	type CSSProperties,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import {
	GRAPH_EDGE_TYPES,
	GRAPH_NODE_TYPES,
	type GraphFlowEdge,
	type GraphFlowNode,
	GraphMapContext,
	type GraphMapContextValue,
} from "./graph-nodes.tsx";
import { GraphStatusDot, TEXT_META } from "./graph-parts.tsx";
import {
	frameViewport,
	type GraphFrameLimits,
	type GraphRect,
	graphBounds,
} from "./graph-view.ts";

/**
 * The map (not its overlays) fades out toward the canvas edges, so a node
 * beyond the edge reads as "the map goes on" instead of being sliced. The
 * side that meets an open panel fades over a longer run. Alpha-only mask: no
 * color involved.
 */
// String.raw keeps the "\_" escapes literal, so Tailwind reads
// `.react-flow__renderer` as one class rather than turning "_" into spaces.
const EDGE_FADE = String.raw`[&_.react-flow\_\_renderer]:[mask-composite:intersect] [&_.react-flow\_\_renderer]:[mask-image:linear-gradient(to_right,transparent,black_48px,black_calc(100%-48px),transparent),linear-gradient(to_bottom,transparent,black_48px,black_calc(100%-48px),transparent)]`;
const EDGE_FADE_PANEL = String.raw`[&_.react-flow\_\_renderer]:[mask-composite:intersect] [&_.react-flow\_\_renderer]:[mask-image:linear-gradient(to_right,transparent,black_48px,black_calc(100%-96px),transparent),linear-gradient(to_bottom,transparent,black_48px,black_calc(100%-48px),transparent)]`;

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void): () => void {
	if (typeof window === "undefined" || !window.matchMedia) {
		return () => undefined;
	}
	const query = window.matchMedia(REDUCED_MOTION);
	query.addEventListener("change", onChange);
	return () => query.removeEventListener("change", onChange);
}

/** True when the user asked the OS for less motion. */
export function usePrefersReducedMotion(): boolean {
	return useSyncExternalStore(
		subscribeReducedMotion,
		() =>
			typeof window !== "undefined" &&
			Boolean(window.matchMedia?.(REDUCED_MOTION).matches),
		() => false
	);
}

/** React Flow's own chrome variables, pointed at the user's theme tokens. */
const FLOW_THEME = {
	"--xy-background-color": "transparent",
	"--xy-edge-stroke": "var(--border)",
	"--xy-node-border-radius": "var(--radius)",
} as CSSProperties;

const MINIMAP_COLOR: Record<GraphNode["kind"], string> = {
	agent: "var(--muted-foreground)",
	project: "color-mix(in oklab, var(--muted-foreground) 45%, transparent)",
	team: "color-mix(in oklab, var(--muted-foreground) 45%, transparent)",
	you: "var(--primary)",
};

function minimapNodeColor(node: GraphFlowNode): string {
	const data = node.data.node;
	if (node.data.urgent === "attention") {
		return "var(--destructive)";
	}
	if (data.kind === "agent" && data.status === "working") {
		return "var(--success)";
	}
	return MINIMAP_COLOR[data.kind];
}

/** Every overlay on the map shares this flat, solid surface. */
const OVERLAY =
	"m-0 flex min-w-0 items-center rounded-lg border border-border bg-background p-0.5 text-foreground";

function ControlButton({
	children,
	label,
	onClick,
}: {
	children: ReactNode;
	label: string;
	onClick: () => void;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						aria-label={label}
						className="size-7 text-muted-foreground hover:text-foreground"
						onClick={onClick}
						size="icon-sm"
						type="button"
						variant="ghost"
					/>
				}
			>
				{children}
			</TooltipTrigger>
			<TooltipContent side="top">{label}</TooltipContent>
		</Tooltip>
	);
}

/** Zoom out / level / zoom in / fit, as theme-native buttons. */
function GraphZoomControls({
	duration,
	onFit,
	onZoom,
}: {
	duration: number;
	/** Frame the whole map again (clear of the overlays). */
	onFit: () => void;
	/** The user changed the zoom themselves. */
	onZoom: () => void;
}) {
	const flow = useReactFlow();
	const { zoom } = useViewport();
	return (
		<Panel position="bottom-left">
			<fieldset aria-label="Zoom" className={OVERLAY}>
				<ControlButton
					label="Zoom out"
					onClick={() => {
						onZoom();
						flow.zoomOut({ duration });
					}}
				>
					<Minus aria-hidden="true" className="size-4" />
				</ControlButton>
				<output
					aria-label="Zoom level"
					className={cn(
						"w-11 text-center text-muted-foreground tabular-nums",
						TEXT_META
					)}
				>
					{Math.round(zoom * 100)}%
				</output>
				<ControlButton
					label="Zoom in"
					onClick={() => {
						onZoom();
						flow.zoomIn({ duration });
					}}
				>
					<Plus aria-hidden="true" className="size-4" />
				</ControlButton>
				<span aria-hidden="true" className="mx-0.5 h-4 w-px bg-border" />
				<ControlButton label="Fit map to view" onClick={onFit}>
					<Maximize aria-hidden="true" className="size-4" />
				</ControlButton>
			</fieldset>
		</Panel>
	);
}

type LegendKind = "collaborates" | "member" | "talks";

/** The same strokes the map draws, at legend scale. */
const LEGEND_STROKE: Record<LegendKind, CSSProperties> = {
	collaborates: {
		stroke: "var(--muted-foreground)",
		strokeOpacity: 0.5,
		strokeWidth: 1,
	},
	member: {
		stroke: "var(--muted-foreground)",
		strokeDasharray: "3 3",
		strokeOpacity: 0.5,
		strokeWidth: 1,
	},
	talks: {
		stroke: "var(--muted-foreground)",
		strokeOpacity: 0.7,
		strokeWidth: 2,
	},
};

function LegendLine({ kind }: { kind: LegendKind }) {
	return (
		<svg
			aria-hidden="true"
			className="block shrink-0"
			height="12"
			viewBox="0 0 24 12"
			width="24"
		>
			<line style={LEGEND_STROKE[kind]} x1="2" x2="22" y1="6" y2="6" />
		</svg>
	);
}

const LEGEND_ROWS: { label: string; mark: ReactNode }[] = [
	{ label: "Threads with you", mark: <LegendLine kind="talks" /> },
	{ label: "Work together", mark: <LegendLine kind="collaborates" /> },
	{ label: "Team or project member", mark: <LegendLine kind="member" /> },
	{
		label: THREAD_STATUS_LABELS.working,
		mark: <GraphStatusDot status="working" />,
	},
	{
		label: THREAD_STATUS_LABELS["your-turn"],
		mark: <GraphStatusDot status="your-turn" />,
	},
	{
		label: THREAD_STATUS_LABELS.attention,
		mark: <GraphStatusDot status="attention" />,
	},
];

/** The legend opens on the same flat surface as the overlays it hangs from. */
const LEGEND_SURFACE =
	"w-60 gap-0 rounded-lg border-border bg-background p-3 shadow-none backdrop-blur-none backdrop-saturate-100 before:hidden";

/**
 * The one-line tally, with what the lines and marks mean behind a Legend
 * button, so the map keeps its room. The same bar shows with or without a
 * side panel; only very narrow canvases drop it.
 */
function GraphLegend({ stats }: { stats: string }) {
	return (
		<Panel position="top-left">
			<div className={OVERLAY}>
				<p
					className={cn(
						"truncate px-2 text-foreground tabular-nums",
						TEXT_META
					)}
				>
					{stats}
				</p>
				<span aria-hidden="true" className="mx-0.5 h-4 w-px bg-border" />
				<Popover>
					<PopoverTrigger
						render={
							<Button
								className={cn(
									"h-7 px-2 text-muted-foreground hover:text-foreground aria-expanded:text-foreground",
									TEXT_META
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
						className={LEGEND_SURFACE}
						side="bottom"
						sideOffset={6}
					>
						<ul
							aria-label="Legend"
							className={cn("flex flex-col gap-2 text-foreground", TEXT_META)}
						>
							{LEGEND_ROWS.map((row) => (
								<li className="flex h-4 items-center gap-2" key={row.label}>
									<span className="flex w-6 shrink-0 items-center justify-center">
										{row.mark}
									</span>
									<span>{row.label}</span>
								</li>
							))}
						</ul>
					</PopoverContent>
				</Popover>
			</div>
		</Panel>
	);
}

/**
 * Mini map marks in the map's own shapes: people are dots, teams and
 * projects small rounded bars.
 */
function MiniMapMark({
	color,
	height,
	id,
	shapeRendering,
	width,
	x,
	y,
}: MiniMapNodeProps) {
	const style = { fill: color } as CSSProperties;
	if (id === "you" || id.startsWith("agent:")) {
		return (
			<circle
				cx={x + width / 2}
				cy={y + height / 2}
				r={Math.min(width, height) / 2}
				shapeRendering={shapeRendering}
				style={style}
			/>
		);
	}
	return (
		<rect
			height={height}
			rx={10}
			shapeRendering={shapeRendering}
			style={style}
			width={width}
			x={x}
			y={y}
		/>
	);
}

interface GraphCanvasProps {
	context: GraphMapContextValue;
	describedBy: string;
	edges: GraphFlowEdge[];
	/** Node ids to frame; empty frames the whole map. */
	frameIds: string[];
	/** The projected map nodes (positions are centers). */
	graphNodes: readonly GraphNode[];
	/** `map` when nothing is open beside the canvas; anything else hides the mini map. */
	layoutKey: string;
	nodes: GraphFlowNode[];
	stats: string;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;

/**
 * The map is designed at 100%; framing may magnify a small map up to 130%
 * so a handful of agents fills the window instead of floating in it.
 */
const FRAME_LIMITS: GraphFrameLimits = {
	fitMaxZoom: 1.3,
	focusMaxZoom: 1,
	gap: 28,
	minZoom: MIN_ZOOM,
	narrowWidth: 720,
	// Labels grow to stay legible when zoomed out, so the whole map stays in
	// view down to half size before a pick magnifies its neighborhood.
	readableZoom: 0.5,
};

/** "WxH" once React Flow has measured the canvas and can move it, else "". */
function selectCanvasSize(state: ReactFlowState): string {
	return state.panZoom && state.width > 0 && state.height > 0
		? `${state.width}x${state.height}`
		: "";
}

/** The legend, zoom controls and mini map, as boxes relative to the canvas. */
function overlayRects(wrapper: HTMLElement): GraphRect[] {
	const origin = wrapper.getBoundingClientRect();
	const rects: GraphRect[] = [];
	for (const panel of wrapper.querySelectorAll<HTMLElement>(
		".react-flow__panel"
	)) {
		const rect = panel.getBoundingClientRect();
		if (rect.width > 0 && rect.height > 0) {
			rects.push({
				height: rect.height,
				width: rect.width,
				x: rect.left - origin.left,
				y: rect.top - origin.top,
			});
		}
	}
	return rects;
}

/** A first viewport before the canvas is measured, from the window size. */
function initialViewport(nodes: readonly GraphNode[]): {
	x: number;
	y: number;
	zoom: number;
} {
	if (typeof window === "undefined") {
		return { x: 0, y: 0, zoom: 1 };
	}
	return (
		frameViewport(
			{
				allNodes: nodes,
				focusIds: [],
				height: window.innerHeight,
				overlays: [],
				width: window.innerWidth,
			},
			FRAME_LIMITS
		) ?? { x: 0, y: 0, zoom: 1 }
	);
}

/** Pixels of the map that may sit past an edge before the mini map shows. */
const OFFSCREEN_SLACK = 24;

function GraphFlow({
	context,
	describedBy,
	edges,
	frameIds,
	graphNodes,
	layoutKey,
	nodes,
	stats,
}: GraphCanvasProps) {
	const flow = useReactFlow<GraphFlowNode, GraphFlowEdge>();
	const canvasSize = useStore(selectCanvasSize);
	const reducedMotion = usePrefersReducedMotion();
	const duration = reducedMotion ? 0 : 350;
	const wrapperRef = useRef<HTMLDivElement>(null);
	// Painted from the first frame at a best guess (the window size), so the
	// map never sits invisible while React Flow measures the canvas.
	const [defaultViewport] = useState(() => initialViewport(graphNodes));
	const framedRef = useRef(false);
	const lastFrameRef = useRef<string | null>(null);
	/** The user panned or zoomed; a plain resize then leaves their view be. */
	const userMovedRef = useRef(false);
	/** The canvas size the current frame was computed for. */
	const framedSizeRef = useRef("");
	const frameKey = frameIds.join("|");
	const panelOpen = layoutKey !== "map";
	const allBounds = useMemo(
		() => graphBounds(graphNodes, new Set()),
		[graphNodes]
	);
	// The mini map only earns its place once part of the map is off-screen.
	const selectOffscreen = useCallback(
		(state: ReactFlowState) => {
			if (!allBounds || state.width === 0) {
				return false;
			}
			const [panX, panY, zoom] = state.transform;
			const left = panX + allBounds.x * zoom;
			const top = panY + allBounds.y * zoom;
			const right = left + allBounds.width * zoom;
			const bottom = top + allBounds.height * zoom;
			return (
				left < -OFFSCREEN_SLACK ||
				top < -OFFSCREEN_SLACK ||
				right > state.width + OFFSCREEN_SLACK ||
				bottom > state.height + OFFSCREEN_SLACK
			);
		},
		[allBounds]
	);
	const offscreen = useStore(selectOffscreen);

	// Frames nodes clear of the legend, zoom controls and mini map. The canvas
	// size is read from the DOM at the moment of framing, never from React
	// Flow's store, which only learns of a resize a frame later: a panel
	// opening would otherwise frame the map for the old, wider canvas.
	const frame = useCallback(
		(ids: readonly string[], frameDuration: number) => {
			const wrapper = wrapperRef.current;
			if (!wrapper) {
				return;
			}
			const { height, width } = wrapper.getBoundingClientRect();
			const viewport = frameViewport(
				{
					allNodes: graphNodes,
					focusIds: ids,
					height,
					overlays: overlayRects(wrapper),
					width,
				},
				FRAME_LIMITS
			);
			if (viewport) {
				framedSizeRef.current = `${Math.round(width)}x${Math.round(height)}`;
				flow.setViewport(viewport, { duration: frameDuration });
			}
		},
		[flow, graphNodes]
	);

	// Re-frame when the focus or the space around the map changes: the whole
	// map by default, the selection and its neighbors when something is picked.
	// The very first exact frame is instant, so the map never glides in.
	useEffect(() => {
		if (!canvasSize) {
			return;
		}
		const key = `${frameKey}#${layoutKey}`;
		const changed = lastFrameRef.current !== key;
		if (!changed && userMovedRef.current) {
			return;
		}
		// A panel opening or closing resizes the canvas in one step, so the
		// map lands in its new frame at once rather than gliding from a frame
		// that no longer fits; picks within one layout still glide.
		const layoutChanged =
			lastFrameRef.current !== null &&
			!lastFrameRef.current.endsWith(`#${layoutKey}`);
		lastFrameRef.current = key;
		userMovedRef.current = false;
		const ids = frameKey ? frameKey.split("|") : [];
		if (!framedRef.current) {
			frame(ids, 0);
			framedRef.current = true;
			return;
		}
		const handle = window.requestAnimationFrame(() =>
			frame(ids, layoutChanged || !changed ? 0 : duration)
		);
		return () => window.cancelAnimationFrame(handle);
	}, [canvasSize, duration, frame, frameKey, layoutKey]);

	// Any later change in the canvas size (a panel settling, the window
	// resizing) refits the current frame unless the user moved the map.
	const frameKeyRef = useRef(frameKey);
	frameKeyRef.current = frameKey;
	useEffect(() => {
		const wrapper = wrapperRef.current;
		if (!wrapper || typeof ResizeObserver === "undefined") {
			return;
		}
		let handle = 0;
		const observer = new ResizeObserver(() => {
			window.cancelAnimationFrame(handle);
			handle = window.requestAnimationFrame(() => {
				const { height, width } = wrapper.getBoundingClientRect();
				const size = `${Math.round(width)}x${Math.round(height)}`;
				if (
					!framedRef.current ||
					userMovedRef.current ||
					size === framedSizeRef.current
				) {
					return;
				}
				const key = frameKeyRef.current;
				frame(key ? key.split("|") : [], 0);
			});
		});
		observer.observe(wrapper);
		return () => {
			window.cancelAnimationFrame(handle);
			observer.disconnect();
		};
	}, [frame]);

	const { onNodeFocus: onFocusChange } = context;
	const onNodeFocus = useCallback(
		(nodeId: string) => {
			onFocusChange(nodeId);
			const node = flow.getNode(nodeId);
			const bounds = wrapperRef.current?.getBoundingClientRect();
			if (!(node && bounds)) {
				return;
			}
			const point = flow.flowToScreenPosition(node.position);
			const margin = 48;
			const visible =
				point.x > bounds.left + margin &&
				point.x < bounds.right - margin &&
				point.y > bounds.top + margin &&
				point.y < bounds.bottom - margin;
			if (!visible) {
				userMovedRef.current = true;
				flow.setCenter(node.position.x, node.position.y, {
					duration,
					zoom: flow.getZoom(),
				});
			}
		},
		[duration, flow, onFocusChange]
	);
	const value = useMemo(
		() => ({ ...context, onNodeFocus }),
		[context, onNodeFocus]
	);
	const onFit = useCallback(() => {
		userMovedRef.current = false;
		frame([], duration);
	}, [duration, frame]);
	const onZoom = useCallback(() => {
		userMovedRef.current = true;
	}, []);

	return (
		<GraphMapContext.Provider value={value}>
			<div
				className={cn(
					"@container relative size-full",
					panelOpen ? EDGE_FADE_PANEL : EDGE_FADE
				)}
				ref={wrapperRef}
			>
				<ReactFlow<GraphFlowNode, GraphFlowEdge>
					aria-describedby={describedBy}
					aria-label="Map of who works with whom"
					aria-roledescription="relationship map"
					className="text-foreground"
					defaultViewport={defaultViewport}
					disableKeyboardA11y
					edges={edges}
					edgesFocusable={false}
					edgeTypes={GRAPH_EDGE_TYPES}
					elementsSelectable={false}
					maxZoom={MAX_ZOOM}
					minZoom={MIN_ZOOM}
					nodeOrigin={[0.5, 0.5]}
					nodes={nodes}
					nodesConnectable={false}
					nodesDraggable={false}
					nodesFocusable={false}
					nodeTypes={GRAPH_NODE_TYPES}
					onMoveStart={(event) => {
						// Programmatic moves (our framing) carry no input event.
						if (event) {
							userMovedRef.current = true;
						}
					}}
					proOptions={{ hideAttribution: true }}
					style={FLOW_THEME}
					zoomOnDoubleClick={false}
				>
					<Background
						color="color-mix(in oklab, var(--muted-foreground) 35%, transparent)"
						gap={24}
						size={1}
						variant={BackgroundVariant.Dots}
					/>
					<GraphLegend stats={stats} />
					<GraphZoomControls
						duration={duration}
						onFit={onFit}
						onZoom={onZoom}
					/>
					{panelOpen || !offscreen ? null : (
						<MiniMap<GraphFlowNode>
							ariaLabel="Mini map"
							bgColor="var(--background)"
							className="@max-[960px]:hidden overflow-hidden rounded-lg border border-border"
							maskColor="color-mix(in oklab, var(--muted) 85%, transparent)"
							nodeBorderRadius={6}
							nodeColor={minimapNodeColor}
							nodeComponent={MiniMapMark}
							pannable
							position="bottom-right"
							style={{ height: 110, width: 168 }}
							zoomable
						/>
					)}
				</ReactFlow>
			</div>
		</GraphMapContext.Provider>
	);
}

/** The pan/zoom map itself, wrapped in its own React Flow store. */
export function GraphCanvas(props: GraphCanvasProps) {
	return (
		<ReactFlowProvider>
			<GraphFlow {...props} />
		</ReactFlowProvider>
	);
}
