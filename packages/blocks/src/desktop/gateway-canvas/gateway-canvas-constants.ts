import type { FitViewOptions, ProOptions } from "@xyflow/react";
import type { CSSProperties, ReactNode } from "react";
import type { CanvasFeedState, GatewayCanvasAdapter } from "./model.ts";

// Module level so React Flow never sees new objects (spec 07.5, the
// getSnapshot loop guard).
export const PRO_OPTIONS: ProOptions = { hideAttribution: true };
export const FIT_VIEW_OPTIONS: FitViewOptions = { maxZoom: 1, padding: 0.06 };
export const FLOW_THEME = {
	"--xy-background-color": "transparent",
	"--xy-edge-stroke": "var(--border)",
	"--xy-node-border-radius": "var(--radius)",
} as CSSProperties;

/** Below this width the table is the default view and the panel stacks. */
export const NARROW_WIDTH = 640;
export const SWEEP_MS = 400;
/** The side panel's width plus its margins, in screen pixels. */
export const PANEL_CLEARANCE = 424;
export const EDGE_MARGIN = 24;

export const OVERLAY =
	"m-0 flex min-w-0 items-center rounded-lg border border-border bg-background p-0.5 text-foreground";
export const META = "text-xs";

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
