import { translate as tr } from "@ryu/i18n/lite";
import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type {
	GraphEdge,
	GraphNode,
	InterfaceAgent,
	ThreadStatus,
} from "@ryuhq/protocol/interfaces";
import {
	type Edge,
	Handle,
	type Node,
	type NodeProps,
	type NodeTypes,
	Position,
	type ReactFlowState,
	useStore,
} from "@xyflow/react";
import {
	type CSSProperties,
	createContext,
	type FocusEvent,
	type KeyboardEvent,
	type MouseEvent,
	useContext,
} from "react";
import type { GraphEmphasis } from "./graph-model.ts";
import {
	GROUP_ICON,
	GraphAvatar,
	GraphStatusDot,
	TEXT_BODY,
	TEXT_META,
} from "./graph-parts.tsx";
import { agentSubLabel, labelScale, labelTransform } from "./graph-view.ts";

export { GRAPH_EDGE_TYPES } from "./graph-edges.tsx";

export interface GraphMapContextValue {
	emphasis: (nodeId: string) => GraphEmphasis;
	/** Keep a node in view when keyboard focus lands on it. */
	onNodeFocus: (nodeId: string) => void;
	/** Arrow keys move focus to the nearest node in that direction. */
	onNodeKeyDown: (
		nodeId: string,
		event: KeyboardEvent<HTMLButtonElement>
	) => void;
	/** `keyboard` is true when Enter/Space (not a pointer) picked the node. */
	select: (nodeId: string, keyboard: boolean) => void;
	selectedId: string | null;
	/** The one node in the tab order (the map is a single tab stop). */
	tabStopId: string;
}

export const GraphMapContext = createContext<GraphMapContextValue>({
	emphasis: () => "normal",
	onNodeFocus: () => undefined,
	onNodeKeyDown: () => undefined,
	select: () => undefined,
	selectedId: null,
	tabStopId: "you",
});

export type GraphFlowNode = Node<{
	agent?: InterfaceAgent;
	node: GraphNode;
	/** The most urgent status among the node's threads. */
	urgent: ThreadStatus | null;
	/** How many of the node's threads wait on the user's reply. */
	yourTurn: number;
}>;

export type GraphFlowEdge = Edge<{
	emphasis: GraphEmphasis;
	kind: GraphEdge["kind"];
	/** A talks spoke to an agent that is working right now. */
	live: boolean;
	/** False when the user asked for reduced motion. */
	motion: boolean;
	weight: number;
}>;
export type GraphEdgeData = NonNullable<GraphFlowEdge["data"]>;

/** Edges meet at node centers: one invisible source and target per node. */
const CENTER_HANDLE: CSSProperties = {
	background: "transparent",
	border: 0,
	height: 1,
	left: "50%",
	minHeight: 0,
	minWidth: 0,
	opacity: 0,
	pointerEvents: "none",
	top: "50%",
	transform: "translate(-50%, -50%)",
	width: 1,
};

function CenterHandles() {
	return (
		<>
			<Handle
				isConnectable={false}
				position={Position.Top}
				style={CENTER_HANDLE}
				type="target"
			/>
			<Handle
				isConnectable={false}
				position={Position.Top}
				style={CENTER_HANDLE}
				type="source"
			/>
		</>
	);
}

/**
 * Out-of-focus nodes step back without vanishing: pictures fade to 60% and
 * lose their color, names drop to the muted ink. Applied at once (no
 * transition), so a keyboard pick paints exactly like a pointer pick.
 */
const DIMMED_MARK = "opacity-60 grayscale";
const DIMMED_TEXT = "text-muted-foreground";

function threadCount(count: number): string {
	return tr("{count, plural, one {# thread} other {# threads}}", {
		count,
	});
}

/** Statuses worth calling out on the map itself (they need the user). */
function callout(urgent: ThreadStatus | null): ThreadStatus | null {
	return urgent === "attention" || urgent === "your-turn" ? urgent : null;
}

/** ", needs attention" / ", your turn" for a node's accessible name. */
function urgentPhrase(urgent: ThreadStatus | null): string {
	const status = callout(urgent);
	if (!status) {
		return "";
	}
	return status === "attention" ? tr(", needs attention") : tr(", your turn");
}

/** Shared button behavior: pointer vs keyboard selection, focus follow. */
function useNodeButton(nodeId: string) {
	const map = useContext(GraphMapContext);
	return {
		"aria-pressed": map.selectedId === nodeId,
		"data-graph-node": nodeId,
		emphasis: map.emphasis(nodeId),
		onClick: (event: MouseEvent<HTMLButtonElement>) =>
			// `detail` is 0 when Enter/Space activated the button.
			map.select(nodeId, event.detail === 0),
		onFocus: (_event: FocusEvent<HTMLButtonElement>) => map.onNodeFocus(nodeId),
		onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) =>
			map.onNodeKeyDown(nodeId, event),
		tabIndex: map.tabStopId === nodeId ? 0 : -1,
	};
}

const FOCUS_RING =
	"outline-none focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

function YouNode({ data }: NodeProps<GraphFlowNode>) {
	const tl = useLiteralMessages();
	const { emphasis, ...button } = useNodeButton(data.node.id);
	const scale = useStore(selectLabelScale);
	const { node } = data;
	// Zoomed out, the hub keeps just its name, grown like the other labels.
	const compact = scale > 1;
	return (
		<>
			<CenterHandles />
			<button
				{...button}
				aria-label={tl(
					"You: {count, plural, one {{countLabel} thread} other {{countLabel} threads}}. Show all threads",
					{ count: node.threadCount, countLabel: String(node.threadCount) }
				)}
				className={cn(
					"nodrag flex size-full cursor-pointer flex-col items-center justify-center gap-0.5 rounded-full bg-primary text-primary-foreground hover:bg-primary/90",
					emphasis === "focus" &&
						"ring-2 ring-primary ring-offset-2 ring-offset-background",
					FOCUS_RING
				)}
				type="button"
			>
				<span
					className={cn("font-semibold", TEXT_BODY)}
					style={compact ? { transform: `scale(${scale})` } : undefined}
				>
					You
				</span>
				{compact ? null : (
					<span className={cn("tabular-nums opacity-80", TEXT_META)}>
						{threadCount(node.threadCount)}
					</span>
				)}
			</button>
		</>
	);
}

/** Below this zoom the agent status line is too small to read, so it hides. */
const SUB_LABEL_MIN_ZOOM = 0.8;

function selectShowsSubLabel(state: ReactFlowState): boolean {
	return state.transform[2] >= SUB_LABEL_MIN_ZOOM;
}

/** How much names grow against the zoom, so they stay legible zoomed out. */
function selectLabelScale(state: ReactFlowState): number {
	return labelScale(state.transform[2]);
}

/**
 * A halo in the canvas color around the glyphs, so lines passing behind a
 * name stop short of it without boxing the label.
 */
const LABEL_HALO =
	"[text-shadow:0_0_2px_var(--background),0_0_2px_var(--background),0_0_4px_var(--background),0_0_4px_var(--background)]";

function AgentNode({ data }: NodeProps<GraphFlowNode>) {
	const { emphasis, ...button } = useNodeButton(data.node.id);
	const showSubLabel = useStore(selectShowsSubLabel);
	const scale = useStore(selectLabelScale);
	const { agent, node, urgent, yourTurn } = data;
	const working = node.status === "working";
	const sub = agentSubLabel({ urgent, working, yourTurn });
	const focused = emphasis === "focus";
	const dimmed = emphasis === "dimmed";
	return (
		<>
			<CenterHandles />
			<button
				{...button}
				aria-label={tr("{name}: {threads}{sub}", {
					name: node.label,
					sub: sub ? `, ${sub.spoken}` : "",
					threads: threadCount(node.threadCount),
				})}
				className={cn(
					"nodrag group/agent relative flex size-full cursor-pointer items-center justify-center rounded-full",
					FOCUS_RING
				)}
				type="button"
			>
				<span
					className={cn(
						"relative flex size-full items-center justify-center rounded-full bg-background",
						working ? "ring-2 ring-success" : "ring-1 ring-border",
						!(working || focused) && "group-hover/agent:ring-foreground/40",
						focused &&
							"ring-2 ring-primary ring-offset-2 ring-offset-background",
						dimmed && DIMMED_MARK
					)}
				>
					<GraphAvatar agent={agent} className="size-full" />
				</span>
				<span
					aria-hidden="true"
					className={cn(
						"pointer-events-none absolute top-full left-1/2 mt-2 flex flex-col items-center whitespace-nowrap",
						LABEL_HALO
					)}
					style={labelTransform(scale)}
				>
					<span
						className={cn(
							TEXT_BODY,
							focused ? "font-semibold" : "font-medium",
							dimmed ? DIMMED_TEXT : "text-foreground"
						)}
					>
						{node.label}
					</span>
					{sub?.text && showSubLabel && !dimmed ? (
						<span
							className={cn(
								"flex items-center gap-1.5",
								TEXT_META,
								sub.status === "attention"
									? "text-destructive"
									: "text-muted-foreground"
							)}
						>
							<GraphStatusDot status={sub.status} />
							{sub.text}
						</span>
					) : null}
				</span>
			</button>
		</>
	);
}

/**
 * Teams and projects read as labels on the map, not cards: a muted pill
 * sized to its name, centered on the node.
 */
function GroupNode({ data }: NodeProps<GraphFlowNode>) {
	const { emphasis, ...button } = useNodeButton(data.node.id);
	const scale = useStore(selectLabelScale);
	const { node, urgent } = data;
	const kind = node.kind === "project" ? "project" : "team";
	const Icon = GROUP_ICON[kind];
	const focused = emphasis === "focus";
	const dimmed = emphasis === "dimmed";
	return (
		<>
			<CenterHandles />
			<div className="flex size-full items-center justify-center">
				<button
					{...button}
					aria-label={tr(
						"{kind, select, project {Project} other {Team}} {name}: {threads}{urgent}",
						{
							kind,
							name: node.label,
							threads: threadCount(node.threadCount),
							urgent: urgentPhrase(urgent),
						}
					)}
					className={cn(
						"nodrag flex h-8 w-max max-w-full shrink-0 cursor-pointer items-center gap-2 rounded-md px-2.5 text-start",
						"bg-muted text-foreground hover:bg-accent hover:text-accent-foreground",
						focused &&
							"ring-2 ring-primary ring-offset-2 ring-offset-background",
						dimmed && DIMMED_TEXT,
						FOCUS_RING
					)}
					style={
						scale > 1
							? { transform: `scale(${scale})`, transformOrigin: "center" }
							: undefined
					}
					type="button"
				>
					<Icon
						aria-hidden="true"
						className={cn("size-3.5 shrink-0 text-muted-foreground")}
					/>
					<span
						aria-hidden="true"
						className={cn(
							"truncate",
							TEXT_BODY,
							focused ? "font-semibold" : "font-medium"
						)}
					>
						{node.label}
					</span>
					<span
						aria-hidden="true"
						className={cn(
							"shrink-0 tabular-nums",
							TEXT_META,
							"text-muted-foreground"
						)}
					>
						{node.threadCount}
					</span>
				</button>
			</div>
		</>
	);
}

export const GRAPH_NODE_TYPES: NodeTypes = {
	agent: AgentNode,
	project: GroupNode,
	team: GroupNode,
	you: YouNode,
};
