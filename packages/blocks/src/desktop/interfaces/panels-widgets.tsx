import { useLiteralMessages } from "@ryu/i18n/react";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceSnapshot,
	InterfaceThread,
	ThreadStatus,
} from "@ryuhq/protocol/interfaces";
import { type ReactNode, useId } from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import { BoardStatusDot } from "./board-status.tsx";
import { agentById, compactAge } from "./interface-renderer.ts";
import {
	activityItems,
	buildAgentRows,
	type PanelsActivity,
	type PanelsAgentRow,
	type PanelsHeaderAction,
	type PanelsTarget,
	runTarget,
	runWhenParts,
	threadAgents,
	threadExcerpt,
	upcomingRuns,
	workingThreads,
} from "./panels-model.ts";

export interface PanelProps {
	/** The panel's header link, from `panelHeaderActions`. */
	action: PanelsHeaderAction | null;
	now: number;
	onTarget: (target: PanelsTarget) => void;
	snapshot: InterfaceSnapshot;
}

/**
 * One widget on the Home grid: a heading with a count and one quiet header
 * action, then its rows between hairlines. Unboxed, so the grid reads as one
 * page rather than a stack of cards.
 */
function Panel({
	action,
	children,
	count,
	onTarget,
	testId,
	title,
}: {
	action: PanelsHeaderAction | null;
	children: ReactNode;
	count?: number;
	onTarget: (target: PanelsTarget) => void;
	testId: string;
	title: string;
}) {
	const headingId = useId();
	return (
		<section
			aria-labelledby={headingId}
			className="flex min-w-0 flex-col"
			data-testid={testId}
		>
			<header className="flex h-10 shrink-0 items-center gap-3">
				<h2
					className="flex min-w-0 flex-1 items-baseline gap-2.5 font-semibold text-base text-foreground tracking-tight"
					id={headingId}
				>
					<span className="truncate">{title}</span>
					{count !== undefined && count > 0 ? (
						<span className="font-normal text-muted-foreground text-sm tabular-nums">
							{count}
						</span>
					) : null}
				</h2>
				{action ? (
					<button
						aria-label={action.label}
						className="-mr-1.5 h-7 min-w-0 max-w-[60%] shrink truncate rounded-md px-1.5 font-medium text-muted-foreground text-xs outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
						data-testid="panels-panel-action"
						onClick={() => onTarget(action.target)}
						title={action.label}
						type="button"
					>
						{action.text}
					</button>
				) : null}
			</header>
			<div className="flex min-h-0 flex-col border-border border-t">
				{children}
			</div>
		</section>
	);
}

function PanelEmpty({ children }: { children: ReactNode }) {
	return <p className="py-4 text-muted-foreground text-sm">{children}</p>;
}

/** Rows bleed 8px past the hairlines so the hover fill has room around text. */
const ROW_CLASS =
	"-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-md px-2 py-2.5 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

const LIST_CLASS = "flex flex-col divide-y divide-border";

function threadTarget(thread: InterfaceThread): PanelsTarget {
	return { kind: "open", threadId: thread.id };
}

export function WorkingPanel({ action, now, onTarget, snapshot }: PanelProps) {
	const tl = useLiteralMessages();
	const threads = workingThreads(snapshot);
	return (
		<Panel
			action={action}
			count={threads.length}
			onTarget={onTarget}
			testId="panels-working"
			title="Working now"
		>
			{threads.length === 0 ? (
				<PanelEmpty>No agent is working right now.</PanelEmpty>
			) : (
				<ul className={LIST_CLASS}>
					{threads.slice(0, 3).map((thread) => {
						const lead = threadAgents(snapshot, thread)[0];
						const age = compactAge(thread.updatedAt, now);
						return (
							<li key={thread.id}>
								<button
									className={cn(ROW_CLASS, "items-start py-3")}
									onClick={() => onTarget(threadTarget(thread))}
									type="button"
								>
									<BoardAvatar
										agent={lead}
										name={lead?.name ?? thread.title}
										size={24}
									/>
									<span className="flex min-w-0 flex-1 flex-col gap-1">
										<span className="flex h-6 items-center gap-3">
											<span className="min-w-0 flex-1 truncate font-medium text-foreground text-sm">
												{thread.title}
											</span>
											{lead ? (
												<span className="shrink-0 text-muted-foreground text-xs">
													{lead.name}
												</span>
											) : null}
										</span>
										<span className="flex items-center gap-3">
											<span className="min-w-0 flex-1 truncate text-muted-foreground text-sm">
												{threadExcerpt(thread)}
											</span>
											<span className="flex shrink-0 items-center gap-2 text-muted-foreground text-xs tabular-nums">
												<BoardStatusDot status="working" />
												{tl("Running · {age}", { age })}
											</span>
										</span>
									</span>
								</button>
							</li>
						);
					})}
				</ul>
			)}
		</Panel>
	);
}

export function UpcomingPanel({ action, now, onTarget, snapshot }: PanelProps) {
	const tl = useLiteralMessages();
	const runs = upcomingRuns(snapshot, now);
	return (
		<Panel
			action={action}
			count={runs.length}
			onTarget={onTarget}
			testId="panels-upcoming"
			title="Upcoming runs"
		>
			{runs.length === 0 ? (
				<PanelEmpty>No runs scheduled.</PanelEmpty>
			) : (
				<ul className={LIST_CLASS}>
					{runs.map((event) => {
						const agent = agentById(snapshot, event.agentId);
						const target = runTarget(snapshot, event);
						const when = runWhenParts(event.start, now);
						const body = (
							<>
								<span className="flex w-20 shrink-0 flex-col">
									<span className="font-medium text-foreground text-sm tabular-nums">
										{when.time}
									</span>
									<span className="text-muted-foreground text-xs">
										{when.day}
									</span>
								</span>
								<span className="flex min-w-0 flex-1 flex-col">
									<span className="truncate text-foreground text-sm">
										{event.title}
										{event.count && event.count > 1 ? (
											<span className="text-muted-foreground">
												{tl(" · {count} runs", { count: String(event.count) })}
											</span>
										) : null}
									</span>
									<span className="truncate text-muted-foreground text-xs">
										{[event.label, agent?.name].filter(Boolean).join(" · ")}
									</span>
								</span>
								<span className="flex w-5 shrink-0 justify-end">
									{agent ? (
										<BoardAvatar agent={agent} name={agent.name} size={20} />
									) : null}
								</span>
							</>
						);
						return (
							<li key={event.id}>
								{target ? (
									<button
										className={ROW_CLASS}
										onClick={() => onTarget(target)}
										type="button"
									>
										{body}
									</button>
								) : (
									<div className="flex items-center gap-3 py-2.5">{body}</div>
								)}
							</li>
						);
					})}
				</ul>
			)}
		</Panel>
	);
}

/** Most agent rows a panel lists before it folds the rest into a count. */
const AGENT_LIMIT = 6;

/**
 * One form on every row: a status slot, then the age of the agent's latest
 * conversation. The slot stays empty for idle agents so the ages align; the
 * working ring pulses on its own.
 */
function AgentState({ now, row }: { now: number; row: PanelsAgentRow }) {
	const marked =
		row.status === "working" ||
		row.status === "your-turn" ||
		row.status === "attention";
	return (
		<span className="flex w-14 shrink-0 items-center justify-end gap-2 text-muted-foreground text-xs tabular-nums">
			{marked && row.status ? <BoardStatusDot status={row.status} /> : null}
			<span className="w-7 text-right">
				{row.thread ? compactAge(row.thread.updatedAt, now) : "New"}
			</span>
		</span>
	);
}

const AGENT_STATE_NAMES: Record<ThreadStatus, string> = {
	attention: "needs a retry",
	quiet: "idle",
	waiting: "idle",
	working: "working",
	"your-turn": "waiting on you",
};

export function AgentsPanel({ action, now, onTarget, snapshot }: PanelProps) {
	const tl = useLiteralMessages();
	const rows = buildAgentRows(snapshot);
	const shown =
		rows.length > AGENT_LIMIT + 1 ? rows.slice(0, AGENT_LIMIT) : rows;
	const hidden = rows.length - shown.length;
	return (
		<Panel
			action={action}
			count={rows.length}
			onTarget={onTarget}
			testId="panels-agents"
			title="Agents"
		>
			{rows.length === 0 ? (
				<PanelEmpty>No agents yet.</PanelEmpty>
			) : (
				<ul className={LIST_CLASS}>
					{shown.map((row) => (
						<li key={row.agent.id}>
							<button
								aria-label={`${row.agent.name}, ${AGENT_STATE_NAMES[row.status ?? "quiet"]}: ${row.line}`}
								className={ROW_CLASS}
								onClick={() => onTarget(row.target)}
								type="button"
							>
								<BoardAvatar
									agent={row.agent}
									name={row.agent.name}
									size={24}
								/>
								<span className="w-16 shrink-0 truncate font-medium text-foreground text-sm">
									{row.agent.name}
								</span>
								<span className="min-w-0 flex-1 truncate text-muted-foreground text-sm">
									{row.line}
								</span>
								<AgentState now={now} row={row} />
							</button>
						</li>
					))}
					{hidden > 0 ? (
						<li className="py-2.5 pl-9 text-muted-foreground text-sm">
							{tl("{hidden} more", { hidden: String(hidden) })}
						</li>
					) : null}
				</ul>
			)}
		</Panel>
	);
}

function ActivityLine({ item }: { item: PanelsActivity }) {
	const isRun = item.kind === "finished" || item.kind === "failed";
	return (
		<span className="min-w-0 flex-1 truncate text-sm">
			<span className="font-medium text-foreground">{item.actor}</span>{" "}
			<span
				className={cn(
					item.kind === "failed" ? "text-destructive" : "text-foreground/80"
				)}
			>
				{item.verb}
			</span>
			{item.context ? (
				<span className="text-muted-foreground">
					{isRun ? ` · ${item.context}` : ` in ${item.context}`}
				</span>
			) : null}
		</span>
	);
}

export function ActivityPanel({ action, now, onTarget, snapshot }: PanelProps) {
	const items = activityItems(snapshot, now, 5);
	return (
		<Panel
			action={action}
			onTarget={onTarget}
			testId="panels-activity"
			title="Recent activity"
		>
			{items.length === 0 ? (
				<PanelEmpty>Nothing has happened yet.</PanelEmpty>
			) : (
				<ul className={LIST_CLASS}>
					{items.map((item) => {
						const body = (
							<>
								<BoardAvatar
									agent={item.agent}
									name={item.agent?.name ?? item.actor}
									size={24}
								/>
								<ActivityLine item={item} />
								<span className="w-8 shrink-0 text-right text-muted-foreground text-xs tabular-nums">
									{compactAge(item.at, now)}
								</span>
							</>
						);
						const target = item.target;
						return (
							<li key={item.id}>
								{target ? (
									<button
										className={ROW_CLASS}
										onClick={() => onTarget(target)}
										type="button"
									>
										{body}
									</button>
								) : (
									<div className="flex items-center gap-3 py-2.5">{body}</div>
								)}
							</li>
						);
					})}
				</ul>
			)}
		</Panel>
	);
}

type SkeletonRow = "line" | "live" | "run";

/** Each skeleton panel's row count and row shape, matching the loaded rows. */
const SKELETON_COLUMNS: { key: string; rows: number; shape: SkeletonRow }[][] =
	[
		[
			{ key: "working", rows: 2, shape: "live" },
			{ key: "agents", rows: 4, shape: "line" },
		],
		[
			{ key: "upcoming", rows: 4, shape: "run" },
			{ key: "activity", rows: 3, shape: "line" },
		],
	];

function SkeletonRowBody({ shape }: { shape: SkeletonRow }) {
	if (shape === "live") {
		return (
			<div className="flex items-start gap-3 py-3">
				<Skeleton className="size-6 shrink-0" radius="pill" />
				<div className="flex flex-1 flex-col gap-1">
					<div className="flex h-6 items-center">
						<Skeleton className="h-3.5 w-3/5" radius="dense" />
					</div>
					<div className="flex h-5 items-center">
						<Skeleton className="h-3 w-4/5" radius="dense" />
					</div>
				</div>
			</div>
		);
	}
	if (shape === "run") {
		return (
			<div className="flex items-center gap-3 py-2.5">
				<div className="flex w-20 shrink-0 flex-col">
					<div className="flex h-5 items-center">
						<Skeleton className="h-3.5 w-14" radius="dense" />
					</div>
					<div className="flex h-4 items-center">
						<Skeleton className="h-2.5 w-10" radius="dense" />
					</div>
				</div>
				<div className="flex flex-1 flex-col">
					<div className="flex h-5 items-center">
						<Skeleton className="h-3.5 w-3/5" radius="dense" />
					</div>
					<div className="flex h-4 items-center">
						<Skeleton className="h-2.5 w-2/5" radius="dense" />
					</div>
				</div>
			</div>
		);
	}
	return (
		<div className="flex items-center gap-3 py-2.5">
			<Skeleton className="size-6 shrink-0" radius="pill" />
			<Skeleton className="h-3.5 w-3/4" radius="dense" />
		</div>
	);
}

/** Placeholder grid while the host's first snapshot loads, in the real rhythm. */
export function PanelsSkeleton() {
	return (
		<div
			aria-hidden="true"
			className="grid @3xl:grid-cols-2 items-start gap-x-12 gap-y-12"
			data-testid="panels-skeleton"
		>
			{SKELETON_COLUMNS.map((column) => (
				<div className="flex flex-col gap-12" key={column[0]?.key}>
					{column.map((panel) => (
						<div className="flex flex-col" key={panel.key}>
							<div className="flex h-10 items-center">
								<Skeleton className="h-4 w-28" radius="dense" />
							</div>
							<div className="flex flex-col divide-y divide-border border-border border-t">
								{Array.from(
									{ length: panel.rows },
									(_, row) => `${panel.key}-${row}`
								).map((rowKey) => (
									<SkeletonRowBody key={rowKey} shape={panel.shape} />
								))}
							</div>
						</div>
					))}
				</div>
			))}
		</div>
	);
}
