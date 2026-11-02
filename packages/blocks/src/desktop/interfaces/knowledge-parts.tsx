import { translate as tr } from "@ryu/i18n/lite";
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
	THREAD_STATUS_ORDER,
	type ThreadStatus,
} from "@ryuhq/protocol/interfaces";
import { Maximize, Minus, Plus } from "lucide-react";
import { Component, type ReactNode, useRef, useState } from "react";
import { threadStatusLabel } from "./interface-renderer.ts";
import {
	displayLabel,
	KIND_LABELS,
	type KnowledgeNode,
	type KnowledgeNodeKind,
} from "./knowledge-model.ts";
import { cssColor, type KnowledgePalette } from "./knowledge-palette.ts";

export {
	KnowledgeEmpty,
	KnowledgeSkeleton,
	type OutlinePaint,
	type SkeletonOutline,
} from "./knowledge-parts-loading.tsx";

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
					data-ryu-i18n="off"
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
						{threadStatusLabel(status)}
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
							{tr(
								"{label}, {kind, select, agent {agent} conversation {conversation} project {project} team {team} other {topic}}, {count, plural, one {# link} other {# links}}",
								{
									count: node.degree,
									kind: node.kind,
									label: displayLabel(node),
								}
							)}
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
