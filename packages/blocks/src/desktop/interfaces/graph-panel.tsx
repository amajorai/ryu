import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import { ScrollArea } from "@ryu/ui/components/scroll-area.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type GraphNode,
	type InterfaceAgent,
	type InterfaceSnapshot,
	type InterfaceThread,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { ArrowLeft, X } from "lucide-react";
import type { ReactNode, Ref } from "react";
import {
	GROUP_ICON,
	GraphAvatar,
	GraphStatusDot,
	GraphStatusLabel,
	TEXT_BODY,
	TEXT_META,
	TEXT_TITLE,
} from "./graph-parts.tsx";
import { InterfaceComposer } from "./interface-composer.tsx";
import { agentById, compactAge } from "./interface-renderer.ts";

/**
 * The shared Kbd inverts its colors inside tooltips, which reads as dark on
 * dark against the muted tooltip surface; keep it legible in every theme.
 */
const TOOLTIP_KBD =
	"in-data-[slot=tooltip-content]:bg-background/70 in-data-[slot=tooltip-content]:text-muted-foreground dark:in-data-[slot=tooltip-content]:bg-background/70";

/** Side panels sit beside the map, and cover it on narrow canvases. */
const PANEL_CLASS =
	"flex min-h-0 shrink-0 flex-col border-border border-l bg-background @max-[767px]:absolute @max-[767px]:inset-0 @max-[767px]:z-20 @max-[767px]:w-full @max-[767px]:border-l-0";

/**
 * The open thread needs the width a chat reads at, so below 960px it covers
 * the map rather than squeezing it into a sliver; Back returns to the map.
 */
const THREAD_PANEL_CLASS =
	"flex min-h-0 shrink-0 flex-col border-border border-l bg-background @max-[959px]:absolute @max-[959px]:inset-0 @max-[959px]:z-20 @max-[959px]:w-full @max-[959px]:min-w-0 @max-[959px]:border-l-0";

/** Both panel headers share one height, so switching panels never jumps. */
const PANEL_HEADER =
	"flex h-14 shrink-0 items-center gap-3 border-border border-b px-4";

function CloseButton({
	label,
	onClick,
}: {
	label: string;
	onClick: () => void;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						aria-label={label}
						onClick={onClick}
						size="icon-sm"
						type="button"
						variant="ghost"
					/>
				}
			>
				<X aria-hidden="true" />
			</TooltipTrigger>
			<TooltipContent align="end" side="bottom">
				{label} <Kbd className={TOOLTIP_KBD}>Esc</Kbd>
			</TooltipContent>
		</Tooltip>
	);
}

function NodeMark({
	agent,
	node,
}: {
	agent: InterfaceAgent | undefined;
	node: GraphNode;
}) {
	if (node.kind === "agent") {
		return (
			<GraphAvatar
				agent={agent}
				className={cn(
					"size-8",
					node.status === "working"
						? "ring-2 ring-success"
						: "ring-1 ring-border"
				)}
			/>
		);
	}
	if (node.kind === "you") {
		return (
			<span
				aria-hidden="true"
				className={cn(
					"flex size-8 shrink-0 items-center justify-center rounded-full bg-primary font-semibold text-[11px] text-primary-foreground leading-none"
				)}
			>
				You
			</span>
		);
	}
	const Icon = GROUP_ICON[node.kind];
	return (
		<span
			aria-hidden="true"
			className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
		>
			<Icon className="size-4" />
		</span>
	);
}

function threadPeople(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread
): string {
	const names = thread.agentIds
		.map((id) => agentById(snapshot, id)?.name)
		.filter((name): name is string => Boolean(name));
	if (names.length === 0) {
		return "No agent";
	}
	return names.length > 2
		? `${names.slice(0, 2).join(", ")} +${names.length - 2}`
		: names.join(", ");
}

function ThreadRow({
	active,
	onOpen,
	showPeople,
	snapshot,
	thread,
}: {
	active: boolean;
	onOpen: () => void;
	showPeople: boolean;
	snapshot: InterfaceSnapshot;
	thread: InterfaceThread;
}) {
	const title = thread.title.trim() || "Untitled thread";
	const status = threadStatus(thread);
	const people = showPeople ? threadPeople(snapshot, thread) : null;
	const detail = [people, thread.lastMessage?.trim()]
		.filter((part): part is string => Boolean(part))
		.join(" — ");
	return (
		<li>
			<button
				aria-current={active ? "true" : undefined}
				className={cn(
					"flex w-full flex-col gap-1 rounded-md px-2 py-2 text-left outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring",
					active && "bg-accent text-accent-foreground"
				)}
				onClick={onOpen}
				type="button"
			>
				<span className="flex w-full min-w-0 items-baseline gap-2">
					<span
						className={cn(
							"min-w-0 flex-1 truncate font-medium text-foreground",
							TEXT_BODY
						)}
					>
						{title}
					</span>
					<time
						className={cn(
							"shrink-0 text-muted-foreground tabular-nums",
							TEXT_META
						)}
						dateTime={thread.updatedAt}
					>
						{compactAge(thread.updatedAt)}
					</time>
				</span>
				<span
					className={cn(
						"flex w-full min-w-0 items-center gap-1.5 text-muted-foreground",
						TEXT_META
					)}
				>
					<GraphStatusLabel
						className={status === "attention" ? undefined : "text-foreground"}
						status={status}
					/>
					{detail ? (
						<>
							<span aria-hidden="true">·</span>
							<span className="min-w-0 truncate">{detail}</span>
						</>
					) : null}
				</span>
			</button>
		</li>
	);
}

export interface GraphNodePanelProps {
	activeThreadId: string | null;
	agent: InterfaceAgent | undefined;
	/** Agents the composer can address (picker shown when more than one). */
	composerAgents: InterfaceAgent[];
	description: string;
	headingRef: Ref<HTMLHeadingElement>;
	/** Agents linked to this node (members or collaborators), as shortcuts. */
	linkedAgents: InterfaceAgent[];
	linkedLabel: string;
	node: GraphNode;
	onClose: () => void;
	onOpenThread: (threadId: string) => void;
	onSelectNode: (nodeId: string) => void;
	onStart: (input: { agentId?: string; prompt: string }) => void;
	snapshot: InterfaceSnapshot;
	threads: InterfaceThread[];
}

/** A picked node: who or what it is, its threads, and a composer to start one. */
export function GraphNodePanel({
	activeThreadId,
	agent,
	composerAgents,
	description,
	headingRef,
	linkedAgents,
	linkedLabel,
	node,
	onClose,
	onOpenThread,
	onSelectNode,
	onStart,
	snapshot,
	threads,
}: GraphNodePanelProps) {
	const tl = useLiteralMessages();
	const workingCount = linkedAgents.filter(
		(linked) => linked.status === "working"
	).length;
	let workingNote: string | null = null;
	if (node.kind === "agent" && node.status === "working") {
		workingNote = "Working now";
	} else if (
		(node.kind === "team" || node.kind === "project") &&
		workingCount > 0
	) {
		workingNote = `${workingCount} working`;
	}
	const name = node.kind === "you" ? "Your threads" : node.label;
	const recipient = node.kind === "you" ? "an agent" : node.label;
	return (
		<aside
			aria-label={tl("{name} details", { name })}
			className={cn(PANEL_CLASS, "w-[340px]")}
			data-testid="graph-node-panel"
		>
			<header className={cn(PANEL_HEADER, "pe-2.5")}>
				<NodeMark agent={agent} node={node} />
				<div className="flex min-w-0 flex-1 flex-col">
					<h2
						className={cn(
							"truncate font-semibold text-foreground outline-none",
							TEXT_TITLE
						)}
						ref={headingRef}
						tabIndex={-1}
					>
						{name}
					</h2>
					<p
						className={cn(
							"flex min-w-0 items-center gap-1.5 text-muted-foreground",
							TEXT_META
						)}
						title={description}
					>
						<span className="min-w-0 truncate">{description}</span>
						{workingNote ? (
							<>
								<span aria-hidden="true">·</span>
								<GraphStatusDot status="working" />
								<span className="shrink-0 text-foreground">{workingNote}</span>
							</>
						) : null}
					</p>
				</div>
				<CloseButton label="Close details" onClick={onClose} />
			</header>
			{linkedAgents.length > 0 ? (
				<section
					aria-label={linkedLabel}
					className="flex shrink-0 flex-col gap-1 border-border border-b px-2 py-3"
				>
					<h3
						className={cn("px-2 font-medium text-muted-foreground", TEXT_META)}
					>
						{linkedLabel}
					</h3>
					<ul className="flex flex-wrap">
						{linkedAgents.map((linked) => (
							<li key={linked.id}>
								<button
									className={cn(
										"flex h-8 items-center gap-2 rounded-md px-2 text-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring",
										TEXT_BODY
									)}
									onClick={() => onSelectNode(`agent:${linked.id}`)}
									type="button"
								>
									<GraphAvatar
										agent={linked}
										className={cn(
											"size-5",
											linked.status === "working"
												? "ring-2 ring-success"
												: "ring-1 ring-border"
										)}
									/>
									{linked.name}
									<span className="sr-only">
										{tl(
											"{status, select, working {, working} other {}}. Show on map",
											{ status: linked.status }
										)}
									</span>
								</button>
							</li>
						))}
					</ul>
				</section>
			) : null}
			<section aria-label="Threads" className="flex min-h-0 flex-1 flex-col">
				<h3
					className={cn(
						"flex shrink-0 items-center justify-between px-4 pt-3 pb-1 font-medium text-muted-foreground",
						TEXT_META
					)}
				>
					Threads
					<span className="tabular-nums">{threads.length}</span>
				</h3>
				{threads.length > 0 ? (
					<ScrollArea className="min-h-0 flex-1">
						<ul className="flex flex-col px-2 pb-3">
							{threads.map((thread) => (
								<ThreadRow
									active={thread.id === activeThreadId}
									key={thread.id}
									onOpen={() => onOpenThread(thread.id)}
									showPeople={node.kind !== "agent"}
									snapshot={snapshot}
									thread={thread}
								/>
							))}
						</ul>
					</ScrollArea>
				) : (
					<p className={cn("px-4 py-2 text-muted-foreground", TEXT_BODY)}>
						{node.kind === "you"
							? "No threads yet. Start one below."
							: tl("No threads with {label} yet.", { label: node.label })}
					</p>
				)}
			</section>
			<div className="shrink-0 border-border border-t p-3">
				<InterfaceComposer
					agents={composerAgents.length > 1 ? composerAgents : undefined}
					defaultAgentId={composerAgents[0]?.id}
					key={node.id}
					label={tl("Start a thread with {recipient}", { recipient })}
					onSubmit={onStart}
					placeholder={tl("Start a thread with {recipient}…", { recipient })}
					submitLabel="Start thread"
				/>
			</div>
		</aside>
	);
}

/** The open thread: back to the map (or node) above the host's chat surface. */
export function GraphThreadPanel({
	backLabel,
	headingRef,
	onBack,
	snapshot,
	thread,
	threadView,
}: {
	backLabel: string;
	headingRef: Ref<HTMLHeadingElement>;
	onBack: () => void;
	snapshot: InterfaceSnapshot;
	thread: InterfaceThread | undefined;
	threadView: ReactNode;
}) {
	const tl = useLiteralMessages();
	const title = thread
		? thread.title.trim() || "Untitled thread"
		: "New thread";
	const lead = agentById(snapshot, thread?.agentIds[0]);
	return (
		<aside
			aria-label={tl("Thread: {title}", { title })}
			className={cn(THREAD_PANEL_CLASS, "w-[min(600px,58%)] min-w-[360px]")}
			data-testid="graph-thread-panel"
		>
			<header className={cn(PANEL_HEADER, "gap-2 px-2.5")}>
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								aria-label={backLabel}
								onClick={onBack}
								size="icon-sm"
								type="button"
								variant="ghost"
							/>
						}
					>
						<ArrowLeft aria-hidden="true" />
					</TooltipTrigger>
					<TooltipContent align="start" side="bottom">
						{backLabel} <Kbd className={TOOLTIP_KBD}>Esc</Kbd>
					</TooltipContent>
				</Tooltip>
				{lead ? (
					<GraphAvatar agent={lead} className="size-7 ring-1 ring-border" />
				) : null}
				<div className="flex min-w-0 flex-1 flex-col">
					<h2
						className={cn(
							"truncate font-semibold text-foreground outline-none",
							TEXT_TITLE
						)}
						ref={headingRef}
						tabIndex={-1}
					>
						{title}
					</h2>
					<p className={cn("truncate text-muted-foreground", TEXT_META)}>
						{thread ? threadPeople(snapshot, thread) : "New conversation"}
					</p>
				</div>
				{thread ? (
					<GraphStatusLabel
						className={cn("pe-2 text-muted-foreground", TEXT_META)}
						status={threadStatus(thread)}
					/>
				) : null}
			</header>
			<div className="min-h-0 flex-1">{threadView}</div>
		</aside>
	);
}
