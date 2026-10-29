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
	type InterfaceAgent,
	type InterfaceEvent,
	type InterfaceGroup,
	type InterfaceSnapshot,
	type InterfaceThread,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import {
	AtSign,
	CalendarCheck2,
	CalendarClock,
	CalendarX2,
	ChevronDown,
	ChevronRight,
	ChevronUp,
	CircleDot,
	Clock3,
	FolderKanban,
	Inbox,
	type LucideIcon,
	MessageCircle,
	MessagesSquare,
	Shapes,
	UserRound,
	UsersRound,
} from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode, RefObject } from "react";
import { BoardStatusDot } from "./board-status.tsx";
import { agentHandle } from "./interface-renderer.ts";
import {
	RECORDS_OBJECT_LABELS,
	type RecordsObject,
	type RecordsRow,
	recordsActivity,
	recordsClockTime,
	recordsFullTime,
	recordsLatestLine,
	recordsPlural,
	recordsRelativeTime,
	recordsRunTime,
	recordsThreadAgents,
	recordsThreadTitle,
} from "./records-model.ts";
import { RECORDS_OBJECT_ICONS } from "./records-nav.tsx";
import {
	RecordsMark,
	RecordsRowStatus,
	RecordsStatus,
} from "./records-parts.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

export interface RecordsRelatedTarget {
	id: string;
	object: RecordsObject;
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

function Attribute({
	children,
	icon: Icon,
	label,
}: {
	children: ReactNode;
	icon: LucideIcon;
	label: string;
}) {
	return (
		<div className="grid grid-cols-[120px_minmax(0,1fr)] items-start gap-3 py-1.5">
			<dt className="flex h-6 items-center gap-2 text-muted-foreground">
				<Icon aria-hidden="true" className="size-3.5 shrink-0" />
				<span className="truncate">{label}</span>
			</dt>
			<dd className="flex min-h-6 min-w-0 items-center text-foreground">
				{children}
			</dd>
		</div>
	);
}

function RelatedLink({
	agent,
	name,
	onOpen,
}: {
	agent: InterfaceAgent | null;
	name: string;
	onOpen: () => void;
}) {
	return (
		<button
			className="-mx-1 flex h-6 min-w-0 items-center gap-1.5 rounded-md px-1 outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
			onClick={onOpen}
			type="button"
		>
			<RecordsMark agent={agent} name={name} size={20} />
			<span className="truncate">{name}</span>
		</button>
	);
}

function GroupLinks({
	groups,
	object,
	onOpenRecord,
}: {
	groups: readonly InterfaceGroup[];
	object: RecordsObject;
	onOpenRecord: (target: RecordsRelatedTarget) => void;
}) {
	if (groups.length === 0) {
		return <span className="text-muted-foreground">None</span>;
	}
	return (
		<ul className="flex min-w-0 flex-col gap-0.5">
			{groups.map((group) => (
				<li className="flex min-w-0" key={group.id}>
					<RelatedLink
						agent={null}
						name={group.name}
						onOpen={() => onOpenRecord({ id: group.id, object })}
					/>
				</li>
			))}
		</ul>
	);
}

function CountValue({ value }: { value: number }) {
	return (
		<span
			className={cn("tabular-nums", value === 0 && "text-muted-foreground")}
		>
			{value}
		</span>
	);
}

/** The record's attribute list, Attio's "Record details". */
export function RecordsAttributes({
	columns = 1,
	now,
	onOpenRecord,
	row,
}: {
	/** Two columns where the list sits inline in a wide page. */
	columns?: 1 | 2;
	now: number;
	onOpenRecord: (target: RecordsRelatedTarget) => void;
	row: RecordsRow;
}) {
	const last = recordsRelativeTime(row.lastInteraction, now);
	const nextRun = row.upcoming[0];
	return (
		<dl
			className={cn(
				"text-[13px]",
				columns === 2 ? "grid grid-cols-2 gap-x-8" : "flex flex-col"
			)}
		>
			{row.agent ? (
				<Attribute icon={AtSign} label="Handle">
					<span className="truncate">{agentHandle(row.agent.name)}</span>
				</Attribute>
			) : (
				<Attribute icon={Shapes} label="Type">
					{RECORDS_OBJECT_LABELS[row.object].singular}
				</Attribute>
			)}
			<Attribute icon={CircleDot} label="Status">
				<RecordsRowStatus row={row} />
			</Attribute>
			<Attribute icon={MessagesSquare} label="Threads">
				<CountValue value={row.threads.length} />
			</Attribute>
			<Attribute icon={Inbox} label="Needs you">
				<CountValue value={row.needsYou} />
			</Attribute>
			<Attribute icon={MessageCircle} label="Messages">
				<CountValue value={row.messageCount} />
			</Attribute>
			<Attribute icon={Clock3} label="Last interaction">
				{last && row.lastInteraction ? (
					<time
						dateTime={row.lastInteraction}
						title={recordsFullTime(row.lastInteraction)}
					>
						{last}
					</time>
				) : (
					<span className="text-muted-foreground">Never</span>
				)}
			</Attribute>
			{row.object === "agents" ? (
				<Attribute icon={CalendarClock} label="Next run">
					{nextRun ? (
						<span className="flex min-w-0 flex-col py-0.5">
							<span className="truncate leading-5">{nextRun.title}</span>
							<time
								className="truncate text-muted-foreground text-xs leading-4"
								dateTime={nextRun.start}
								title={recordsFullTime(nextRun.start)}
							>
								{recordsRunTime(nextRun.start, now)}
							</time>
						</span>
					) : (
						<span className="text-muted-foreground">None scheduled</span>
					)}
				</Attribute>
			) : null}
			{row.object === "agents" ? (
				<>
					<Attribute icon={UsersRound} label="Teams">
						<GroupLinks
							groups={row.teams}
							object="teams"
							onOpenRecord={onOpenRecord}
						/>
					</Attribute>
					<Attribute icon={FolderKanban} label="Projects">
						<GroupLinks
							groups={row.projects}
							object="projects"
							onOpenRecord={onOpenRecord}
						/>
					</Attribute>
				</>
			) : (
				<Attribute icon={UserRound} label="Members">
					{row.members.length > 0 ? (
						<ul className="flex min-w-0 flex-col gap-0.5">
							{row.members.map((agent) => (
								<li className="flex min-w-0" key={agent.id}>
									<RelatedLink
										agent={agent}
										name={agent.name}
										onOpen={() =>
											onOpenRecord({ id: agent.id, object: "agents" })
										}
									/>
								</li>
							))}
						</ul>
					) : (
						<span className="text-muted-foreground">No members</span>
					)}
				</Attribute>
			)}
		</dl>
	);
}

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
								{recordsPlural(event.count, "run")} that day
							</span>
						</>
					) : null}
				</span>
			</div>
		</TimelineItem>
	);
}

/** How many upcoming runs the timeline lists before the past. */
const UPCOMING_LIMIT = 3;

function DayHeading({ children }: { children: ReactNode }) {
	return (
		<h3 className="mb-1 ps-10 text-muted-foreground text-xs leading-6">
			{children}
		</h3>
	);
}

function RecordsActivity({
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
						Threads with {row.name} are listed here, newest first.
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

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/**
 * A record page: breadcrumb and record stepping on top, the record's header
 * with its quick action, its activity timeline, and the attributes panel on
 * the right (or inline above the activity at narrow widths). An open thread
 * takes the right column so the record stays in view beside the chat.
 */
export function RecordsPage({
	activeThreadId,
	detailsColumns,
	detailsInline,
	headingRef,
	now,
	onBack,
	onMessage,
	onNext,
	onOpenRecord,
	onOpenThread,
	onPrevious,
	position,
	row,
	side,
	snapshot,
}: {
	activeThreadId: string | null;
	/** Columns for the attributes when they sit inside the main column. */
	detailsColumns: 1 | 2;
	/** True when the page is too narrow for the attributes panel. */
	detailsInline: boolean;
	headingRef: RefObject<HTMLHeadingElement | null>;
	now: number;
	onBack: () => void;
	onMessage: () => void;
	onNext: (() => void) | null;
	onOpenRecord: (target: RecordsRelatedTarget) => void;
	onOpenThread: (threadId: string) => void;
	onPrevious: (() => void) | null;
	position: { index: number; total: number } | null;
	row: RecordsRow;
	/** The right column: the open thread, or null to show the attributes. */
	side: ReactNode | null;
	snapshot: InterfaceSnapshot;
}) {
	const reduceMotion = useReducedMotion();
	const ObjectIcon = RECORDS_OBJECT_ICONS[row.object];
	const objectLabel = RECORDS_OBJECT_LABELS[row.object].plural;
	// An open thread takes the right column, so the attributes move inline
	// rather than disappear.
	const inline = side !== null || detailsInline;
	const activityCount =
		row.threads.length +
		row.runs.length +
		Math.min(row.upcoming.length, UPCOMING_LIMIT);
	return (
		<motion.div
			animate={{ opacity: 1 }}
			className="flex min-h-0 min-w-0 flex-1 flex-col"
			data-testid="records-page"
			initial={reduceMotion ? false : { opacity: 0 }}
			key={row.id}
			transition={{ duration: 0.14 }}
		>
			<header className="flex h-12 shrink-0 items-center gap-2 border-border border-b px-4">
				<nav aria-label="Breadcrumb" className="min-w-0 flex-1">
					<ol className="flex min-w-0 items-center gap-1 text-sm">
						<li className="flex shrink-0">
							<button
								className="-ms-2 flex h-8 items-center gap-2 rounded-md px-2 text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
								onClick={onBack}
								title="Back to the table (Esc)"
								type="button"
							>
								<ObjectIcon aria-hidden="true" className="size-4" />
								{objectLabel}
							</button>
						</li>
						<li aria-hidden="true" className="flex text-muted-foreground">
							<ChevronRight className="size-3.5" />
						</li>
						<li
							aria-current="page"
							className="flex min-w-0 items-center gap-2 px-1 font-medium text-foreground"
						>
							<span className="truncate">{row.name}</span>
						</li>
					</ol>
				</nav>
				{position ? (
					<div className="flex shrink-0 items-center gap-1">
						<span className="me-1 text-muted-foreground text-xs tabular-nums max-sm:hidden">
							{position.index + 1} of {position.total}
						</span>
						<Button
							aria-keyshortcuts="K"
							aria-label="Previous record"
							disabled={onPrevious === null}
							onClick={onPrevious ?? undefined}
							size="icon-sm"
							title="Previous record (K)"
							type="button"
							variant="ghost"
						>
							<ChevronUp aria-hidden="true" />
						</Button>
						<Button
							aria-keyshortcuts="J"
							aria-label="Next record"
							disabled={onNext === null}
							onClick={onNext ?? undefined}
							size="icon-sm"
							title="Next record (J)"
							type="button"
							variant="ghost"
						>
							<ChevronDown aria-hidden="true" />
						</Button>
					</div>
				) : null}
			</header>
			<div className="relative flex min-h-0 flex-1">
				<div className="min-w-0 flex-1 overflow-y-auto">
					<div className="flex w-full max-w-[880px] flex-col gap-8 px-6 pt-6 pb-12 max-sm:px-4">
						<div className="flex items-start gap-4 max-sm:flex-col">
							<RecordsMark agent={row.agent} name={row.name} size={40} />
							<div className="flex min-w-0 flex-1 flex-col gap-1">
								<h2
									className="truncate text-foreground text-xl leading-7 outline-none"
									ref={headingRef}
									tabIndex={-1}
								>
									<span className="font-semibold">{row.name}</span>
								</h2>
								<p className="text-muted-foreground text-sm leading-5">
									{row.object === "agents"
										? row.description || "No description"
										: `${RECORDS_OBJECT_LABELS[row.object].singular} · ${recordsPlural(row.members.length, "member")}`}
								</p>
							</div>
							<Button
								className="shrink-0"
								onClick={onMessage}
								size="sm"
								type="button"
							>
								<MessageCircle aria-hidden="true" data-icon="inline-start" />
								Message
							</Button>
						</div>
						{inline ? (
							<section aria-labelledby="records-details-inline">
								<h3
									className="mb-2 text-foreground text-sm leading-5"
									id="records-details-inline"
								>
									<span className="font-semibold">Details</span>
								</h3>
								<RecordsAttributes
									columns={detailsColumns}
									now={now}
									onOpenRecord={onOpenRecord}
									row={row}
								/>
							</section>
						) : null}
						<section aria-labelledby="records-activity">
							<div className="mb-3 flex items-baseline gap-2">
								<h3
									className="text-foreground text-sm leading-5"
									id="records-activity"
								>
									<span className="font-semibold">Activity</span>
								</h3>
								<span className="text-muted-foreground text-sm tabular-nums">
									{activityCount}
								</span>
							</div>
							<RecordsActivity
								activeThreadId={activeThreadId}
								now={now}
								onMessage={onMessage}
								onOpenThread={onOpenThread}
								row={row}
								snapshot={snapshot}
							/>
						</section>
					</div>
				</div>
				{side ??
					(inline ? null : (
						<aside
							aria-labelledby="records-details"
							className="flex w-80 shrink-0 flex-col overflow-y-auto border-border border-l"
						>
							<h3
								className="flex h-11 shrink-0 items-center border-border border-b px-4 text-foreground text-sm"
								id="records-details"
							>
								<span className="font-semibold">Details</span>
							</h3>
							<div className="px-4 py-2">
								<RecordsAttributes
									now={now}
									onOpenRecord={onOpenRecord}
									row={row}
								/>
							</div>
						</aside>
					))}
			</div>
		</motion.div>
	);
}
