// The relationship map's overlays: the theme-native zoom controls, the
// legend bar, and the mini map's marks and colors. Split from
// `graph-canvas.tsx`, which owns framing and the React Flow mount.

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
import type { GraphNode } from "@ryuhq/protocol/interfaces";
import {
	type MiniMapNodeProps,
	Panel,
	useReactFlow,
	useViewport,
} from "@xyflow/react";
import { Maximize, Minus, Plus } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import type { GraphFlowNode } from "./graph-nodes.tsx";
import { GraphStatusDot, TEXT_META } from "./graph-parts.tsx";
import { threadStatusLabel } from "./interface-renderer.ts";

/** React Flow's own chrome variables, pointed at the user's theme tokens. */
export const FLOW_THEME = {
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

export function minimapNodeColor(node: GraphFlowNode): string {
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
export function GraphZoomControls({
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
		label: threadStatusLabel("working"),
		mark: <GraphStatusDot status="working" />,
	},
	{
		label: threadStatusLabel("your-turn"),
		mark: <GraphStatusDot status="your-turn" />,
	},
	{
		label: threadStatusLabel("attention"),
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
export function GraphLegend({ stats }: { stats: string }) {
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
export function MiniMapMark({
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
