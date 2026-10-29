import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceAgent,
	THREAD_STATUS_LABELS,
} from "@ryuhq/protocol/interfaces";
import { Minus, Plus } from "lucide-react";
import { motion } from "motion/react";
import type {
	CSSProperties,
	KeyboardEvent,
	MouseEvent,
	PointerEvent,
} from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import { BoardStatusDot } from "./board-status.tsx";
import {
	groupKindLabel,
	MINDMAP_HEIGHT,
	MINDMAP_THREAD_MAX_WIDTH,
	type MindmapNode,
	type MindmapPlaced,
	type MindmapPoint,
	plural,
} from "./mindmap-model.ts";
import { mindmapBranchColor } from "./mindmap-palette.ts";

/** One easing for every structural move: unfold, fold, relayout. */
export const MINDMAP_EASE = [0.22, 0.8, 0.24, 1] as const;

export interface MindmapNodeEvents {
	onActivate: (node: MindmapNode, event: MouseEvent<HTMLElement>) => void;
	onDoubleActivate: (node: MindmapNode) => void;
	onFocusNode: (node: MindmapNode) => void;
	onHover: (nodeId: string | null) => void;
	onKeyDown: (node: MindmapNode, event: KeyboardEvent<HTMLElement>) => void;
}

function nodeLabel(
	node: MindmapNode,
	agent: InterfaceAgent | undefined,
	age: string,
	tl: LiteralMessage
): string {
	switch (node.kind) {
		case "root":
			return `You, ${plural(node.threadCount, "thread")}${node.urgentCount > 0 ? `, ${node.urgentCount} need you` : ""}`;
		case "group":
			return `${node.label}, ${groupKindLabel(node.groupKind)}, ${plural(node.threadCount, "thread")}${node.urgentCount > 0 ? `, ${node.urgentCount} need you` : ""}`;
		case "agent": {
			const state = agent?.status === "working" ? ", working" : "";
			return `${node.label}${state}, ${plural(node.threadCount, "thread")}${node.urgentCount > 0 ? `, ${node.urgentCount} need you` : ""}`;
		}
		case "thread": {
			const status = node.status ? THREAD_STATUS_LABELS[node.status] : "";
			return [node.label, status, age].filter(Boolean).join(", ");
		}
		default:
			return tl("Show {label} threads", { label: node.label });
	}
}

const BASE =
	"absolute top-0 left-0 flex select-none items-center whitespace-nowrap outline-none transition-[background-color,color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

const KIND_CLASS: Record<MindmapNode["kind"], string> = {
	agent:
		"h-7 gap-2 rounded-md bg-foreground/[0.06] pr-2.5 pl-1 font-medium text-foreground text-sm leading-5 hover:bg-foreground/10",
	group:
		"h-8 items-end rounded-md px-1 pb-1.5 font-semibold text-base text-foreground leading-5 hover:bg-foreground/[0.06]",
	more: "h-6 cursor-pointer items-start rounded-md px-1 pt-0.5 text-[13px] text-muted-foreground leading-5 hover:bg-foreground/[0.06] hover:text-foreground",
	root: "h-11 rounded-xl bg-foreground px-5 font-semibold text-background text-base leading-5",
	thread:
		"h-6 cursor-pointer items-start gap-1.5 rounded-md px-1 pt-0.5 text-sm leading-5 hover:bg-foreground/[0.06]",
};

const THREAD_MAX_STYLE: CSSProperties = {
	maxWidth: MINDMAP_THREAD_MAX_WIDTH,
};

export function MindmapNodeView({
	active,
	age,
	agent,
	animate,
	fresh,
	events,
	expanded,
	node,
	origin,
	placed,
	posInSet,
	selected,
	setSize,
	tabStop,
}: {
	/** The thread open in the panel. */
	active: boolean;
	age: string;
	agent: InterfaceAgent | undefined;
	animate: boolean;
	/** True on the render a node first appears (it grows from `origin`). */
	fresh: boolean;
	events: MindmapNodeEvents;
	expanded: boolean | undefined;
	node: MindmapNode;
	/** The parent's anchor: where the node grows from and folds back into. */
	origin: MindmapPoint | null;
	placed: MindmapPlaced;
	posInSet: number;
	selected: boolean;
	setSize: number;
	tabStop: boolean;
}) {
	const tl = useLiteralMessages();
	const transition = animate
		? { duration: 0.24, ease: MINDMAP_EASE }
		: { duration: 0 };
	const muted = node.status === "quiet";
	// Folded away, a node sits on its parent's anchor, its inner edge first.
	const tucked = origin
		? {
				x: node.side === "left" ? origin.x - placed.width : origin.x,
				y: origin.y - MINDMAP_HEIGHT[node.kind] / 2,
			}
		: null;
	const marked =
		node.kind === "thread" &&
		(node.status === "attention" ||
			node.status === "your-turn" ||
			node.status === "working");
	return (
		<motion.div
			animate={{ opacity: 1, x: placed.x, y: placed.y }}
			aria-current={active ? "true" : undefined}
			aria-expanded={expanded}
			aria-label={nodeLabel(node, agent, age, tl)}
			aria-level={node.depth + 1}
			aria-posinset={posInSet}
			aria-selected={selected}
			aria-setsize={setSize}
			className={cn(
				BASE,
				KIND_CLASS[node.kind],
				node.kind === "thread" &&
					(muted ? "text-muted-foreground" : "text-foreground"),
				active && "bg-primary/10 text-foreground hover:bg-primary/15",
				selected &&
					!active &&
					node.kind !== "root" &&
					"ring-1 ring-ring/50 ring-offset-2 ring-offset-background"
			)}
			data-mindmap-node={node.id}
			data-selected={selected || undefined}
			exit={
				tucked
					? { ...tucked, opacity: 0, transition }
					: { opacity: 0, transition: { duration: animate ? 0.12 : 0 } }
			}
			initial={fresh && tucked ? { ...tucked, opacity: 0 } : false}
			onClick={(event) => events.onActivate(node, event)}
			onDoubleClick={() => events.onDoubleActivate(node)}
			onFocus={() => events.onFocusNode(node)}
			onKeyDown={(event) => events.onKeyDown(node, event)}
			onPointerEnter={() => events.onHover(node.id)}
			onPointerLeave={() => events.onHover(null)}
			role="treeitem"
			style={node.kind === "thread" ? THREAD_MAX_STYLE : undefined}
			tabIndex={tabStop ? 0 : -1}
			title={node.kind === "thread" ? node.label : undefined}
			transition={transition}
		>
			{node.kind === "agent" ? (
				<BoardAvatar agent={agent} name={node.label} size={20} />
			) : null}
			{marked && node.status ? (
				<BoardStatusDot className="mt-1.5" status={node.status} />
			) : null}
			<span className={cn(node.kind === "thread" && "min-w-0 truncate")}>
				{node.label}
			</span>
			{node.kind === "agent" && node.working ? (
				<BoardStatusDot status="working" />
			) : null}
		</motion.div>
	);
}

const HANDLE =
	"flex h-4 min-w-4 items-center justify-center rounded-full border-[1.5px] bg-background outline-none transition-opacity duration-150 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring";

/**
 * The controls at a node's outer end: the fold circle (a count while folded,
 * a minus while open) and, for agents and branches, "+" for a new thread.
 * Open-state controls only show while the node is hovered or selected.
 */
export function MindmapHandles({
	animate,
	collapsed,
	foldLabel,
	node,
	onHover,
	onStart,
	onToggle,
	point,
	revealed,
	startLabel,
}: {
	animate: boolean;
	collapsed: boolean;
	/** Null when the node has nothing to fold. */
	foldLabel: string | null;
	node: MindmapNode;
	onHover: (nodeId: string | null) => void;
	onStart: (() => void) | null;
	onToggle: () => void;
	point: MindmapPoint;
	revealed: boolean;
	startLabel: string;
}) {
	const count = node.threadCount > 0 ? node.threadCount : node.childIds.length;
	const transition = animate
		? { duration: 0.24, ease: MINDMAP_EASE }
		: { duration: 0 };
	return (
		<motion.div
			animate={{ x: point.x, y: point.y }}
			className="absolute top-0 left-0"
			data-mindmap-handle={node.id}
			initial={false}
			transition={transition}
		>
			<div
				className={cn(
					"absolute top-0 flex -translate-y-1/2 items-center gap-1",
					node.side === "left" ? "right-0.75 flex-row-reverse" : "left-0.75"
				)}
				onPointerEnter={(event: PointerEvent<HTMLElement>) => {
					event.stopPropagation();
					onHover(node.id);
				}}
				onPointerLeave={() => onHover(null)}
			>
				{foldLabel ? (
					<button
						aria-expanded={!collapsed}
						aria-label={foldLabel}
						className={cn(
							HANDLE,
							collapsed
								? "px-1 font-semibold text-[10px] text-foreground tabular-nums leading-none"
								: "text-muted-foreground hover:text-foreground",
							!(collapsed || revealed) && "opacity-0"
						)}
						onClick={onToggle}
						style={{ borderColor: mindmapBranchColor(node.branch) }}
						tabIndex={-1}
						type="button"
					>
						{collapsed ? (
							count
						) : (
							<Minus
								aria-hidden="true"
								className="size-2.5"
								strokeWidth={2.5}
							/>
						)}
					</button>
				) : null}
				{onStart ? (
					<button
						aria-label={startLabel}
						className={cn(
							HANDLE,
							"border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground",
							!revealed && "opacity-0"
						)}
						onClick={onStart}
						tabIndex={-1}
						type="button"
					>
						<Plus aria-hidden="true" className="size-2.5" strokeWidth={2.5} />
					</button>
				) : null}
			</div>
		</motion.div>
	);
}
