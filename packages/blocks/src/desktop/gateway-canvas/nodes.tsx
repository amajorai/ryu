"use client";

// Gateway canvas nodes: one accessible button per node, its live counters
// read from the canvas store so a traffic tick re-renders only that node.

import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import {
	Cable,
	Cloud,
	Filter,
	Lock,
	type LucideIcon,
	Server,
	ShieldCheck,
	Waypoints,
} from "lucide-react";
import {
	createContext,
	type DragEvent,
	type KeyboardEvent,
	type MouseEvent,
	useContext,
	useState,
	useSyncExternalStore,
} from "react";
import { carriesPolicy, POLICY_DRAG_TYPE } from "./assign.tsx";
import { CANVAS_NODE_HEIGHT, CANVAS_NODE_WIDTH } from "./layout.ts";
import type { CanvasLiveStore } from "./live-store.ts";
import {
	type CanvasHealth,
	type CanvasNode,
	type CanvasNodeCounters,
	type CanvasNodeKind,
	carriesRequests,
	formatCount,
	HEALTH_LABELS,
	NODE_KIND_LABELS,
} from "./model.ts";

export interface CanvasFlowNodeData extends Record<string, unknown> {
	node: CanvasNode;
}

export type CanvasFlowNode = Node<CanvasFlowNodeData, "gateway-canvas">;

export interface CanvasContextValue {
	/** Whether a palette policy can be dropped on this node. */
	acceptsDrop(node: CanvasNode): boolean;
	/** The feed has numbers; without one, nodes draw no counts at all. */
	counted: boolean;
	/** A palette policy is being dragged, so drop targets are marked. */
	dragging: boolean;
	dropPolicy(nodeId: string, policyId: string): void;
	onNodeKeyDown(id: string, event: KeyboardEvent<HTMLButtonElement>): void;
	select(id: string, fromKeyboard: boolean): void;
	selectedId: string | null;
	store: CanvasLiveStore;
}

export const CanvasContext = createContext<CanvasContextValue | null>(null);

function useCanvas(): CanvasContextValue {
	const value = useContext(CanvasContext);
	if (!value) {
		throw new Error("Gateway canvas nodes render inside GatewayCanvas.");
	}
	return value;
}

/** One node's counters, re-rendering only when that node changes. */
export function useNodeCounters(
	store: CanvasLiveStore,
	id: string
): CanvasNodeCounters {
	return useSyncExternalStore(
		(listener) => store.subscribeNode(id, listener),
		() => store.counters(id),
		() => store.counters(id)
	);
}

export const KIND_ICON: Record<CanvasNodeKind, LucideIcon> = {
	gateway: Server,
	infra: Waypoints,
	provider: Cloud,
	scope: ShieldCheck,
	stage: Filter,
	surface: Cable,
};

const HEALTH_DOT: Record<CanvasHealth, string> = {
	degraded: "bg-warning",
	down: "bg-destructive",
	ok: "bg-success",
};

export function HealthDot({ health }: { health: CanvasHealth }) {
	return (
		<span
			aria-hidden="true"
			className={cn("size-1.5 shrink-0 rounded-full", HEALTH_DOT[health])}
		/>
	);
}

/** "1.2k requests, 3 blocked" for a node's accessible name and table. */
export function countersPhrase(counters: CanvasNodeCounters): string {
	const parts = [`${formatCount(counters.requests)} requests`];
	if (counters.blocked > 0) {
		parts.push(`${formatCount(counters.blocked)} blocked`);
	}
	if (typeof counters.p50Ms === "number") {
		parts.push(`median ${Math.round(counters.p50Ms)} ms`);
	}
	return parts.join(", ");
}

export function nodeAccessibleName(
	node: CanvasNode,
	counters: CanvasNodeCounters | null
): string {
	const parts = [node.label, NODE_KIND_LABELS[node.kind]];
	if (node.locked) {
		parts.push("locked");
	}
	if (node.health && node.health !== "ok") {
		parts.push(HEALTH_LABELS[node.health].toLowerCase());
	}
	if (counters) {
		parts.push(countersPhrase(counters));
	}
	return parts.join(", ");
}

const HIDDEN_HANDLE =
	"!pointer-events-none !size-px !min-h-0 !min-w-0 !border-0 !bg-transparent !opacity-0";

function GatewayCanvasNode({ data }: NodeProps<CanvasFlowNode>) {
	const { node } = data;
	const canvas = useCanvas();
	const counters = useNodeCounters(canvas.store, node.id);
	const tl = useLiteralMessages();
	const counted = canvas.counted && carriesRequests(node);
	const Icon = KIND_ICON[node.kind];
	const selected = canvas.selectedId === node.id;
	const accepts = canvas.acceptsDrop(node);
	const [over, setOver] = useState(false);
	const onDragOver = (event: DragEvent<HTMLButtonElement>) => {
		if (!(accepts && carriesPolicy(event))) {
			return;
		}
		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
		setOver(true);
	};
	return (
		<>
			<Handle
				className={HIDDEN_HANDLE}
				position={Position.Left}
				type="target"
			/>
			<Handle
				className={HIDDEN_HANDLE}
				position={Position.Right}
				type="source"
			/>
			<button
				aria-label={nodeAccessibleName(node, counted ? counters : null)}
				aria-pressed={selected}
				className={cn(
					"nodrag nopan flex flex-col justify-center gap-0.5 rounded-lg border bg-card px-3 text-left text-card-foreground shadow-xs transition-colors",
					"outline-none hover:border-ring/60 focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
					selected ? "border-primary ring-1 ring-primary" : "border-border",
					node.kind === "infra" && "border-dashed",
					accepts && canvas.dragging && "border-primary/60 border-dashed",
					over && "border-primary bg-primary/10"
				)}
				data-canvas-drop={accepts ? "" : undefined}
				data-canvas-node={node.id}
				onClick={(event: MouseEvent<HTMLButtonElement>) =>
					canvas.select(node.id, event.detail === 0)
				}
				onDragEnter={onDragOver}
				onDragLeave={() => setOver(false)}
				onDragOver={onDragOver}
				onDrop={(event) => {
					setOver(false);
					if (!(accepts && carriesPolicy(event))) {
						return;
					}
					event.preventDefault();
					const policyId = event.dataTransfer.getData(POLICY_DRAG_TYPE);
					if (policyId) {
						canvas.dropPolicy(node.id, policyId);
					}
				}}
				onKeyDown={(event) => canvas.onNodeKeyDown(node.id, event)}
				style={{ height: CANVAS_NODE_HEIGHT, width: CANVAS_NODE_WIDTH }}
				type="button"
			>
				<span className="flex min-w-0 items-center gap-1.5">
					<Icon
						aria-hidden="true"
						className="size-3.5 shrink-0 text-muted-foreground"
					/>
					<span className="min-w-0 flex-1 truncate font-medium text-xs">
						{node.label}
					</span>
					{node.locked ? (
						<Lock
							aria-hidden="true"
							className="size-3 shrink-0 text-muted-foreground"
						/>
					) : null}
					{node.health ? <HealthDot health={node.health} /> : null}
				</span>
				{node.detail ? (
					<span className="truncate text-[11px] text-muted-foreground leading-tight">
						{node.detail}
					</span>
				) : null}
				{counted ? (
					<span className="flex items-center gap-2 text-[11px] text-muted-foreground tabular-nums leading-tight">
						<span>
							{tl("{requests} req", {
								requests: formatCount(counters.requests),
							})}
						</span>
						{counters.blocked > 0 ? (
							<span className="text-destructive">
								{tl("{blocked} blocked", {
									blocked: formatCount(counters.blocked),
								})}
							</span>
						) : null}
						{typeof counters.p50Ms === "number" ? (
							<span>{Math.round(counters.p50Ms)} ms</span>
						) : null}
					</span>
				) : null}
			</button>
		</>
	);
}

/** Module level, so React Flow never sees a new map (spec 07.5). */
export const CANVAS_NODE_TYPES = { "gateway-canvas": GatewayCanvasNode };
