import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceAgent,
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { useContext, useId } from "react";
import {
	agentThreadSections,
	type Creature,
	sectionThreads,
	type ThreadSection,
} from "./aquarium-model.ts";
import {
	AquariumPanelActs,
	STATUS_TONE,
	threadTitle,
} from "./aquarium-panel-context.ts";
import { BoardStatusDot } from "./board-status.tsx";
import { ActStatus } from "./interface-ask-card.tsx";
import { compactAge } from "./interface-renderer.ts";

export function AgentBody({
	activeThreadId,
	creature,
	now,
	onOpen,
	snapshot,
}: {
	activeThreadId: string | null;
	creature: Creature;
	now: number;
	onOpen: (threadId: string) => void;
	snapshot: InterfaceSnapshot;
}) {
	const { agent } = creature;
	const tl = useLiteralMessages();
	const actLayer = useContext(AquariumPanelActs);
	const act = actLayer?.acts.get(agent.id);
	const sections = agentThreadSections(snapshot, agent.id);
	// With acts only the agent's blocking asks need you (the act's own,
	// owned as the protocol owns them), not thread states.
	const needsYou = act
		? act.parkedAsks.length +
			(act.act === "asking" && act.ask?.blocking ? 1 : 0)
		: creature.counts.attention + creature.counts["your-turn"];
	return (
		<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 [scrollbar-width:thin]">
			{agent.description ? (
				<p className="text-pretty text-muted-foreground text-sm leading-relaxed">
					{agent.description}
				</p>
			) : null}
			{act && actLayer ? (
				<div className="mt-3 text-sm" data-testid="aquarium-agent-act">
					<ActStatus
						act={act}
						clock={actLayer.clock}
						nowMs={actLayer.nowMs}
						onAsk={actLayer.onAsk}
						onBlocker={actLayer.onBlocker}
						snapshot={actLayer.snapshot}
					/>
				</div>
			) : null}
			<p
				className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs tabular-nums"
				data-testid="aquarium-agent-counts"
			>
				<span>
					<span className="font-semibold text-foreground">
						{creature.threadCount}
					</span>{" "}
					{creature.threadCount === 1 ? "thread" : "threads"}
				</span>
				<span aria-hidden="true">·</span>
				<span>
					<span
						className={cn(
							"font-semibold text-foreground",
							creature.counts.attention > 0 && "text-status-destructive"
						)}
					>
						{needsYou}
					</span>{" "}
					{needsYou === 1 ? "needs you" : "need you"}
				</span>
				{act ? null : (
					<>
						<span aria-hidden="true">·</span>
						<span>
							<span
								className={cn(
									"font-semibold text-foreground",
									creature.counts.working > 0 && "text-status-success"
								)}
							>
								{creature.counts.working}
							</span>{" "}
							live
						</span>
					</>
				)}
			</p>
			<div className="mt-4 flex flex-col gap-4">
				{sections.length === 0 ? (
					<p className="rounded-xl border border-border border-dashed px-4 py-6 text-center text-muted-foreground text-sm">
						{tl("No threads with {name} yet. Say hello below.", {
							name: agent.name,
						})}
					</p>
				) : (
					(act
						? [
								{
									...sections[0],
									threads: sections.flatMap((section) => section.threads),
								} as ThreadSection,
							]
						: sections
					).map((section) => (
						<ThreadGroup
							activeThreadId={activeThreadId}
							key={section.status}
							now={now}
							onOpen={onOpen}
							section={section}
							snapshot={snapshot}
							viewer={agent}
						/>
					))
				)}
			</div>
		</div>
	);
}

function ThreadGroup({
	activeThreadId,
	now,
	onOpen,
	section,
	snapshot,
	viewer,
}: {
	activeThreadId: string | null;
	now: number;
	onOpen: (threadId: string) => void;
	section: ThreadSection;
	snapshot: InterfaceSnapshot;
	/** The agent whose panel this is; other participants are named. */
	viewer?: InterfaceAgent;
}) {
	const headingId = `${useId()}-${section.status}`;
	// With acts the threads are one list, not grouped by thread status.
	const actMode = useContext(AquariumPanelActs) !== null;
	return (
		<section aria-labelledby={headingId} className="flex flex-col gap-1">
			<h3
				className={cn(
					"flex items-center gap-2 px-1 font-medium text-xs",
					actMode ? "text-muted-foreground" : STATUS_TONE[section.status]
				)}
				id={headingId}
			>
				{actMode ? null : <BoardStatusDot status={section.status} />}
				{actMode ? "Threads" : THREAD_STATUS_LABELS[section.status]}
				<span className="text-muted-foreground tabular-nums">
					{section.threads.length}
				</span>
			</h3>
			<ul className="flex flex-col">
				{section.threads.map((thread) => (
					<li key={thread.id}>
						<ThreadRow
							active={thread.id === activeThreadId}
							now={now}
							onOpen={onOpen}
							snapshot={snapshot}
							thread={thread}
							viewer={viewer}
						/>
					</li>
				))}
			</ul>
		</section>
	);
}

function ThreadRow({
	active,
	now,
	onOpen,
	snapshot,
	thread,
	viewer,
}: {
	active: boolean;
	now: number;
	onOpen: (threadId: string) => void;
	snapshot: InterfaceSnapshot;
	thread: InterfaceThread;
	viewer?: InterfaceAgent;
}) {
	const tl = useLiteralMessages();
	const title = threadTitle(thread);
	const status = threadStatus(thread);
	const others = thread.agentIds
		.filter((agentId) => agentId !== viewer?.id)
		.map(
			(agentId) => snapshot.agents.find((agent) => agent.id === agentId)?.name
		)
		.filter((name): name is string => Boolean(name));
	// With acts a row carries no thread status or last-update age.
	const actMode = useContext(AquariumPanelActs) !== null;
	const age = actMode ? null : compactAge(thread.updatedAt, now);
	return (
		<button
			aria-current={active ? "true" : undefined}
			aria-label={tl("Open {title}", { title })}
			className="group flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring active:bg-muted/80 aria-[current=true]:bg-muted"
			onClick={() => onOpen(thread.id)}
			type="button"
		>
			{actMode ? null : (
				<span className="flex h-5 shrink-0 items-center">
					<BoardStatusDot status={status} />
				</span>
			)}
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="flex min-w-0 items-baseline gap-2">
					<span className="truncate font-medium text-foreground text-sm group-hover:underline group-hover:decoration-border group-hover:underline-offset-2">
						{title}
					</span>
					{thread.pinned ? (
						<span className="shrink-0 text-[10px] text-muted-foreground uppercase tracking-wide">
							Pinned
						</span>
					) : null}
				</span>
				{thread.lastMessage ? (
					<span className="line-clamp-2 text-muted-foreground text-xs leading-snug">
						{thread.lastMessageRole === "user" ? "You: " : ""}
						{thread.lastMessage}
					</span>
				) : null}
				{others.length > 0 ? (
					<span className="truncate text-muted-foreground/80 text-xs">
						{tl("With {names}", { names: others.join(", ") })}
					</span>
				) : null}
			</span>
			{age ? (
				<span className="shrink-0 pt-0.5 text-muted-foreground text-xs tabular-nums">
					{age}
				</span>
			) : null}
		</button>
	);
}

export function UnassignedBody({
	activeThreadId,
	now,
	onOpen,
	snapshot,
	threads,
}: {
	activeThreadId: string | null;
	now: number;
	onOpen: (threadId: string) => void;
	snapshot: InterfaceSnapshot;
	threads: InterfaceThread[];
}) {
	const sections = sectionThreads(threads);
	return (
		<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 [scrollbar-width:thin]">
			<div className="flex flex-col gap-4">
				{sections.length === 0 ? (
					<p className="rounded-xl border border-border border-dashed px-4 py-6 text-center text-muted-foreground text-sm">
						Every thread has an agent.
					</p>
				) : (
					sections.map((section) => (
						<ThreadGroup
							activeThreadId={activeThreadId}
							key={section.status}
							now={now}
							onOpen={onOpen}
							section={section}
							snapshot={snapshot}
						/>
					))
				)}
			</div>
		</div>
	);
}
