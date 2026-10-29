import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceAgent,
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { ArrowLeft, SquarePen, X } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode, RefObject } from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import { agentById, compactAge } from "./interface-renderer.ts";
import {
	displayLabel,
	KIND_LABELS,
	type KnowledgeGraph,
	type KnowledgeNode,
	type KnowledgeNodeKind,
	linkedEntities,
	linkedThreads,
	messageMentions,
	plural,
	statusCounts,
} from "./knowledge-model.ts";
import {
	agentColor,
	cssColor,
	type KnowledgePalette,
} from "./knowledge-palette.ts";
import { KnowledgeStatusDot } from "./knowledge-parts.tsx";
import { nodeColor } from "./knowledge-stage.ts";
import { useReducedMotion } from "./reduced-motion.ts";

/**
 * The side panel. For an agent, project, team or topic it lists the linked
 * conversations and the other nodes one hop away (each opens in place, like
 * following a link in Obsidian). For a conversation it frames the host's own
 * thread view; there is no second chat here.
 */

export type KnowledgePanelView =
	| { kind: "node"; node: KnowledgeNode }
	| {
			kind: "thread";
			origin: KnowledgeNode | null;
			thread: InterfaceThread | undefined;
	  };

/** Linked nodes in the panel, one section per kind. */
const LINK_GROUPS: readonly { kind: KnowledgeNodeKind; title: string }[] = [
	{ kind: "agent", title: "Agents" },
	{ kind: "project", title: "Projects" },
	{ kind: "team", title: "Teams" },
	{ kind: "topic", title: "Topics" },
];

const STATUS_SUMMARY: readonly ThreadStatus[] = [
	"attention",
	"your-turn",
	"working",
];

function Swatch({
	node,
	palette,
	snapshot,
}: {
	node: KnowledgeNode;
	palette: KnowledgePalette;
	snapshot: InterfaceSnapshot;
}) {
	if (node.kind === "agent") {
		return (
			<BoardAvatar
				agent={agentById(snapshot, node.refId)}
				name={node.label}
				size={20}
			/>
		);
	}
	if (node.kind === "conversation" && node.status) {
		return (
			<span className="flex size-5 items-center justify-center">
				<KnowledgeStatusDot palette={palette} status={node.status} />
			</span>
		);
	}
	return (
		<span
			aria-hidden="true"
			className="flex size-5 items-center justify-center"
		>
			<span
				className="size-2.5 rounded-full"
				style={{ backgroundColor: cssColor(nodeColor(node, palette)) }}
			/>
		</span>
	);
}

/**
 * The header's mark beside the name: an agent's avatar ringed in its node
 * colour (so the face and the node read as one), otherwise the node's dot.
 */
function NodeMark({
	agent,
	node,
	palette,
}: {
	agent: InterfaceAgent | undefined;
	node: KnowledgeNode;
	palette: KnowledgePalette;
}) {
	if (node.kind === "agent") {
		return (
			<span
				aria-hidden="true"
				className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full"
				data-knowledge-agent-ring=""
				style={{
					boxShadow: `inset 0 0 0 2px ${cssColor(agentColor(node.label, palette))}`,
				}}
			>
				<BoardAvatar agent={agent} name={node.label} size={24} />
			</span>
		);
	}
	return (
		<span
			aria-hidden="true"
			className="mt-0.5 flex size-8 shrink-0 items-center justify-center"
		>
			<span
				className="size-3 rounded-full"
				style={{ backgroundColor: cssColor(nodeColor(node, palette)) }}
			/>
		</span>
	);
}

function ThreadRow({
	note,
	now,
	onOpen,
	palette,
	thread,
}: {
	/** Why the row is here, when its title does not say (topic panels). */
	note?: string;
	now: number;
	onOpen: (threadId: string) => void;
	palette: KnowledgePalette;
	thread: InterfaceThread;
}) {
	const status = threadStatus(thread);
	if (note) {
		return (
			<li>
				<button
					aria-label={`Open ${thread.title}, ${THREAD_STATUS_LABELS[status]}, ${note.toLowerCase()}`}
					className="group flex w-full items-start gap-2.5 px-4 py-2 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
					onClick={() => onOpen(thread.id)}
					type="button"
				>
					<span className="flex size-5 shrink-0 items-center justify-center">
						<KnowledgeStatusDot palette={palette} status={status} />
					</span>
					<span className="flex min-w-0 flex-1 flex-col gap-0.5">
						<span className="truncate text-foreground text-sm leading-5">
							{thread.title}
						</span>
						<span className="text-muted-foreground text-xs leading-4">
							{note}
						</span>
					</span>
					<time
						className="shrink-0 text-muted-foreground text-xs tabular-nums leading-5"
						dateTime={thread.updatedAt}
					>
						{compactAge(thread.updatedAt, now)}
					</time>
				</button>
			</li>
		);
	}
	return (
		<li>
			<button
				aria-label={`Open ${thread.title}, ${THREAD_STATUS_LABELS[status]}`}
				className="group flex h-9 w-full items-center gap-2.5 px-4 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
				onClick={() => onOpen(thread.id)}
				type="button"
			>
				<span className="flex size-5 shrink-0 items-center justify-center">
					<KnowledgeStatusDot palette={palette} status={status} />
				</span>
				<span className="min-w-0 flex-1 truncate text-foreground text-sm">
					{thread.title}
				</span>
				<time
					className="shrink-0 text-muted-foreground text-xs tabular-nums"
					dateTime={thread.updatedAt}
				>
					{compactAge(thread.updatedAt, now)}
				</time>
			</button>
		</li>
	);
}

function SectionHeading({
	children,
	count,
}: {
	children: ReactNode;
	count: number;
}) {
	return (
		<h4 className="flex h-8 items-center gap-2 px-4 font-medium text-muted-foreground text-xs">
			{children}
			<span className="tabular-nums">{count}</span>
		</h4>
	);
}

function PanelFrame({
	children,
	label,
	testId,
	wide,
}: {
	children: ReactNode;
	label: string;
	testId: string;
	wide: boolean;
}) {
	const reduced = useReducedMotion();
	return (
		<motion.aside
			animate={{ opacity: 1, transform: "translateX(0px)" }}
			aria-label={label}
			className={cn(
				"absolute @min-[900px]/knowledge:relative inset-y-0 right-0 z-30 flex w-full min-w-0 flex-col border-border bg-background @min-[900px]/knowledge:shadow-none shadow-lg sm:w-[360px] sm:border-l",
				wide && "@min-[1200px]/knowledge:w-[480px] sm:w-[440px]"
			)}
			data-testid={testId}
			initial={reduced ? false : { opacity: 0, transform: "translateX(12px)" }}
			transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
		>
			{children}
		</motion.aside>
	);
}

export function KnowledgePanel({
	graph,
	headingRef,
	now,
	onBack,
	onClose,
	onNewThread,
	onOpenThread,
	onSelect,
	palette,
	snapshot,
	threadView,
	view,
}: {
	graph: KnowledgeGraph;
	headingRef: RefObject<HTMLHeadingElement | null>;
	now: number;
	onBack: () => void;
	onClose: () => void;
	onNewThread: (node: KnowledgeNode) => void;
	onOpenThread: (threadId: string) => void;
	onSelect: (id: string) => void;
	palette: KnowledgePalette;
	snapshot: InterfaceSnapshot;
	threadView: ReactNode | null;
	view: KnowledgePanelView;
}) {
	if (view.kind === "thread") {
		const { origin, thread } = view;
		const title = thread?.title ?? "New conversation";
		const agents = (thread?.agentIds ?? [])
			.map((agentId) => agentById(snapshot, agentId))
			.filter((agent) => agent !== undefined);
		return (
			<PanelFrame
				label={`Conversation: ${title}`}
				testId="knowledge-thread-panel"
				wide
			>
				<header className="flex shrink-0 items-start gap-2 border-border border-b px-2 py-2">
					<Button
						aria-label={
							origin ? `Back to ${displayLabel(origin)}` : "Back to graph"
						}
						className="mt-0.5 text-muted-foreground hover:text-foreground"
						onClick={onBack}
						size="icon-sm"
						type="button"
						variant="ghost"
					>
						<ArrowLeft aria-hidden="true" className="size-4" />
					</Button>
					<div className="flex min-w-0 flex-1 flex-col gap-0.5 py-1">
						<h3
							className="truncate font-semibold text-foreground text-sm leading-5 outline-none"
							ref={headingRef}
							tabIndex={-1}
						>
							{title}
						</h3>
						<div className="flex min-w-0 items-center gap-2 text-muted-foreground text-xs leading-4">
							{thread ? (
								<span className="flex shrink-0 items-center gap-1.5">
									<KnowledgeStatusDot
										palette={palette}
										status={threadStatus(thread)}
									/>
									{THREAD_STATUS_LABELS[threadStatus(thread)]}
								</span>
							) : null}
							{agents.length > 0 ? (
								<span className="truncate">
									{agents.map((agent) => agent.name).join(", ")}
								</span>
							) : null}
						</div>
					</div>
					<Button
						aria-label={`Close ${title}`}
						className="mt-0.5 text-muted-foreground hover:text-foreground"
						onClick={onClose}
						size="icon-sm"
						type="button"
						variant="ghost"
					>
						<X aria-hidden="true" className="size-4" />
					</Button>
				</header>
				<div className="flex min-h-0 flex-1 flex-col" data-knowledge-thread="">
					{threadView}
				</div>
			</PanelFrame>
		);
	}

	const { node } = view;
	const threads = linkedThreads(snapshot, graph, node.id);
	const viaMessage =
		node.kind === "topic" ? messageMentions(graph, node.id) : new Set<string>();
	const linked = linkedEntities(graph, node.id);
	const agent =
		node.kind === "agent" ? agentById(snapshot, node.refId) : undefined;
	const counts = statusCounts(threads);
	const summary = [
		KIND_LABELS[node.kind],
		plural(threads.length, "conversation"),
		...STATUS_SUMMARY.filter((status) => counts[status] > 0).map(
			(status) =>
				`${counts[status]} ${THREAD_STATUS_LABELS[status].toLowerCase()}`
		),
	].join(" · ");
	const canStart = node.kind !== "topic";
	return (
		<PanelFrame
			label={`${KIND_LABELS[node.kind]}: ${node.label}`}
			testId="knowledge-node-panel"
			wide={false}
		>
			<header className="flex shrink-0 flex-col gap-3 border-border border-b px-4 pt-3 pb-4">
				<div className="flex min-w-0 items-start gap-3">
					<NodeMark agent={agent} node={node} palette={palette} />
					<div className="flex min-w-0 flex-1 flex-col gap-0.5">
						<h3
							className="min-w-0 truncate font-semibold text-foreground text-lg leading-7 outline-none"
							ref={headingRef}
							tabIndex={-1}
						>
							{displayLabel(node)}
						</h3>
						<p className="truncate text-muted-foreground text-sm tabular-nums leading-5">
							{summary}
						</p>
					</div>
					<Button
						aria-label={`Close ${displayLabel(node)}`}
						className="-me-2 text-muted-foreground hover:text-foreground"
						onClick={onClose}
						size="icon-sm"
						type="button"
						variant="ghost"
					>
						<X aria-hidden="true" className="size-4" />
					</Button>
				</div>
				{agent?.description ? (
					<p className="text-pretty text-foreground/80 text-sm leading-5">
						{agent.description}
					</p>
				) : null}
				{canStart ? (
					<Button
						className="self-start"
						onClick={() => onNewThread(node)}
						size="sm"
						type="button"
						variant="outline"
					>
						<SquarePen aria-hidden="true" data-icon="inline-start" />
						New conversation
					</Button>
				) : null}
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-2">
				<section aria-label="Linked conversations">
					<SectionHeading count={threads.length}>Conversations</SectionHeading>
					{threads.length > 0 ? (
						<ul>
							{threads.map((thread) => (
								<ThreadRow
									key={thread.id}
									note={
										viaMessage.has(thread.id)
											? "Mentioned in latest message"
											: undefined
									}
									now={now}
									onOpen={onOpenThread}
									palette={palette}
									thread={thread}
								/>
							))}
						</ul>
					) : (
						<p className="px-4 pb-2 text-muted-foreground text-sm leading-5">
							No conversations link here yet.
						</p>
					)}
				</section>
				{LINK_GROUPS.map(({ kind, title }) => {
					const items = linked.filter((item) => item.kind === kind);
					if (items.length === 0) {
						return null;
					}
					return (
						<section
							aria-label={`Linked ${title.toLowerCase()}`}
							className="mt-2"
							key={kind}
						>
							<SectionHeading count={items.length}>{title}</SectionHeading>
							<ul>
								{items.map((item) => (
									<li key={item.id}>
										<button
											aria-label={`Go to ${displayLabel(item)}, ${KIND_LABELS[item.kind].toLowerCase()}`}
											className="flex h-9 w-full items-center gap-2.5 px-4 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
											onClick={() => onSelect(item.id)}
											type="button"
										>
											<Swatch
												node={item}
												palette={palette}
												snapshot={snapshot}
											/>
											<span className="min-w-0 flex-1 truncate text-foreground text-sm">
												{displayLabel(item)}
											</span>
											<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
												{linkDetail(item, snapshot, graph)}
											</span>
										</button>
									</li>
								))}
							</ul>
						</section>
					);
				})}
			</div>
		</PanelFrame>
	);
}

/**
 * What a linked entity holds, shown beside it in a list already grouped by
 * kind: a team's members, otherwise its conversations.
 */
function linkDetail(
	node: KnowledgeNode,
	snapshot: InterfaceSnapshot,
	graph: KnowledgeGraph
): string {
	if (node.kind === "team") {
		const team = snapshot.groups.find((group) => group.id === node.refId);
		return plural(team?.memberAgentIds.length ?? 0, "member");
	}
	return plural(linkedThreads(snapshot, graph, node.id).length, "conversation");
}
