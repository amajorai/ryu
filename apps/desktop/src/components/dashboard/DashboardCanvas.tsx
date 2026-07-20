// The v2 infinite-canvas dashboard view (@xyflow/react). A free-form alternative
// to the v1 grid (DashboardGrid.tsx): widgets are draggable/resizable nodes on a
// pannable, zoomable plane with a minimap. v1 stays the default; the two views
// share the SAME widget renderer (WidgetCard) and the SAME live-state/SSE feed —
// HomePage owns `widgets`/`live` and hands both views identical props, so this file
// never re-implements the data layer. Canvas position/size persists per widget via
// the additive `canvas` layout field, leaving the grid arrangement untouched.
//
// base.css is imported once in index.css (see the WorkflowCanvas note there); the
// controls reuse the shared `.workflow-controls` styling.

import {
	Background,
	Controls,
	MiniMap,
	type Node,
	type NodeProps,
	NodeResizer,
	type NodeTypes,
	Panel,
	ReactFlow,
	ReactFlowProvider,
	useNodesState,
	useReactFlow,
} from "@xyflow/react";
import { PlusIcon } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import type { CanvasLayoutRect, Widget } from "@/src/lib/api/dashboard.ts";
import type { WidgetLiveState } from "./DashboardGrid.tsx";
import { WidgetCard } from "./WidgetCard.tsx";

// The pixel size of one grid cell when deriving an initial canvas rect from a
// widget's grid layout. MUST mirror `ryu_dashboards::CANVAS_CELL` so a widget with
// no explicit canvas position lands where Core's derivation says it should.
const CANVAS_CELL = 100;
// Default size for a widget dropped fresh onto the canvas (no grid history).
const DEFAULT_NODE_W = 320;
const DEFAULT_NODE_H = 240;
const PERSIST_DEBOUNCE_MS = 500;
const MIN_NODE_W = 160;
const MIN_NODE_H = 120;

/** The concrete canvas rect for a widget: its stored `canvas`, else derived from
 *  the grid layout exactly as Core's `CanvasLayout::from_grid` does. */
function rectFor(widget: Widget): CanvasLayoutRect {
	if (widget.canvas) {
		return widget.canvas;
	}
	return {
		x: widget.layout.x * CANVAS_CELL,
		y: widget.layout.y * CANVAS_CELL,
		w: widget.layout.w * CANVAS_CELL,
		h: widget.layout.h * CANVAS_CELL,
	};
}

interface WidgetNodeData {
	error?: string | null;
	onRefresh: () => void;
	onRemove: () => void;
	/** Persist this node's current geometry (called on drag/resize settle). */
	persist: () => void;
	value: unknown;
	widget: Widget;
	[key: string]: unknown;
}

type WidgetNode = Node<WidgetNodeData, "widget">;

/** One widget as a canvas node: the shared WidgetCard wrapped with a NodeResizer.
 *  The card fills the node box; resizing/ dragging persist via `data.persist`. */
function WidgetNodeView({ data, selected }: NodeProps<WidgetNode>) {
	return (
		<>
			<NodeResizer
				handleClassName="!size-2 !rounded-[3px] !border-background !bg-primary"
				isVisible={selected}
				lineClassName="!border-primary/40"
				minHeight={MIN_NODE_H}
				minWidth={MIN_NODE_W}
				onResizeEnd={() => data.persist()}
			/>
			<div className="h-full w-full">
				<WidgetCard
					error={data.error}
					onRefresh={data.onRefresh}
					onRemove={data.onRemove}
					value={data.value}
					widget={data.widget}
				/>
			</div>
		</>
	);
}

const NODE_TYPES: NodeTypes = { widget: WidgetNodeView };

export interface DashboardCanvasProps {
	/** Live value/error per widget id, from the SSE stream (same map the grid uses). */
	live: Record<string, WidgetLiveState>;
	/** Add a widget: HomePage opens the shared AddWidgetDialog. */
	onAddWidget: () => void;
	/** Persist a single widget's new canvas rect (debounced by the canvas). */
	onCanvasPersist: (widgetId: string, rect: CanvasLayoutRect) => void;
	onRefresh: (widgetId: string) => void;
	onRemove: (widgetId: string) => void;
	/** Report the current viewport centre (flow coords) so a newly-added widget can
	 *  land where the user is looking. */
	onViewportCenterChange?: (center: { x: number; y: number }) => void;
	widgets: Widget[];
}

function CanvasInner({
	widgets,
	live,
	onCanvasPersist,
	onRefresh,
	onRemove,
	onAddWidget,
	onViewportCenterChange,
}: DashboardCanvasProps) {
	const [nodes, setNodes, onNodesChange] = useNodesState<WidgetNode>([]);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const rf = useReactFlow();

	// Latest nodes, for reading a node's final geometry inside the debounced persist
	// without re-creating the callback on every drag frame.
	const nodesRef = useRef<WidgetNode[]>([]);
	useEffect(() => {
		nodesRef.current = nodes;
	}, [nodes]);

	// Per-widget debounce timers so a drag/resize gesture writes once on settle.
	const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
		new Map()
	);
	useEffect(() => {
		const timers = timersRef.current;
		return () => {
			for (const t of timers.values()) {
				clearTimeout(t);
			}
			timers.clear();
		};
	}, []);

	const persist = useCallback(
		(id: string) => {
			const node = nodesRef.current.find((n) => n.id === id);
			if (!node) {
				return;
			}
			const rect: CanvasLayoutRect = {
				x: node.position.x,
				y: node.position.y,
				w: node.width ?? DEFAULT_NODE_W,
				h: node.height ?? DEFAULT_NODE_H,
			};
			const timers = timersRef.current;
			const existing = timers.get(id);
			if (existing) {
				clearTimeout(existing);
			}
			timers.set(
				id,
				setTimeout(() => {
					timers.delete(id);
					onCanvasPersist(id, rect);
				}, PERSIST_DEBOUNCE_MS)
			);
		},
		[onCanvasPersist]
	);

	// Reconcile the incoming widgets/live into nodes. Existing nodes KEEP their
	// current position/size (the user's live geometry, and any drag not yet echoed
	// back through props), so an SSE value tick never snaps a widget back. New
	// widgets seed from their canvas rect (or the grid-derived fallback); removed
	// widgets drop.
	useEffect(() => {
		setNodes((prev) => {
			const byId = new Map(prev.map((n) => [n.id, n]));
			return widgets.map((w) => {
				const liveState = live[w.id];
				const value =
					liveState && liveState.value !== undefined
						? liveState.value
						: w.last_value;
				const error = liveState?.error ?? w.last_error;
				const data: WidgetNodeData = {
					widget: w,
					value,
					error,
					onRefresh: () => onRefresh(w.id),
					onRemove: () => onRemove(w.id),
					persist: () => persist(w.id),
				};
				const existing = byId.get(w.id);
				if (existing) {
					// Preserve live geometry; refresh only the render data.
					return { ...existing, data };
				}
				const rect = rectFor(w);
				return {
					id: w.id,
					type: "widget" as const,
					position: { x: rect.x, y: rect.y },
					width: rect.w,
					height: rect.h,
					data,
				};
			});
		});
	}, [widgets, live, onRefresh, onRemove, persist, setNodes]);

	// Report the viewport centre (in flow coords) so HomePage can place a new widget
	// where the user is looking. Fired on mount and after every pan/zoom settle.
	const reportCenter = useCallback(() => {
		if (!onViewportCenterChange) {
			return;
		}
		const el = containerRef.current;
		if (!el) {
			return;
		}
		const box = el.getBoundingClientRect();
		const center = rf.screenToFlowPosition({
			x: box.x + box.width / 2,
			y: box.y + box.height / 2,
		});
		onViewportCenterChange(center);
	}, [onViewportCenterChange, rf]);

	return (
		<div className="h-full w-full" ref={containerRef}>
			<ReactFlow
				deleteKeyCode={null}
				fitView
				fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
				maxZoom={2}
				minZoom={0.2}
				nodes={nodes}
				nodeTypes={NODE_TYPES}
				onInit={reportCenter}
				onMoveEnd={reportCenter}
				onNodeDragStop={(_e, node) => persist(node.id)}
				onNodesChange={onNodesChange}
				proOptions={{ hideAttribution: true }}
			>
				<Background />
				<Controls className="workflow-controls" showInteractive={false} />
				<MiniMap
					className="!bottom-2 !right-2 !rounded-lg !bg-muted/40"
					pannable
					zoomable
				/>
				<Panel position="top-right">
					<button
						className="flex items-center gap-1.5 rounded-lg border border-border/60 bg-popover/90 px-2.5 py-1.5 font-medium text-xs shadow-sm backdrop-blur transition-colors hover:bg-accent"
						onClick={onAddWidget}
						type="button"
					>
						<PlusIcon className="size-3.5" /> Add widget
					</button>
				</Panel>
			</ReactFlow>
		</div>
	);
}

/**
 * The infinite-canvas dashboard view. Wraps {@link CanvasInner} in a
 * ReactFlowProvider so the viewport-centre reporting can use `useReactFlow`.
 */
export function DashboardCanvas(props: DashboardCanvasProps) {
	// A stable provider per rendered canvas keeps its own viewport/selection state.
	return (
		<ReactFlowProvider>
			<CanvasInner {...props} />
		</ReactFlowProvider>
	);
}

// Re-exported so HomePage can mirror Core's derivation when seeding a new widget's
// canvas rect at the current viewport centre.
export { CANVAS_CELL, DEFAULT_NODE_H, DEFAULT_NODE_W };
