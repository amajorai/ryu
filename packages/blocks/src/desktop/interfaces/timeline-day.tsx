import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceSnapshot,
	type InterfaceThread,
	type TimelineDay,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { Pin } from "lucide-react";
import { type ReactNode, useId } from "react";
import {
	dayHeading,
	fullDateTime,
	timeOfDay,
	weekColumnLabel,
} from "./timeline-model.ts";
import {
	agentSummary,
	TIMELINE_EVENT_ATTRIBUTE,
	TimelineThreadAvatar,
	threadAccessibleName,
	threadAgents,
	threadGroupName,
	threadTitle,
} from "./timeline-parts.tsx";
import {
	TimelineStatusCallout,
	TimelineStatusDot,
} from "./timeline-status.tsx";

/** DOM id of a day's heading, so "Today" and "earlier" jumps can find it. */
export function timelineDayHeadingId(key: string): string {
	return `timeline-day-${key}`;
}

/** Row grid: time, rail, content; the time folds into the meta line on phones. */
export const TIMELINE_DAY_ROW_GRID =
	"grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-2 sm:grid-cols-[4.5rem_1.5rem_minmax(0,1fr)]";

/** The rail's line, drawn by every row and every later day heading, so it reads as one stroke. */
export const TIMELINE_RAIL_LINE = "absolute inset-y-0 w-px bg-border";

/**
 * A day heading on the row grid: its text and rule start where the rows'
 * content does, and the rail runs on beside it. The first heading is as tall
 * as the open thread's header, so their rules line up; later ones are
 * shorter, so days sit close together.
 */
export function TimelineDayHeadingRow({
	children,
	first = false,
}: {
	children: ReactNode;
	first?: boolean;
}) {
	return (
		<div className={cn(TIMELINE_DAY_ROW_GRID, first ? "h-14" : "h-12")}>
			<span
				aria-hidden="true"
				className="relative flex justify-center sm:col-start-2"
			>
				{first ? null : <span className={TIMELINE_RAIL_LINE} />}
			</span>
			<div className="flex flex-col justify-end border-border border-b px-3 pb-2">
				<div className="flex items-baseline gap-2">{children}</div>
			</div>
		</div>
	);
}

function TimelineEventRow({
	active,
	now,
	onOpen,
	snapshot,
	tabStop,
	thread,
}: {
	active: boolean;
	now: number;
	onOpen: (threadId: string) => void;
	snapshot: InterfaceSnapshot;
	tabStop: boolean;
	thread: InterfaceThread;
}) {
	const excerptId = useId();
	const status = threadStatus(thread);
	const agents = threadAgents(snapshot, thread);
	const group = threadGroupName(snapshot, thread);
	const excerpt = thread.lastMessage?.trim();
	const isRecent = now - Date.parse(thread.updatedAt) < 60_000;
	const time = isRecent ? "Just now" : timeOfDay(thread.updatedAt);
	const meta = [
		agentSummary(agents),
		group,
		thread.messageCount > 0
			? `${thread.messageCount} ${
					thread.messageCount === 1 ? "message" : "messages"
				}`
			: null,
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<li>
			<button
				{...{ [TIMELINE_EVENT_ATTRIBUTE]: "" }}
				aria-current={active ? "true" : undefined}
				aria-describedby={excerpt ? excerptId : undefined}
				aria-label={threadAccessibleName(snapshot, thread)}
				className={cn(
					TIMELINE_DAY_ROW_GRID,
					"group/event w-full text-left outline-none"
				)}
				data-thread-id={thread.id}
				onClick={() => onOpen(thread.id)}
				tabIndex={tabStop ? 0 : -1}
				type="button"
			>
				<time
					className="pt-2 text-right text-muted-foreground text-xs tabular-nums leading-5 max-sm:hidden"
					dateTime={thread.updatedAt}
					title={fullDateTime(thread.updatedAt)}
				>
					{time}
				</time>
				<span aria-hidden="true" className="relative flex justify-center">
					{/* The very last row ends the rail at its mark. */}
					<span
						className={cn(
							TIMELINE_RAIL_LINE,
							"[section:last-child_li:last-child_&]:bottom-auto [section:last-child_li:last-child_&]:h-4"
						)}
					/>
					<span className="relative mt-2 flex size-5 items-center justify-center bg-background">
						<TimelineStatusDot status={status} />
					</span>
				</span>
				<span
					className={cn(
						"relative flex min-w-0 gap-3 rounded-md px-3 py-2 transition-colors duration-150 motion-reduce:transition-none",
						"group-hover/event:bg-muted/60 group-focus-visible/event:ring-2 group-focus-visible/event:ring-ring group-focus-visible/event:ring-inset",
						active &&
							"bg-accent text-accent-foreground group-hover/event:bg-accent"
					)}
				>
					<span aria-hidden="true" className="shrink-0">
						<TimelineThreadAvatar
							agents={agents}
							className="ring-1 ring-border"
							size={20}
						/>
					</span>
					<span className="flex min-w-0 flex-1 flex-col">
						<span className="flex min-w-0 items-center gap-1.5">
							<span className="min-w-0 truncate font-medium text-foreground text-sm leading-5">
								{threadTitle(thread)}
							</span>
							{thread.pinned ? (
								<Pin
									aria-hidden="true"
									className="size-3 shrink-0 text-muted-foreground"
								/>
							) : null}
						</span>
						<span
							className={cn(
								"truncate text-muted-foreground text-xs leading-5",
								active && "text-accent-foreground/70"
							)}
						>
							<span className="sm:hidden">{time} · </span>
							{status === "attention" || status === "your-turn" ? (
								<>
									<TimelineStatusCallout status={status} />
									{" · "}
								</>
							) : null}
							{meta}
						</span>
						{excerpt ? (
							<span
								className={cn(
									"line-clamp-2 text-[13px] text-muted-foreground leading-5 md:line-clamp-1",
									active && "text-accent-foreground/80"
								)}
								id={excerptId}
							>
								{thread.lastMessageRole === "user" ? "You: " : null}
								{excerpt}
							</span>
						) : null}
					</span>
				</span>
			</button>
		</li>
	);
}

/**
 * Day scale: every day with activity, newest first. Each day has a sticky
 * heading and a vertical rail whose dots carry the thread's status.
 */
export function TimelineDayList({
	activeThreadId,
	days,
	highlightKey,
	now,
	onOpen,
	preferredTabStop,
	snapshot,
	threadsById,
}: {
	activeThreadId: string | null;
	days: readonly TimelineDay[];
	/** A day just jumped to, briefly tinted so the jump is visible. */
	highlightKey: string | null;
	now: Date;
	onOpen: (threadId: string) => void;
	/** The thread that should hold the list's single Tab stop, if shown. */
	preferredTabStop: string | null;
	snapshot: InterfaceSnapshot;
	threadsById: ReadonlyMap<string, InterfaceThread>;
}) {
	const tl = useLiteralMessages();
	const shown = days.flatMap((day) =>
		day.threadIds.filter((id) => threadsById.has(id))
	);
	const tabStopId =
		preferredTabStop && shown.includes(preferredTabStop)
			? preferredTabStop
			: (shown[0] ?? null);
	return (
		<div className="flex w-full max-w-3xl flex-col pb-8">
			{days.map((day, dayIndex) => {
				const heading = dayHeading(day.key, now);
				const relative = heading === "Today" || heading === "Yesterday";
				const headingId = timelineDayHeadingId(day.key);
				const highlighted = day.key === highlightKey;
				return (
					<section
						aria-labelledby={headingId}
						className={cn(
							"transition-colors duration-500 motion-reduce:transition-none",
							highlighted && "bg-primary/5"
						)}
						data-day-key={day.key}
						data-highlight={highlighted ? "" : undefined}
						key={day.key}
					>
						<div
							className={cn(
								// The tint is an overlay so the stuck heading stays opaque.
								"sticky top-0 z-10 bg-background px-2",
								"before:pointer-events-none before:absolute before:inset-0 before:bg-primary/10 before:opacity-0 before:transition-opacity before:duration-500 before:content-[''] motion-reduce:before:transition-none",
								highlighted && "before:opacity-100"
							)}
						>
							<TimelineDayHeadingRow first={dayIndex === 0}>
								<h2
									className="font-medium text-sm leading-5 outline-none focus-visible:underline"
									id={headingId}
									tabIndex={-1}
								>
									{heading}
								</h2>
								{relative ? (
									<span className="text-muted-foreground text-xs leading-5">
										{weekColumnLabel(day.key).full}
									</span>
								) : null}
							</TimelineDayHeadingRow>
						</div>
						<ol
							aria-label={tl("Threads, {heading}", { heading })}
							className="flex flex-col px-2"
						>
							{day.threadIds.map((id) => {
								const thread = threadsById.get(id);
								return thread ? (
									<TimelineEventRow
										active={thread.id === activeThreadId}
										key={id}
										now={now.getTime()}
										onOpen={onOpen}
										snapshot={snapshot}
										tabStop={thread.id === tabStopId}
										thread={thread}
									/>
								) : null;
							})}
						</ol>
					</section>
				);
			})}
		</div>
	);
}
