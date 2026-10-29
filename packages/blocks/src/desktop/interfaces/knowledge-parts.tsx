import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
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
	THREAD_STATUS_LABELS,
	THREAD_STATUS_ORDER,
	type ThreadStatus,
} from "@ryuhq/protocol/interfaces";
import { Maximize, Minus, Plus, SquarePen } from "lucide-react";
import { Component, type ReactNode, useRef, useState } from "react";
import {
	displayLabel,
	KIND_LABELS,
	type KnowledgeNode,
	type KnowledgeNodeKind,
} from "./knowledge-model.ts";
import { cssColor, type KnowledgePalette } from "./knowledge-palette.ts";

/** One label per node, placed every frame by the renderer. */
export function KnowledgeLabels({
	nodes,
	register,
}: {
	nodes: readonly KnowledgeNode[];
	register: (id: string, element: HTMLElement | null) => void;
}) {
	return (
		<div
			aria-hidden="true"
			className="pointer-events-none absolute inset-0 overflow-hidden"
		>
			{nodes.map((node) => (
				<span
					className={cn(
						"absolute top-0 left-0 @max-[640px]/knowledge:max-w-32 max-w-56 truncate whitespace-nowrap text-[13px] leading-[18px] opacity-0 transition-opacity duration-100 will-change-transform [-webkit-text-stroke:3px_var(--knowledge-halo)] [paint-order:stroke_fill] [text-shadow:0_0_3px_var(--knowledge-halo)] data-[full=true]:max-w-[calc(100cqw-24px)]! motion-reduce:transition-none",
						node.kind === "conversation"
							? "text-foreground/75 data-[forced=true]:text-foreground"
							: "font-medium text-foreground"
					)}
					data-kind={node.kind}
					key={node.id}
					ref={(element) => register(node.id, element)}
				>
					{displayLabel(node)}
				</span>
			))}
		</div>
	);
}

/**
 * A status mark in the graph's own colours (so the panel, legend and canvas
 * agree): a filled disc, or a hollow ring for conversations not started.
 */
export function KnowledgeStatusDot({
	palette,
	status,
}: {
	palette: KnowledgePalette;
	status: ThreadStatus;
}) {
	const color = cssColor(palette.status[status]);
	return (
		<span
			aria-hidden="true"
			className={cn(
				"inline-block size-2 shrink-0 rounded-full",
				status === "quiet" && "border-[1.5px]"
			)}
			style={
				status === "quiet"
					? { borderColor: cssColor(palette.neutral) }
					: { backgroundColor: color }
			}
		/>
	);
}

function LegendItem({
	children,
	className,
	swatch,
}: {
	children: ReactNode;
	className?: string;
	swatch: ReactNode;
}) {
	return (
		<li className={cn("flex h-4 shrink-0 items-center gap-1.5", className)}>
			<span className="flex h-2.5 shrink-0 items-center justify-center">
				{swatch}
			</span>
			{children}
		</li>
	);
}

function Disc({ color, large }: { color: string; large?: boolean }) {
	return (
		<span
			aria-hidden="true"
			className={cn("shrink-0 rounded-full", large ? "size-2.5" : "size-2")}
			style={{ backgroundColor: color }}
		/>
	);
}

/**
 * The agent mark as the graph draws it: a disc with a hairline cut inside
 * (the cut is what sets agents apart; each agent's own tint shows on the
 * graph and beside its name in the panel).
 */
function AgentSwatch({ palette }: { palette: KnowledgePalette }) {
	return (
		<span
			aria-hidden="true"
			className="flex size-2.5 shrink-0 items-center justify-center rounded-full bg-foreground/60"
		>
			<span
				className="size-1.5 rounded-full border"
				style={{ borderColor: cssColor(palette.background) }}
			/>
		</span>
	);
}

/**
 * On a narrow stage the shape entries (agent, hub) drop out, since size and
 * the agent's cut already say what those nodes are; every status colour
 * stays explained.
 */
const SHAPE_ENTRY = "@max-[1040px]/stage:hidden";

/**
 * What the marks mean, for what is on the graph now: agents (their tints),
 * hubs, topics, then the conversation statuses present. One line, on a
 * strip of the canvas colour so links passing beneath never cross the text.
 */
export function KnowledgeLegend({
	agents,
	kinds,
	layout = "row",
	palette,
	statuses,
}: {
	agents: readonly string[];
	kinds: ReadonlySet<KnowledgeNodeKind>;
	/** One line over the canvas, or a column (inside the legend popover). */
	layout?: "list" | "row";
	palette: KnowledgePalette;
	statuses: ReadonlySet<ThreadStatus>;
}) {
	const row = layout === "row";
	const shapeEntry = row ? SHAPE_ENTRY : undefined;
	return (
		<ul
			aria-label="Legend"
			className={cn(
				"pointer-events-auto text-[13px] leading-5",
				row
					? "-ms-1.5 flex h-6 flex-nowrap items-center gap-x-3 overflow-hidden whitespace-nowrap rounded-md bg-(--knowledge-halo)/85 px-1.5 text-muted-foreground"
					: "flex flex-col gap-2 text-foreground"
			)}
		>
			{kinds.has("agent") && agents.length > 0 ? (
				<LegendItem
					className={shapeEntry}
					swatch={<AgentSwatch palette={palette} />}
				>
					Agent
				</LegendItem>
			) : null}
			{kinds.has("project") || kinds.has("team") ? (
				<LegendItem
					className={shapeEntry}
					swatch={<Disc color={cssColor(palette.hub)} large />}
				>
					{kinds.has("project") && kinds.has("team")
						? "Project or team"
						: KIND_LABELS[kinds.has("project") ? "project" : "team"]}
				</LegendItem>
			) : null}
			{kinds.has("topic") ? (
				<LegendItem swatch={<Disc color={cssColor(palette.topic)} />}>
					Topic
				</LegendItem>
			) : null}
			{THREAD_STATUS_ORDER.filter((status) => statuses.has(status)).map(
				(status) => (
					<LegendItem
						key={status}
						swatch={<KnowledgeStatusDot palette={palette} status={status} />}
					>
						{THREAD_STATUS_LABELS[status]}
					</LegendItem>
				)
			)}
		</ul>
	);
}

/**
 * The legend folded into a button, for stages too narrow for the row: every
 * entry stays one click away instead of dropping out.
 */
export function KnowledgeLegendButton(
	props: Omit<Parameters<typeof KnowledgeLegend>[0], "layout">
) {
	return (
		<Popover>
			<PopoverTrigger
				render={
					<Button
						className="pointer-events-auto bg-background/95 text-foreground/80 shadow-sm"
						size="xs"
						type="button"
						variant="outline"
					/>
				}
			>
				Legend
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className="w-auto min-w-44 rounded-lg border-border bg-background p-3 shadow-md backdrop-blur-none"
				side="top"
				sideOffset={6}
			>
				<KnowledgeLegend {...props} layout="list" />
			</PopoverContent>
		</Popover>
	);
}

/**
 * An icon button with a tooltip that follows focus strictly: it opens on
 * hover or keyboard focus and closes the moment either leaves.
 */
export function HintButton({
	children,
	className,
	label,
	onClick,
	shortcut,
	side = "top",
	size = "icon-sm",
}: {
	children: ReactNode;
	className?: string;
	label: string;
	onClick: () => void;
	shortcut?: string;
	side?: "bottom" | "left" | "top";
	size?: "icon-sm" | "icon-xs";
}) {
	const [open, setOpen] = useState(false);
	// The tooltip may only open while the button is hovered or focused: a
	// delayed open that lands after focus moved on is dropped.
	const engaged = useRef({ focus: false, hover: false });
	const onOpenChange = (next: boolean) =>
		setOpen(next && (engaged.current.focus || engaged.current.hover));
	return (
		<Tooltip onOpenChange={onOpenChange} open={open}>
			<TooltipTrigger
				render={
					<Button
						aria-label={label}
						className={cn(
							"text-foreground/80 hover:text-foreground",
							className
						)}
						onBlur={() => {
							engaged.current.focus = false;
							setOpen(false);
						}}
						onClick={onClick}
						onFocus={() => {
							engaged.current.focus = true;
						}}
						onPointerEnter={() => {
							engaged.current.hover = true;
						}}
						onPointerLeave={() => {
							engaged.current.hover = false;
							setOpen(false);
						}}
						size={size}
						type="button"
						variant="ghost"
					/>
				}
			>
				{children}
			</TooltipTrigger>
			<TooltipContent side={side}>
				{label}
				{shortcut ? (
					<span className="text-muted-foreground">{shortcut}</span>
				) : null}
			</TooltipContent>
		</Tooltip>
	);
}

export function KnowledgeZoom({
	onFit,
	onZoom,
}: {
	onFit: () => void;
	onZoom: (factor: number) => void;
}) {
	return (
		<div
			aria-label="Zoom"
			className="pointer-events-auto flex items-center gap-0.5 rounded-lg border border-border bg-background/95 p-0.5 shadow-sm"
			role="toolbar"
		>
			<HintButton
				className="rounded-md"
				label="Zoom out"
				onClick={() => onZoom(1.35)}
				shortcut="−"
			>
				<Minus aria-hidden="true" className="size-4" />
			</HintButton>
			<HintButton
				className="rounded-md"
				label="Zoom in"
				onClick={() => onZoom(0.74)}
				shortcut="+"
			>
				<Plus aria-hidden="true" className="size-4" />
			</HintButton>
			<HintButton
				className="rounded-md"
				label="Fit graph"
				onClick={onFit}
				shortcut="0"
			>
				<Maximize aria-hidden="true" className="size-3.5" />
			</HintButton>
		</div>
	);
}

/**
 * Every visible node as a button, for screen readers (the canvas itself is
 * one keyboard-driven application region). Off the tab order: sighted
 * keyboard users move through the graph with the arrow keys instead.
 */
export function KnowledgeNodeList({
	nodes,
	onSelect,
	selectedId,
}: {
	nodes: readonly KnowledgeNode[];
	onSelect: (id: string) => void;
	selectedId: string | null;
}) {
	return (
		<nav aria-label="Graph nodes" className="sr-only">
			<ul>
				{nodes.map((node) => (
					<li key={node.id}>
						<button
							aria-current={node.id === selectedId ? "true" : undefined}
							onClick={() => onSelect(node.id)}
							tabIndex={-1}
							type="button"
						>
							{`${displayLabel(node)}, ${KIND_LABELS[node.kind].toLowerCase()}, ${node.degree} ${node.degree === 1 ? "link" : "links"}`}
						</button>
					</li>
				))}
			</ul>
		</nav>
	);
}

/**
 * Keeps a failing WebGL view (context creation, shader compile) from taking
 * the interface down: the host switches to the 2D renderer instead.
 */
// biome-ignore lint/style/useReactFunctionComponents: error boundaries must be class components
export class KnowledgeSceneBoundary extends Component<
	{ children: ReactNode; onError: () => void },
	{ failed: boolean }
> {
	state = { failed: false };

	static getDerivedStateFromError() {
		return { failed: true };
	}

	componentDidCatch() {
		this.props.onError();
	}

	render() {
		return this.state.failed ? null : this.props.children;
	}
}

/** Loose node positions and radii (100 x 60 box) for the loading state. */
const LOADING_NODES: readonly [number, number, number][] = [
	[50, 30, 1.6],
	[36, 22, 1.2],
	[63, 19, 1.2],
	[66, 37, 1.2],
	[40, 40, 1],
	[27, 31, 0.6],
	[47, 14, 0.6],
	[76, 27, 0.6],
	[56, 47, 0.6],
	[30, 47, 0.6],
];
const LOADING_LINKS: readonly [number, number][] = [
	[0, 1],
	[0, 2],
	[0, 3],
	[0, 4],
	[1, 5],
	[1, 6],
	[2, 6],
	[2, 7],
	[3, 7],
	[3, 8],
	[4, 9],
];

/** The graph as it will first draw: screen points, links and stage size. */
export interface SkeletonOutline {
	height: number;
	links: readonly [number, number][];
	/** Per node: x, y and disc radius in stage pixels. */
	nodes: readonly [number, number, number][];
	/**
	 * The graph's own colours, when known: the outline is then a still
	 * preview of the first frame rather than a pulsing placeholder.
	 */
	paint?: OutlinePaint;
	width: number;
}

export interface OutlinePaint {
	/** Per node: drawn with the agent's inner cut. */
	agents: readonly boolean[];
	/** The canvas colour (the agent cut). */
	background: string;
	link: string;
	/** Per node CSS colour. */
	nodes: readonly string[];
}

/** The agent cut, as the renderers draw it (fraction of the disc). */
const PREVIEW_AGENT_CUT = 0.62;

function OutlinePreview({
	links,
	nodes,
	paint,
}: {
	links: readonly [number, number][];
	nodes: readonly [number, number, number][];
	paint: OutlinePaint;
}) {
	return (
		<>
			<g stroke={paint.link} strokeWidth={1}>
				{links.map(([from, to]) => {
					const a = nodes[from];
					const b = nodes[to];
					return a && b ? (
						<line
							key={`${from}-${to}`}
							x1={a[0]}
							x2={b[0]}
							y1={a[1]}
							y2={b[1]}
						/>
					) : null;
				})}
			</g>
			{nodes.map(([x, y, radius], index) => {
				const cut = Math.max(1.25, radius * 0.1);
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: preview nodes are positional and never reorder.
					<g key={index}>
						<circle cx={x} cy={y} fill={paint.nodes[index]} r={radius} />
						{paint.agents[index] && radius >= 4 ? (
							<circle
								cx={x}
								cy={y}
								fill="none"
								r={radius * PREVIEW_AGENT_CUT + cut / 2}
								stroke={paint.background}
								strokeWidth={cut}
							/>
						) : null}
					</g>
				);
			})}
		</>
	);
}

function OutlineShape({
	links,
	nodes,
	strokeWidth,
}: {
	links: readonly [number, number][];
	nodes: readonly [number, number, number][];
	strokeWidth: number;
}) {
	return (
		<>
			<g className="stroke-foreground/15" strokeWidth={strokeWidth}>
				{links.map(([from, to]) => {
					const a = nodes[from];
					const b = nodes[to];
					return a && b ? (
						<line
							key={`${from}-${to}`}
							x1={a[0]}
							x2={b[0]}
							y1={a[1]}
							y2={b[1]}
						/>
					) : null;
				})}
			</g>
			<g className="fill-foreground/15">
				{nodes.map(([x, y, radius], index) => (
					<circle
						cx={x}
						cy={y}
						// biome-ignore lint/suspicious/noArrayIndexKey: outline nodes are positional and never reorder.
						key={index}
						r={radius}
					/>
				))}
			</g>
		</>
	);
}

/**
 * The graph's outline while it loads. Once the layout exists (the WebGL view
 * is still starting), `outline` is that layout projected through the very
 * pose the 3D view opens with and painted in the graph's colours, so the
 * first frame shows at once and the 3D view cross-fades in over it; before
 * that (workspace loading) it is a loose, pulsing generic graph.
 */
export function KnowledgeSkeleton({
	outline,
}: {
	outline: SkeletonOutline | null;
}) {
	if (outline?.paint) {
		return (
			<svg
				aria-hidden="true"
				className="absolute inset-0 size-full"
				data-knowledge-preview=""
				fill="none"
				viewBox={`0 0 ${Math.max(1, outline.width)} ${Math.max(1, outline.height)}`}
			>
				<OutlinePreview
					links={outline.links}
					nodes={outline.nodes}
					paint={outline.paint}
				/>
			</svg>
		);
	}
	if (outline) {
		return (
			<svg
				aria-hidden="true"
				className="absolute inset-0 size-full animate-skeleton motion-reduce:animate-none"
				fill="none"
				viewBox={`0 0 ${Math.max(1, outline.width)} ${Math.max(1, outline.height)}`}
			>
				<OutlineShape
					links={outline.links}
					nodes={outline.nodes}
					strokeWidth={1}
				/>
			</svg>
		);
	}
	return (
		<div
			aria-hidden="true"
			className="absolute inset-0 flex items-center justify-center p-16"
		>
			<svg
				className="aspect-[5/3] max-h-full w-full max-w-3xl animate-skeleton motion-reduce:animate-none"
				fill="none"
				preserveAspectRatio="xMidYMid meet"
				viewBox="20 8 64 44"
			>
				<OutlineShape
					links={LOADING_LINKS}
					nodes={LOADING_NODES}
					strokeWidth={0.15}
				/>
			</svg>
		</div>
	);
}

export function KnowledgeEmpty({ onStart }: { onStart: () => void }) {
	return (
		<Empty className="pointer-events-auto max-w-md flex-none p-6">
			<svg
				aria-hidden="true"
				className="mb-1 h-12 w-24 text-muted-foreground"
				fill="none"
				viewBox="0 0 96 48"
			>
				<g opacity="0.45" stroke="currentColor" strokeWidth="1">
					<line x1="20" x2="48" y1="30" y2="16" />
					<line x1="48" x2="76" y1="16" y2="32" />
					<line x1="48" x2="50" y1="16" y2="40" />
				</g>
				<g fill="currentColor">
					<circle cx="48" cy="16" opacity="0.8" r="6" />
					<circle cx="20" cy="30" opacity="0.5" r="4" />
					<circle cx="76" cy="32" opacity="0.5" r="4" />
					<circle cx="50" cy="40" opacity="0.35" r="3" />
				</g>
			</svg>
			<EmptyHeader>
				<EmptyTitle className="text-base">Nothing to graph yet</EmptyTitle>
				<EmptyDescription>
					Agents, projects, teams and conversations appear here as linked nodes,
					with shared topics drawn from conversation titles.
				</EmptyDescription>
			</EmptyHeader>
			<EmptyContent>
				<Button onClick={onStart} size="sm" type="button">
					<SquarePen aria-hidden="true" data-icon="inline-start" />
					New conversation
				</Button>
			</EmptyContent>
		</Empty>
	);
}
