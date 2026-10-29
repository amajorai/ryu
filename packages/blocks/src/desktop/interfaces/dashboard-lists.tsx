import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceAgent,
	type InterfaceEvent,
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import type { ReactNode } from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import { BoardStatusDot } from "./board-status.tsx";
import {
	type DashboardAgentRow,
	fullDateLabel,
	HOUR_MS,
	plural,
	threadTitle,
	untilLabel,
} from "./dashboard-model.ts";
import { agentById, compactAge } from "./interface-renderer.ts";

/** How a thread list leads each row and what its second line says. */
export type ThreadListVariant = "attention" | "mixed" | "working" | "your-turn";

/** Rows sit 8px in from the frame so their text lines up with the title. */
const LIST = "flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2";
const ROW =
	"group/row flex w-full min-w-0 items-start gap-3 rounded-md px-2 py-2 text-left outline-none transition-colors duration-100 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring aria-[current=true]:bg-muted";

function agentNames(snapshot: InterfaceSnapshot, thread: InterfaceThread) {
	const agents = thread.agentIds
		.map((id) => agentById(snapshot, id))
		.filter((agent) => agent !== undefined);
	return {
		lead: agents[0],
		names: agents.map((agent) => agent.name).join(", "),
	};
}

/** The second line: who, and what was said last (or where it stands). */
function detailLine(
	variant: ThreadListVariant,
	thread: InterfaceThread,
	names: string
): ReactNode {
	const who = names || "No agent";
	if (variant === "mixed") {
		return `${THREAD_STATUS_LABELS[threadStatus(thread)]} · ${who}`;
	}
	if (variant === "attention") {
		return (
			<>
				<span className="text-destructive">
					{thread.runState === "interrupted" ? "Interrupted" : "Run failed"}
				</span>
				{` · ${who}`}
			</>
		);
	}
	return thread.lastMessage ? `${who} · ${thread.lastMessage}` : who;
}

/** A centered single line where a widget has nothing to list. */
export function WidgetEmpty({ children }: { children: ReactNode }) {
	return (
		<p className="flex flex-1 items-center justify-center px-6 pb-6 text-center text-muted-foreground text-sm">
			{children}
		</p>
	);
}

function ThreadRow({
	active,
	now,
	onOpen,
	snapshot,
	thread,
	variant,
}: {
	active: boolean;
	now: number;
	onOpen: (threadId: string) => void;
	snapshot: InterfaceSnapshot;
	thread: InterfaceThread;
	variant: ThreadListVariant;
}) {
	const { lead, names } = agentNames(snapshot, thread);
	const status = threadStatus(thread);
	return (
		<li>
			<button
				aria-current={active ? "true" : undefined}
				className={ROW}
				data-thread-id={thread.id}
				onClick={() => onOpen(thread.id)}
				type="button"
			>
				<span className="flex size-5 shrink-0 items-center justify-center">
					{variant === "mixed" ? (
						<BoardStatusDot status={status} />
					) : (
						<BoardAvatar
							agent={lead}
							name={lead?.name ?? threadTitle(thread)}
							size={20}
						/>
					)}
				</span>
				<span className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="flex min-w-0 items-baseline gap-3">
						<span className="min-w-0 flex-1 truncate text-foreground text-sm leading-5">
							{threadTitle(thread)}
						</span>
						<time
							className="shrink-0 text-[13px] text-muted-foreground tabular-nums"
							dateTime={thread.updatedAt}
							title={fullDateLabel(thread.updatedAt)}
						>
							{compactAge(thread.updatedAt, now)}
						</time>
					</span>
					<span className="truncate text-[13px] text-muted-foreground leading-[18px]">
						{detailLine(variant, thread, names)}
					</span>
				</span>
			</button>
		</li>
	);
}

/** A list of threads; each row opens its thread in the slide-over. */
export function ThreadList({
	activeThreadId,
	empty,
	label,
	now,
	onOpen,
	runs = [],
	snapshot,
	threads,
	variant,
}: {
	activeThreadId: string | null;
	empty: string;
	label: string;
	now: number;
	onOpen: (threadId: string) => void;
	/** Failed scheduled runs, listed after the threads (read-only rows). */
	runs?: readonly InterfaceEvent[];
	snapshot: InterfaceSnapshot;
	threads: readonly InterfaceThread[];
	variant: ThreadListVariant;
}) {
	if (threads.length === 0 && runs.length === 0) {
		return <WidgetEmpty>{empty}</WidgetEmpty>;
	}
	return (
		<ul aria-label={label} className={LIST}>
			{threads.map((thread) => (
				<ThreadRow
					active={thread.id === activeThreadId}
					key={thread.id}
					now={now}
					onOpen={onOpen}
					snapshot={snapshot}
					thread={thread}
					variant={variant}
				/>
			))}
			{runs.map((run) => (
				<FailedRunRow key={run.id} now={now} run={run} snapshot={snapshot} />
			))}
		</ul>
	);
}

/** A scheduled run that failed: no thread to open, so a plain row. */
function FailedRunRow({
	now,
	run,
	snapshot,
}: {
	now: number;
	run: InterfaceEvent;
	snapshot: InterfaceSnapshot;
}) {
	const agent = agentById(snapshot, run.agentId);
	return (
		<li
			className="flex min-w-0 items-start gap-3 px-2 py-2"
			data-run-id={run.id}
		>
			<RunLead agent={agent} />
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="flex min-w-0 items-baseline gap-3">
					<span className="min-w-0 flex-1 truncate text-foreground text-sm leading-5">
						{run.title}
					</span>
					<time
						className="shrink-0 text-[13px] text-muted-foreground tabular-nums"
						dateTime={run.start}
						title={fullDateLabel(run.start)}
					>
						{compactAge(run.start, now)}
					</time>
				</span>
				<span className="truncate text-[13px] text-muted-foreground leading-[18px]">
					<span className="text-destructive">Scheduled run failed</span>
					{` · ${agent?.name ?? "Workflow"}`}
				</span>
			</span>
		</li>
	);
}

/** An agent's face for a scheduled run, or a dashed ring for a workflow. */
function RunLead({ agent }: { agent: InterfaceAgent | undefined }) {
	return (
		<span className="flex size-5 shrink-0 items-center justify-center">
			{agent ? (
				<BoardAvatar agent={agent} name={agent.name} size={20} />
			) : (
				<span
					aria-hidden="true"
					className="size-5 rounded-full border border-border border-dashed"
				/>
			)}
		</span>
	);
}

function AgentState({ agent }: { agent: InterfaceAgent }) {
	if (agent.status === "working") {
		return (
			<span className="inline-flex shrink-0 items-center gap-1.5 text-[13px] text-foreground">
				<BoardStatusDot status="working" />
				Working
			</span>
		);
	}
	return (
		<span className="shrink-0 text-[13px] text-muted-foreground">Idle</span>
	);
}

/**
 * Every agent with its state and latest thread. A row opens that thread, or
 * starts a new one with the agent when it has none yet.
 */
export function AgentList({
	activeThreadId,
	now,
	onOpen,
	onStart,
	rows,
}: {
	activeThreadId: string | null;
	now: number;
	onOpen: (threadId: string) => void;
	onStart: (agentId: string) => void;
	rows: readonly DashboardAgentRow[];
}) {
	if (rows.length === 0) {
		return <WidgetEmpty>No agents yet.</WidgetEmpty>;
	}
	return (
		<ul aria-label="Agents" className={LIST}>
			{rows.map(({ agent, latest, threadCount }) => {
				const action = latest
					? `${agent.name}: open ${threadTitle(latest)}`
					: `${agent.name}: start a thread`;
				return (
					<li key={agent.id}>
						<button
							aria-current={
								latest && latest.id === activeThreadId ? "true" : undefined
							}
							aria-label={`${action}. ${agent.status === "working" ? "Working" : "Idle"}, ${plural(threadCount, "thread")}.`}
							className={ROW}
							onClick={() => (latest ? onOpen(latest.id) : onStart(agent.id))}
							type="button"
						>
							<BoardAvatar agent={agent} name={agent.name} size={20} />
							<span className="flex min-w-0 flex-1 flex-col gap-0.5">
								<span className="flex min-w-0 items-baseline gap-3">
									<span className="min-w-0 flex-1 truncate font-medium text-foreground text-sm leading-5">
										{agent.name}
									</span>
									<AgentState agent={agent} />
								</span>
								<span className="flex min-w-0 gap-1 text-[13px] text-muted-foreground leading-[18px]">
									{latest ? (
										<>
											<span className="min-w-0 truncate">
												{threadTitle(latest)}
											</span>
											<span className="shrink-0 tabular-nums">
												· {compactAge(latest.updatedAt, now)}
											</span>
										</>
									) : (
										<span className="truncate">No threads yet</span>
									)}
								</span>
							</span>
						</button>
					</li>
				);
			})}
		</ul>
	);
}

/** Scheduled runs, soonest first. Read-only: a run has no thread to open. */
export function UpcomingList({
	events,
	now,
	snapshot,
}: {
	events: readonly InterfaceEvent[] | null;
	now: number;
	snapshot: InterfaceSnapshot;
}) {
	if (!events) {
		return <WidgetEmpty>This host has no scheduled routines.</WidgetEmpty>;
	}
	if (events.length === 0) {
		return <WidgetEmpty>Nothing is scheduled.</WidgetEmpty>;
	}
	return (
		<ul aria-label="Upcoming runs" className={LIST}>
			{events.map((event) => {
				const agent = agentById(snapshot, event.agentId);
				const when = fullDateLabel(event.start);
				const detail = [event.label, agent?.name ?? "Workflow"]
					.filter(Boolean)
					.join(" · ");
				return (
					<li
						className="flex min-w-0 items-start gap-3 px-2 py-2"
						key={event.id}
					>
						<RunLead agent={agent} />
						<span className="flex min-w-0 flex-1 flex-col gap-0.5">
							<span className="flex min-w-0 items-baseline gap-3">
								<span className="min-w-0 flex-1 truncate text-foreground text-sm leading-5">
									{event.title}
								</span>
								<time
									className={cn(
										"shrink-0 text-[13px] tabular-nums",
										Date.parse(event.start) - now < HOUR_MS
											? "font-medium text-foreground"
											: "text-muted-foreground"
									)}
									dateTime={event.start}
									title={when}
								>
									{untilLabel(event.start, now)}
								</time>
							</span>
							<span className="truncate text-[13px] text-muted-foreground leading-[18px]">
								{detail}
							</span>
						</span>
					</li>
				);
			})}
		</ul>
	);
}
