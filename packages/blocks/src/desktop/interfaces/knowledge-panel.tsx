import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { ArrowLeft, SquarePen, X } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { agentById } from "./interface-renderer.ts";
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
import type { KnowledgePalette } from "./knowledge-palette.ts";
import {
	NodeMark,
	PanelFrame,
	SectionHeading,
	Swatch,
	ThreadRow,
} from "./knowledge-panel-parts.tsx";
import { KnowledgeStatusDot } from "./knowledge-parts.tsx";

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
	const tl = useLiteralMessages();
	if (view.kind === "thread") {
		const { origin, thread } = view;
		const title = thread?.title ?? "New conversation";
		const agents = (thread?.agentIds ?? [])
			.map((agentId) => agentById(snapshot, agentId))
			.filter((agent) => agent !== undefined);
		return (
			<PanelFrame
				label={tl("Conversation: {title}", { title })}
				testId="knowledge-thread-panel"
				wide
			>
				<header className="flex shrink-0 items-start gap-2 border-border border-b px-2 py-2">
					<Button
						aria-label={
							origin
								? tl("Back to {label}", { label: displayLabel(origin) })
								: "Back to graph"
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
						aria-label={tl("Close {title}", { title })}
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
						aria-label={tl("Close {label}", { label: displayLabel(node) })}
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
							aria-label={tl("Linked {kind}", { kind: title.toLowerCase() })}
							className="mt-2"
							key={kind}
						>
							<SectionHeading count={items.length}>{title}</SectionHeading>
							<ul>
								{items.map((item) => (
									<li key={item.id}>
										<button
											aria-label={tl("Go to {label}, {kind}", {
												label: displayLabel(item),
												kind: KIND_LABELS[item.kind].toLowerCase(),
											})}
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
