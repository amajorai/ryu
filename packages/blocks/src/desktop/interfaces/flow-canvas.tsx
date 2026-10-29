import { cn } from "@ryu/ui/lib/utils";
import { THREAD_STATUS_LABELS } from "@ryuhq/protocol/interfaces";
import { Inbox, Plus, X } from "lucide-react";
import { AnimatePresence, motion, type Transition } from "motion/react";
import type { ReactNode } from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import { FlowComposerNode } from "./flow-composer.tsx";
import {
	edgePath,
	type FlowChip,
	type FlowEdge,
	type FlowJoint,
	type FlowLayout,
	type FlowNode,
	type FlowTarget,
	nodeLabel,
} from "./flow-model.ts";
import {
	ConversationGlyph,
	FlowDot,
	OriginGlyph,
	TeamGlyph,
	toneLabel,
} from "./flow-parts.tsx";

/** A solid mid-tone line color derived from the theme, so overlaps never darken. */
export const FLOW_LINE_STYLE = {
	"--flow-line":
		"color-mix(in oklab, var(--muted-foreground) 55%, var(--background))",
	"--flow-lit": "color-mix(in oklab, var(--primary) 60%, var(--background))",
} as React.CSSProperties;

export interface FlowCanvasHandlers {
	onActivate: (node: FlowNode) => void;
	onCancelComposer: () => void;
	onChip: (chip: FlowChip) => void;
	onFocusNode: (id: string) => void;
	onSubmitComposer: (target: FlowTarget, prompt: string) => void;
}

interface FlowCanvasProps extends FlowCanvasHandlers {
	focusId: string | null;
	layout: FlowLayout;
	/** Stub whose menu is open. */
	menuFor: string | null;
	/** Opens the "Connect to" menu from a lead's hover stub. */
	onConnect: (ownerId: string) => void;
	/** Nodes from the origin to the selected node; their edges are tinted. */
	path: ReadonlySet<string>;
	reduceMotion: boolean;
	selectedId: string | null;
}

const ENTER = { opacity: 0, scale: 0.96 };

function transitionFor(reduceMotion: boolean): Transition {
	return reduceMotion
		? { duration: 0 }
		: { damping: 34, mass: 0.8, stiffness: 380, type: "spring" };
}

function Edges({
	edges,
	path,
	reduceMotion,
}: {
	edges: FlowEdge[];
	path: ReadonlySet<string>;
	reduceMotion: boolean;
}) {
	const transition = transitionFor(reduceMotion);
	const lit = path.size > 1 ? edges.filter((edge) => path.has(edge.to)) : [];
	return (
		<svg
			aria-hidden="true"
			className="pointer-events-none absolute top-0 left-0 overflow-visible"
			height="1"
			width="1"
		>
			<defs>
				<marker
					id="flow-arrow"
					markerHeight="8"
					markerUnits="userSpaceOnUse"
					markerWidth="8"
					orient="auto"
					refX="7"
					refY="4"
				>
					<path d="M 1 1 L 7 4 L 1 7 z" style={{ fill: "var(--flow-line)" }} />
				</marker>
				<marker
					id="flow-arrow-lit"
					markerHeight="8"
					markerUnits="userSpaceOnUse"
					markerWidth="8"
					orient="auto"
					refX="7"
					refY="4"
				>
					<path d="M 1 1 L 7 4 L 1 7 z" style={{ fill: "var(--flow-lit)" }} />
				</marker>
			</defs>
			<AnimatePresence initial={false}>
				{edges.map((edge) => {
					const d = edgePath(edge.points);
					return (
						<motion.path
							animate={{ d, opacity: 1 }}
							exit={{ opacity: 0 }}
							fill="none"
							initial={{ d, opacity: 0 }}
							key={edge.id}
							markerEnd={edge.arrow ? "url(#flow-arrow)" : undefined}
							strokeDasharray={edge.dashed ? "3 3" : undefined}
							strokeLinecap="round"
							strokeWidth={1.25}
							style={{ stroke: "var(--flow-line)" }}
							transition={transition}
						/>
					);
				})}
			</AnimatePresence>
			{/* The open path, traced over the shared bus in the accent. */}
			<AnimatePresence initial={false}>
				{lit.map((edge) => {
					const d = edgePath(edge.points);
					return (
						<motion.path
							animate={{ d, opacity: 1 }}
							data-flow-lit=""
							exit={{ opacity: 0 }}
							fill="none"
							initial={{ d, opacity: 0 }}
							key={edge.id}
							markerEnd={edge.arrow ? "url(#flow-arrow-lit)" : undefined}
							strokeDasharray={edge.dashed ? "3 3" : undefined}
							strokeLinecap="round"
							strokeWidth={1.25}
							style={{ stroke: "var(--flow-lit)" }}
							transition={transition}
						/>
					);
				})}
			</AnimatePresence>
		</svg>
	);
}

/**
 * A connector's count of what waits on you. It rides the same spring as the
 * nodes, so it never drifts off its line while the flow reflows.
 */
function Chip({
	chip,
	onChip,
	transition,
}: {
	chip: FlowChip;
	onChip: (chip: FlowChip) => void;
	transition: Transition;
}) {
	return (
		<motion.button
			animate={{ opacity: 1, x: chip.x, y: chip.y }}
			aria-label={`Review next: ${chip.description}`}
			className="group/chip absolute top-0 left-0 outline-none"
			data-flow-chip=""
			exit={{ opacity: 0 }}
			initial={{ opacity: 0, x: chip.x, y: chip.y }}
			onClick={() => onChip(chip)}
			// Reached by pointer; the keyboard path is the node itself.
			tabIndex={-1}
			title={`${chip.description}. Open the next one.`}
			transition={transition}
			type="button"
		>
			<span
				className={cn(
					"flex h-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center gap-1 rounded-[5px] border border-[var(--flow-line)] bg-background px-1.5 font-medium text-[11px] text-foreground tabular-nums leading-none transition-colors group-hover/chip:border-foreground/40 group-focus-visible/chip:ring-2 group-focus-visible/chip:ring-ring/40"
				)}
			>
				<Inbox aria-hidden="true" className="size-3 stroke-[1.75]" />
				<span aria-hidden="true">{chip.label}</span>
			</span>
		</motion.button>
	);
}

/** The quiet round glyph a connector shows when nothing waits behind it. */
function Joint({
	joint,
	transition,
}: {
	joint: FlowJoint;
	transition: Transition;
}) {
	return (
		<motion.span
			animate={{ opacity: 1, x: joint.x, y: joint.y }}
			aria-hidden="true"
			className="pointer-events-none absolute top-0 left-0"
			exit={{ opacity: 0 }}
			initial={{ opacity: 0, x: joint.x, y: joint.y }}
			transition={transition}
		>
			<span className="flex size-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-[var(--flow-line)] bg-background">
				<span className="size-1 rounded-full bg-[var(--flow-line)]" />
			</span>
		</motion.span>
	);
}

const NODE_SURFACE =
	"rounded-lg border bg-card text-foreground shadow-xs ring-[3px] outline-none transition-[border-color,box-shadow,background-color] duration-150";

/** Roving focus: an offset ring, unmistakable yet distinct from selection. */
const NODE_FOCUS =
	"focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

function nodeSurface(selected: boolean, onPath: boolean): string {
	if (selected) {
		return cn(NODE_SURFACE, "border-primary ring-primary/15", NODE_FOCUS);
	}
	return cn(
		NODE_SURFACE,
		onPath ? "border-primary/40" : "border-border",
		"ring-foreground/[0.035] hover:border-foreground/25",
		NODE_FOCUS
	);
}

/** The small square where a line leaves a node, like a port on a diagram. */
function Port({ lit }: { lit: boolean }) {
	return (
		<span
			aria-hidden="true"
			className="absolute top-1/2 -right-[3.5px] size-1.5 -translate-y-1/2 rounded-[1.5px]"
			style={{ backgroundColor: lit ? "var(--flow-lit)" : "var(--flow-line)" }}
		/>
	);
}

/**
 * The dotted "+" that hangs off a lead's port on hover or focus, as on the
 * reference canvas: it opens the lead's "Connect to" menu without moving rows.
 */
function HoverStub({
	name,
	onConnect,
	open,
	pinned,
}: {
	name: string;
	onConnect: () => void;
	open: boolean;
	/** Shown without hover: the lead is selected or its menu is open. */
	pinned: boolean;
}) {
	return (
		<span
			className={cn(
				"pointer-events-none absolute top-1/2 left-full h-[38px] w-[52px] opacity-0 transition-opacity duration-150 group-focus-within/node:pointer-events-auto group-focus-within/node:opacity-100 group-hover/node:pointer-events-auto group-hover/node:opacity-100",
				(open || pinned) && "pointer-events-auto opacity-100"
			)}
		>
			<span
				aria-hidden="true"
				className="absolute top-0 left-0 h-7 w-8 rounded-bl-[6px] border-[var(--flow-line)] border-b border-l border-dashed"
			/>
			<button
				aria-expanded={open}
				aria-haspopup="menu"
				aria-label={open ? "Close menu" : `Connect to ${name}`}
				className="absolute top-[18px] left-8 flex size-5 items-center justify-center rounded-[5px] bg-primary text-primary-foreground shadow-xs outline-none transition-[filter] hover:brightness-110 focus-visible:ring-[3px] focus-visible:ring-ring/40"
				data-flow-hover-stub=""
				onClick={onConnect}
				// Tab reaches the selected lead's stub, the keyboard way into its
				// "Connect to" menu; the rest stay pointer-only.
				tabIndex={open || pinned ? 0 : -1}
				type="button"
			>
				{open ? (
					<X aria-hidden="true" className="size-3 stroke-[2.25]" />
				) : (
					<Plus aria-hidden="true" className="size-3.5 stroke-[2.25]" />
				)}
			</button>
		</span>
	);
}

function NodeBody({ node }: { node: FlowNode }): ReactNode {
	switch (node.kind) {
		case "agent":
			return (
				<>
					<BoardAvatar
						agent={node.agent}
						className="size-5"
						name={node.agent.name}
						size={20}
					/>
					<span className="min-w-0 flex-1 truncate font-medium">
						{node.agent.name}
					</span>
					<FlowDot tone={node.tone} />
				</>
			);
		case "team":
			return (
				<>
					<span className="flex size-5 items-center justify-center rounded-[5px] bg-muted">
						<TeamGlyph className="size-3 text-foreground/70" />
					</span>
					<span className="min-w-0 flex-1 truncate font-medium">
						{node.group.name}
					</span>
					<FlowDot tone={node.tone} />
				</>
			);
		case "lane":
			return (
				<span className="min-w-0 flex-1 truncate text-muted-foreground">
					{node.label}
				</span>
			);
		case "thread":
			return (
				<>
					<ConversationGlyph />
					<span className="min-w-0 flex-1 truncate">
						{node.thread.title.trim() || "Untitled conversation"}
					</span>
					<FlowDot tone={node.status} />
				</>
			);
		default:
			return null;
	}
}

function ownerLabel(layout: FlowLayout, ownerId: string): string {
	const owner = layout.nodes.find((item) => item.id === ownerId);
	if (owner?.kind === "agent") {
		return owner.agent.name;
	}
	if (owner?.kind === "team") {
		return owner.group.name;
	}
	return "";
}

function stubLabel(open: boolean, ownerId: string, layout: FlowLayout): string {
	if (open) {
		return "Close menu";
	}
	return ownerId === "origin"
		? "Start a conversation"
		: `Connect to ${ownerLabel(layout, ownerId)}`;
}

function hasChildren(layout: FlowLayout, id: string): boolean {
	return layout.nodes.some((node) => node.parentId === id);
}

function NodeButton({
	focusId,
	layout,
	menuFor,
	node,
	onActivate,
	onFocusNode,
	path,
	selectedId,
}: {
	focusId: string | null;
	layout: FlowLayout;
	menuFor: string | null;
	node: FlowNode;
	onActivate: (node: FlowNode) => void;
	onFocusNode: (id: string) => void;
	path: ReadonlySet<string>;
	selectedId: string | null;
}) {
	const selected = selectedId === node.id;
	const onPath = !selected && path.size > 1 && path.has(node.id);
	const common = {
		"data-flow-node": node.id,
		onClick: () => onActivate(node),
		onFocus: () => onFocusNode(node.id),
		tabIndex: focusId === node.id ? 0 : -1,
		type: "button" as const,
	};
	const statusLabel = (status: keyof typeof THREAD_STATUS_LABELS) =>
		THREAD_STATUS_LABELS[status];
	if (node.kind === "origin") {
		return (
			<button
				{...common}
				aria-label="You: overview"
				aria-pressed={selected}
				className="group relative flex size-full items-center justify-center rounded-full outline-none"
			>
				<span
					className={cn(
						"flex size-10 items-center justify-center rounded-full border bg-background text-foreground transition-[border-color,box-shadow] duration-150",
						selected && "border-primary ring-[3px] ring-primary/15",
						onPath && "border-primary/40",
						!(selected || onPath) &&
							"border-[var(--flow-line)] group-hover:border-foreground/40",
						"group-focus-visible:ring-2 group-focus-visible:ring-ring group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-background"
					)}
				>
					<OriginGlyph />
				</span>
				<span className="absolute top-full mt-1.5 font-medium text-muted-foreground text-xs uppercase tracking-[0.12em]">
					You
				</span>
			</button>
		);
	}
	if (node.kind === "stub") {
		const open = menuFor === node.ownerId;
		return (
			<button
				{...common}
				aria-expanded={open}
				aria-haspopup="menu"
				aria-label={stubLabel(open, node.ownerId, layout)}
				className="flex size-full items-center justify-center rounded-[5px] bg-primary text-primary-foreground shadow-xs outline-none transition-[filter,box-shadow] hover:brightness-110 focus-visible:ring-[3px] focus-visible:ring-ring/40"
			>
				{open ? (
					<X aria-hidden="true" className="size-3 stroke-[2.25]" />
				) : (
					<Plus aria-hidden="true" className="size-3.5 stroke-[2.25]" />
				)}
			</button>
		);
	}
	if (node.kind === "more") {
		return (
			<button
				{...common}
				aria-label={nodeLabel(node, statusLabel)}
				className="flex size-full items-center justify-center rounded-md border border-border border-dashed bg-background text-muted-foreground text-xs outline-none transition-colors hover:border-foreground/30 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
			>
				{node.count} more
			</button>
		);
	}
	if (node.kind === "lane") {
		return (
			<button
				{...common}
				aria-label={nodeLabel(node, statusLabel)}
				aria-pressed={selected}
				className={cn(
					"relative flex size-full items-center gap-2 rounded-lg border border-dashed px-3 text-left text-[13px] outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
					selected && "border-primary",
					onPath && "border-primary/40",
					!(selected || onPath) &&
						"border-[var(--flow-line)] hover:border-foreground/40"
				)}
			>
				<NodeBody node={node} />
				<Port lit={path.size > 1 && (selected || onPath)} />
			</button>
		);
	}
	const kindLabel =
		node.kind === "agent" || node.kind === "team"
			? `${nodeLabel(node, statusLabel)}, ${toneLabel(node.tone)}`
			: nodeLabel(node, statusLabel);
	return (
		<button
			{...common}
			aria-label={kindLabel}
			aria-pressed={selected}
			className={cn(
				"relative flex size-full items-center gap-2 px-3 text-left text-[13px]",
				nodeSurface(selected, onPath)
			)}
		>
			<NodeBody node={node} />
			{node.kind !== "thread" && hasChildren(layout, node.id) ? (
				<Port lit={path.size > 1 && (selected || onPath)} />
			) : null}
		</button>
	);
}

/** Everything in world space: lines, connector chips, and nodes. */
export function FlowCanvas({
	focusId,
	layout,
	menuFor,
	onActivate,
	onCancelComposer,
	onChip,
	onConnect,
	onFocusNode,
	onSubmitComposer,
	path,
	reduceMotion,
	selectedId,
}: FlowCanvasProps) {
	const transition = transitionFor(reduceMotion);
	const stubOwners = new Set(
		layout.nodes.flatMap((node) => (node.kind === "stub" ? [node.ownerId] : []))
	);
	return (
		<>
			<Edges edges={layout.edges} path={path} reduceMotion={reduceMotion} />
			<AnimatePresence initial={false}>
				{layout.nodes.map((node) => (
					<motion.div
						animate={{
							opacity: 1,
							scale: 1,
							x: node.x,
							y: node.y - node.h / 2,
						}}
						className="group/node absolute top-0 left-0"
						exit={{ opacity: 0, scale: 0.96 }}
						initial={{ ...ENTER, x: node.x, y: node.y - node.h / 2 }}
						key={node.id}
						style={{ height: node.h, width: node.w }}
						transition={transition}
					>
						{node.kind === "composer" ? (
							<FlowComposerNode
								id={node.id}
								onCancel={onCancelComposer}
								onFocusNode={onFocusNode}
								onSubmit={(prompt) => onSubmitComposer(node.target, prompt)}
								target={node.target}
							/>
						) : (
							<NodeButton
								focusId={focusId}
								layout={layout}
								menuFor={menuFor}
								node={node}
								onActivate={onActivate}
								onFocusNode={onFocusNode}
								path={path}
								selectedId={selectedId}
							/>
						)}
						{(node.kind === "agent" || node.kind === "team") &&
						!stubOwners.has(node.id) ? (
							<HoverStub
								name={node.kind === "agent" ? node.agent.name : node.group.name}
								onConnect={() => onConnect(node.id)}
								open={menuFor === node.id}
								pinned={selectedId === node.id}
							/>
						) : null}
					</motion.div>
				))}
			</AnimatePresence>
			{/* Chips follow the nodes so Tab enters the canvas at "You". */}
			<AnimatePresence initial={false}>
				{layout.joints.map((joint) => (
					<Joint joint={joint} key={joint.id} transition={transition} />
				))}
				{layout.chips.map((chip) => (
					<Chip
						chip={chip}
						key={chip.id}
						onChip={onChip}
						transition={transition}
					/>
				))}
			</AnimatePresence>
		</>
	);
}
