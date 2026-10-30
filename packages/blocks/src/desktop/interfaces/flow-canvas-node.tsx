import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { THREAD_STATUS_LABELS } from "@ryuhq/protocol/interfaces";
import { Plus, X } from "lucide-react";
import type { ReactNode } from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import { type FlowLayout, type FlowNode, nodeLabel } from "./flow-model.ts";
import {
	ConversationGlyph,
	FlowDot,
	OriginGlyph,
	TeamGlyph,
	toneLabel,
} from "./flow-parts.tsx";

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
export function HoverStub({
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
	const tl = useLiteralMessages();
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
				aria-label={open ? "Close menu" : tl("Connect to {name}", { name })}
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

function stubLabel(
	open: boolean,
	ownerId: string,
	layout: FlowLayout,
	tl: LiteralMessage
): string {
	if (open) {
		return "Close menu";
	}
	return ownerId === "origin"
		? "Start a conversation"
		: tl("Connect to {name}", { name: ownerLabel(layout, ownerId) });
}

function hasChildren(layout: FlowLayout, id: string): boolean {
	return layout.nodes.some((node) => node.parentId === id);
}

export function NodeButton({
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
	const tl = useLiteralMessages();
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
				aria-label={stubLabel(open, node.ownerId, layout, tl)}
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
				{tl("{count} more", { count: String(node.count) })}
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
