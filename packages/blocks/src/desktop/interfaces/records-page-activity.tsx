import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceEvent,
	type InterfaceSnapshot,
	type InterfaceThread,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { CalendarCheck2, CalendarClock, CalendarX2 } from "lucide-react";
import type { ReactNode } from "react";
import { BoardStatusDot } from "./board-status.tsx";
import {
	type RecordsRow,
	recordsActivity,
	recordsClockTime,
	recordsFullTime,
	recordsLatestLine,
	recordsPlural,
	recordsRunTime,
	recordsThreadAgents,
	recordsThreadTitle,
} from "./records-model.ts";
import { RecordsStatus } from "./records-parts.tsx";

// ---------------------------------------------------------------------------
// Activity timeline
// ---------------------------------------------------------------------------

/** Where an entry sits on its day's rail, so the line joins the markers. */
type RailPosition = "first" | "last" | "middle" | "only";

function railPosition(index: number, total: number): RailPosition {
	if (total === 1) {
		return "only";
	}
	if (index === 0) {
		return "first";
	}
	return index === total - 1 ? "last" : "middle";
}

const RAIL_LINE: Record<RailPosition, string | null> = {
	first: "top-[18px] bottom-0",
	last: "top-0 h-[18px]",
	middle: "inset-y-0",
	only: null,
};

/**
 * One row on the activity rail: a marker centered on the entry's first line,
 * and the line that joins it to its neighbours.
 */
function TimelineItem({
	children,
	marker,
	position,
}: {
	children: ReactNode;
	marker: ReactNode;
	position: RailPosition;
}) {
	const line = RAIL_LINE[position];
	return (
		<li className="relative flex gap-3">
			<span
				aria-hidden="true"
				className="relative flex w-4 shrink-0 justify-center"
			>
				{line ? <span className={cn("absolute w-px bg-border", line)} /> : null}
				<span className="relative mt-2.5 flex size-4 items-center justify-center rounded-full bg-background">
					{marker}
				</span>
			</span>
			<div className="flex min-w-0 flex-1 pb-1">{children}</div>
		</li>
	);
}

function EntryHeading({ time, title }: { time: ReactNode; title: string }) {
	return (
		<span className="flex min-w-0 items-baseline gap-3">
			<span className="truncate font-medium text-[13px] text-foreground leading-5">
				{title}
			</span>
			<span className="ms-auto shrink-0 text-muted-foreground text-xs tabular-nums">
				{time}
			</span>
		</span>
	);
}

function MetaDot() {
	return (
		<span aria-hidden="true" className="text-muted-foreground">
			·
		</span>
	);
}

/** Shared box for timeline entries, so threads and runs line up exactly. */
const ENTRY_BOX =
	"flex min-w-0 flex-1 flex-col gap-1 rounded-md px-3 py-2 text-left";

function ThreadEntry({
	active,
	onOpen,
	position,
	showAgents,
	snapshot,
	thread,
}: {
	active: boolean;
	onOpen: () => void;
	position: RailPosition;
	showAgents: boolean;
	snapshot: InterfaceSnapshot;
	thread: InterfaceThread;
}) {
	const status = threadStatus(thread);
	const latest = recordsLatestLine(thread);
	const agents = showAgents ? recordsThreadAgents(snapshot, thread) : [];
	return (
		<TimelineItem
			marker={<BoardStatusDot status={status} />}
			position={position}
		>
			<button
				aria-current={active ? "true" : undefined}
				className={cn(
					ENTRY_BOX,
					"outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
					active ? "bg-muted" : "hover:bg-muted/50"
				)}
				onClick={onOpen}
				type="button"
			>
				<EntryHeading
					time={
						<time
							dateTime={thread.updatedAt}
							title={recordsFullTime(thread.updatedAt)}
						>
							{recordsClockTime(thread.updatedAt)}
						</time>
					}
					title={recordsThreadTitle(thread)}
				/>
				<span className="flex min-w-0 items-center gap-1.5 text-xs leading-4">
					<RecordsStatus dot={false} status={status} />
					{agents.length > 0 ? (
						<>
							<MetaDot />
							<span className="truncate text-muted-foreground">
								{agents.map((agent) => agent.name).join(", ")}
							</span>
						</>
					) : null}
					<MetaDot />
					<span className="shrink-0 text-muted-foreground tabular-nums">
						{recordsPlural(thread.messageCount, "message")}
					</span>
				</span>
				{latest ? (
					<span className="line-clamp-2 text-[13px] text-muted-foreground leading-5">
						{latest}
					</span>
				) : null}
			</button>
		</TimelineItem>
	);
}

/** A scheduled run: read-only, so it has no hover or focus of its own. */
function RunEntry({
	event,
	now,
	position,
}: {
	event: InterfaceEvent;
	now: number;
	position: RailPosition;
}) {
	const tl = useLiteralMessages();
	const upcoming = event.kind === "upcoming";
	const failed = event.outcome === "failure";
	let Marker = CalendarCheck2;
	if (upcoming) {
		Marker = CalendarClock;
	} else if (failed) {
		Marker = CalendarX2;
	}
	let outcome: string | null = null;
	if (!upcoming && event.outcome) {
		outcome = failed ? "Failed" : "Succeeded";
	}
	const at = upcoming ? event.start : (event.end ?? event.start);
	return (
		<TimelineItem
			marker={
				<Marker
					className={cn(
						"size-3.5",
						failed ? "text-destructive" : "text-muted-foreground"
					)}
				/>
			}
			position={position}
		>
			<div className={ENTRY_BOX}>
				<EntryHeading
					time={
						<time dateTime={at} title={recordsFullTime(at)}>
							{upcoming ? recordsRunTime(at, now) : recordsClockTime(at)}
						</time>
					}
					title={event.title}
				/>
				<span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs leading-4">
					<span className="shrink-0">Scheduled run</span>
					{outcome ? (
						<>
							<MetaDot />
							<span
								className={cn(
									"shrink-0",
									failed ? "text-destructive" : "text-foreground"
								)}
							>
								{outcome}
							</span>
						</>
					) : null}
					{event.label ? (
						<>
							<MetaDot />
							<span className="truncate">{event.label}</span>
						</>
					) : null}
					{upcoming && event.count ? (
						<>
							<MetaDot />
							<span className="shrink-0 tabular-nums">
								{tl(
									"{count, plural, one {{countLabel} run} other {{countLabel} runs}} that day",
									{ count: event.count, countLabel: String(event.count) }
								)}
							</span>
						</>
					) : null}
				</span>
			</div>
		</TimelineItem>
	);
}

/** How many upcoming runs the timeline lists before the past. */
export const UPCOMING_LIMIT = 3;

function DayHeading({ children }: { children: ReactNode }) {
	return (
		<h3 className="mb-1 ps-10 text-muted-foreground text-xs leading-6">
			{children}
		</h3>
	);
}

export function RecordsActivity({
	activeThreadId,
	now,
	onMessage,
	onOpenThread,
	row,
	snapshot,
}: {
	activeThreadId: string | null;
	now: number;
	onMessage: () => void;
	onOpenThread: (threadId: string) => void;
	row: RecordsRow;
	snapshot: InterfaceSnapshot;
}) {
	const tl = useLiteralMessages();
	const days = recordsActivity(row.threads, now, row.runs);
	const upcoming = row.upcoming.slice(0, UPCOMING_LIMIT);
	if (days.length === 0 && upcoming.length === 0) {
		return (
			<Empty
				className="items-start p-0 text-left"
				data-testid="records-activity-empty"
			>
				<EmptyHeader className="items-start text-left">
					<EmptyTitle className="text-[13px]">No activity yet</EmptyTitle>
					<EmptyDescription className="text-[13px]">
						{tl("Threads with {name} are listed here, newest first.", {
							name: row.name,
						})}
					</EmptyDescription>
				</EmptyHeader>
				<EmptyContent className="items-start">
					<Button onClick={onMessage} size="sm" type="button" variant="outline">
						Start a thread
					</Button>
				</EmptyContent>
			</Empty>
		);
	}
	return (
		<div className="flex flex-col gap-4">
			{upcoming.length > 0 ? (
				<section aria-label="Upcoming">
					<DayHeading>Upcoming</DayHeading>
					<ol className="flex flex-col">
						{upcoming.map((event, index) => (
							<RunEntry
								event={event}
								key={event.id}
								now={now}
								position={railPosition(index, upcoming.length)}
							/>
						))}
					</ol>
				</section>
			) : null}
			{days.map((day) => (
				<section aria-label={day.label} key={day.key}>
					<DayHeading>{day.label}</DayHeading>
					<ol className="flex flex-col">
						{day.items.map((item, index) => {
							const position = railPosition(index, day.items.length);
							if (item.kind === "run") {
								return (
									<RunEntry
										event={item.event}
										key={item.id}
										now={now}
										position={position}
									/>
								);
							}
							return (
								<ThreadEntry
									active={item.thread.id === activeThreadId}
									key={item.id}
									onOpen={() => onOpenThread(item.thread.id)}
									position={position}
									showAgents={row.object !== "agents"}
									snapshot={snapshot}
									thread={item.thread}
								/>
							);
						})}
					</ol>
				</section>
			))}
		</div>
	);
}
