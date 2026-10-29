import { Button } from "@ryu/ui/components/button.tsx";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceAgent,
	type InterfaceSnapshot,
	type InterfaceThread,
	localDayKey,
	THREAD_STATUS_LABELS,
	type ThreadStatus,
} from "@ryuhq/protocol/interfaces";
import { Bot, CalendarDays, MessageSquarePlus, X } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import { BoardStatusDot } from "./board-status.tsx";
import {
	type CalendarItem,
	compactTime,
	displayWallDate,
	longDay,
	RUN_OUTCOME_LABELS,
	type RunItem,
	type RunOutcome,
	runDuration,
	runOutcome,
} from "./calendar-model.ts";
import { agentById } from "./interface-renderer.ts";

/** The calendar's one small type size: hour labels, weekday names, captions. */
export const MICRO_TEXT_CLASS = "text-xs leading-4";
/** Section labels and weekday headings: the small caps eyebrow. */
export const EYEBROW_CLASS = cn(
	MICRO_TEXT_CLASS,
	"font-medium text-muted-foreground uppercase tracking-wide"
);
/** The one radius for everything drawn on the grid: chips, blocks, pills. */
export const ITEM_RADIUS_CLASS = "rounded-[4px]";

/** Marks every item (thread or run) a pointer or key can open. */
export const CALENDAR_ITEM_ATTRIBUTE = "data-calendar-item";
/** Marks a day's focus target (month cell or week column heading). */
export const CALENDAR_DAY_ATTRIBUTE = "data-calendar-day";

/**
 * Block fills: one recipe for every tone, an opaque mix of a theme token over
 * the page (so a cascaded block hides the one under it cleanly), a step
 * stronger on hover and on dark themes.
 */
const FILL = {
	destructive:
		"bg-[color-mix(in_oklab,var(--destructive)_14%,var(--background))] hover:bg-[color-mix(in_oklab,var(--destructive)_20%,var(--background))] dark:bg-[color-mix(in_oklab,var(--destructive)_22%,var(--background))] dark:hover:bg-[color-mix(in_oklab,var(--destructive)_30%,var(--background))]",
	foreground:
		"bg-[color-mix(in_oklab,var(--foreground)_10%,var(--background))] hover:bg-[color-mix(in_oklab,var(--foreground)_15%,var(--background))] dark:bg-[color-mix(in_oklab,var(--foreground)_18%,var(--background))] dark:hover:bg-[color-mix(in_oklab,var(--foreground)_25%,var(--background))]",
	muted:
		"bg-[color-mix(in_oklab,var(--muted-foreground)_14%,var(--background))] hover:bg-[color-mix(in_oklab,var(--muted-foreground)_20%,var(--background))] dark:bg-[color-mix(in_oklab,var(--muted-foreground)_22%,var(--background))] dark:hover:bg-[color-mix(in_oklab,var(--muted-foreground)_30%,var(--background))]",
	quiet:
		"bg-[color-mix(in_oklab,var(--muted-foreground)_8%,var(--background))] hover:bg-[color-mix(in_oklab,var(--muted-foreground)_14%,var(--background))] dark:bg-[color-mix(in_oklab,var(--muted-foreground)_12%,var(--background))] dark:hover:bg-[color-mix(in_oklab,var(--muted-foreground)_20%,var(--background))]",
	success:
		"bg-[color-mix(in_oklab,var(--success)_14%,var(--background))] hover:bg-[color-mix(in_oklab,var(--success)_20%,var(--background))] dark:bg-[color-mix(in_oklab,var(--success)_22%,var(--background))] dark:hover:bg-[color-mix(in_oklab,var(--success)_30%,var(--background))]",
} as const;

type BlockTone = ThreadStatus | `run-${RunOutcome}`;

/**
 * Each tone's fill and accent bar. No status leans on the theme's primary
 * accent (which marks today and the selection, and which some themes make the
 * same green as success): "your turn" is drawn in the page's own ink,
 * "working" in success, failures in destructive, the threads still waiting
 * on an agent in a neutral grey, and runs in the quietest neutral fill with
 * a bar in their outcome's tone (an outline while still scheduled).
 */
const BLOCK_TONE: Record<BlockTone, { bar: string; fill: string }> = {
	attention: { bar: "bg-destructive", fill: FILL.destructive },
	quiet: {
		bar: "border border-muted-foreground/70 bg-transparent",
		fill: FILL.quiet,
	},
	// A run's bar is its dot drawn long: an outline while it is scheduled,
	// solid in its outcome's tone once it has run.
	"run-failure": { bar: "bg-destructive", fill: FILL.quiet },
	"run-ran": { bar: "bg-muted-foreground", fill: FILL.quiet },
	"run-scheduled": {
		bar: "border border-muted-foreground/70 bg-transparent",
		fill: FILL.quiet,
	},
	"run-success": { bar: "bg-success", fill: FILL.quiet },
	waiting: { bar: "bg-muted-foreground", fill: FILL.muted },
	working: { bar: "bg-success", fill: FILL.success },
	"your-turn": { bar: "bg-foreground", fill: FILL.foreground },
};

function blockTone(item: CalendarItem): BlockTone {
	return item.kind === "thread" ? item.status : `run-${runOutcome(item.event)}`;
}

/** The fill (and hover) for an item drawn as a block. */
export function blockToneClass(item: CalendarItem): string {
	return BLOCK_TONE[blockTone(item)].fill;
}

/**
 * A block's accent: a square-cornered 3px bar inset from the block's edge,
 * so the block's own radius never bends it into a bracket.
 */
export function BlockAccent({ item }: { item: CalendarItem }) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"pointer-events-none absolute inset-y-1 start-1 w-[3px] rounded-full",
				BLOCK_TONE[blockTone(item)].bar
			)}
		/>
	);
}

export function threadTitle(thread: InterfaceThread): string {
	return thread.title.trim() || "Untitled thread";
}

export function threadAgents(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread
): InterfaceAgent[] {
	const agents: InterfaceAgent[] = [];
	for (const id of thread.agentIds) {
		const agent = agentById(snapshot, id);
		if (agent) {
			agents.push(agent);
		}
	}
	return agents;
}

export function threadGroupName(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread
): string | null {
	const groupId = thread.teamId ?? thread.projectId;
	if (!groupId) {
		return null;
	}
	return snapshot.groups.find((group) => group.id === groupId)?.name ?? null;
}

const FULL_TIME = new Intl.DateTimeFormat(undefined, {
	hour: "numeric",
	minute: "2-digit",
});

/** One sentence naming an item for assistive tech. */
export function itemAccessibleName(
	snapshot: InterfaceSnapshot,
	item: CalendarItem
): string {
	if (item.kind === "thread") {
		const agents = threadAgents(snapshot, item.thread)
			.map((agent) => agent.name)
			.join(", ");
		return [
			threadTitle(item.thread),
			THREAD_STATUS_LABELS[item.status],
			agents || "No agent",
			`last active ${FULL_TIME.format(item.start)}`,
		].join(", ");
	}
	return [
		`Scheduled run: ${item.event.title}`,
		RUN_OUTCOME_LABELS[runOutcome(item.event)],
		runWhenPhrase(item),
	].join(", ");
}

/**
 * When a run happens, for assistive tech. An aggregate's start is only a
 * stand-in for its day, so it is named by its day and count, never a time.
 */
function runWhenPhrase(item: RunItem): string {
	const count = aggregateCount(item);
	if (count === 0) {
		return FULL_TIME.format(item.start);
	}
	const day =
		localDayKey(item.start) === localDayKey(displayWallDate(Date.now()))
			? "today"
			: `on ${longDay(item.start)}`;
	return item.event.kind === "upcoming"
		? `${count} runs scheduled ${day}`
		: `${count} runs ${day}`;
}

function aggregateCount(item: RunItem): number {
	const { count } = item.event;
	return count && count > 1 ? count : 0;
}

/**
 * The Board's 8px status dot, with one change for the calendar: "your turn"
 * is filled with the page's own ink, so it never shares a hue with "working"
 * or with today's primary circle, whatever the theme (working is a success
 * ring, attention a destructive dot, waiting and quiet outlines).
 */
export function CalendarStatusDot({
	className,
	status,
}: {
	className?: string;
	status: ThreadStatus;
}) {
	return (
		<BoardStatusDot
			className={cn(status === "your-turn" && "bg-foreground", className)}
			status={status}
		/>
	);
}

/**
 * A run's 8px dot, the same shape as a thread's: filled in its outcome's
 * tone once it has run, an outline while it is still scheduled.
 */
const RUN_DOT: Record<RunOutcome, string> = {
	failure: "bg-destructive",
	ran: "bg-muted-foreground",
	scheduled: "border-[1.5px] border-muted-foreground/70",
	success: "bg-success",
};

export function RunDot({ outcome }: { outcome: RunOutcome }) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"inline-block size-2 shrink-0 rounded-full",
				RUN_DOT[outcome]
			)}
		/>
	);
}

/**
 * Leading mark for any item, in one 12px slot holding an 8px glyph: the
 * thread's status dot, or a run's dot (an outline while scheduled, filled
 * in its outcome's tone once it has run). Every list uses the same marks.
 */
export function ItemMark({ item }: { item: CalendarItem }) {
	return (
		<span className="flex size-3 shrink-0 items-center justify-center">
			{item.kind === "thread" ? (
				<CalendarStatusDot status={item.status} />
			) : (
				<RunDot outcome={runOutcome(item.event)} />
			)}
		</span>
	);
}

/** The open thread, wherever it is listed: a primary tint, like the reference's open event. */
export const ACTIVE_ITEM_CLASS =
	"bg-primary/12 text-foreground hover:bg-primary/16";

/**
 * Shared chip look for a single-line item in the month grid and the week's
 * all-day row. Timed items (threads and single runs) share one anatomy: dot,
 * time, title, with no box. Only an aggregated run, which stands for a whole
 * day of runs, is a plain filled bar, the way calendars draw all-day events.
 */
export function chipClassName(item: CalendarItem, active: boolean): string {
	const aggregate = item.kind === "run" && (item.event.count ?? 0) > 1;
	return cn(
		"group/chip relative flex h-5 w-full min-w-0 shrink-0 items-center gap-1.5 px-1 text-left text-xs outline-none transition-colors",
		ITEM_RADIUS_CLASS,
		// A phone-width cell has no room for words: each item becomes its dot.
		"@max-[6rem]:size-3.5 @max-[6rem]:justify-center @max-[6rem]:px-0",
		"hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0",
		aggregate &&
			"@max-[6rem]:bg-transparent bg-muted @max-[6rem]:ps-0 ps-1.5 @max-[6rem]:hover:bg-muted hover:bg-muted-foreground/15",
		active && ACTIVE_ITEM_CLASS
	);
}

/**
 * Dot, time, and title for a one-line chip (month cells and the all-day
 * row). The time always carries its am/pm, and drops whole in a narrow cell
 * rather than shortening, so the title keeps the room. An all-day bar is
 * just its title, with the dot only when the cell is too narrow for words.
 */
export function ChipBody({ item }: { item: CalendarItem }) {
	const aggregate = item.kind === "run" && (item.event.count ?? 0) > 1;
	const upcoming = item.kind === "run" && item.event.kind === "upcoming";
	const title =
		item.kind === "thread" ? threadTitle(item.thread) : item.event.title;
	return (
		<>
			{aggregate ? (
				<span className="@max-[6rem]:flex hidden">
					<ItemMark item={item} />
				</span>
			) : (
				<ItemMark item={item} />
			)}
			{aggregate ? null : (
				<span className="@min-[9rem]:inline hidden shrink-0 text-muted-foreground tabular-nums">
					{compactTime(item.start)}
				</span>
			)}
			<span
				className={cn(
					"@max-[6rem]:hidden min-w-0 flex-1 truncate font-medium",
					upcoming && !aggregate ? "text-muted-foreground" : "text-foreground"
				)}
			>
				{title}
			</span>
		</>
	);
}

function DetailRow({
	children,
	icon,
}: {
	children: ReactNode;
	icon: ReactNode;
}) {
	return (
		<div className="flex min-w-0 items-start gap-3 text-sm">
			<span className="flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">
				{icon}
			</span>
			<div className="flex min-w-0 flex-1 flex-col">{children}</div>
		</div>
	);
}

/** The run's colour, calendar style: a filled square in its outcome's tone. */
const OUTCOME_SWATCH: Record<RunOutcome, string> = {
	failure: "bg-destructive",
	ran: "bg-muted-foreground/60",
	scheduled: "bg-muted-foreground/60",
	success: "bg-success",
};

const OUTCOME_TEXT: Record<RunOutcome, string> = {
	failure: "text-status-destructive",
	ran: "",
	scheduled: "",
	success: "text-status-success",
};

/**
 * What a run popover says, laid out like a calendar event: the routine with
 * its schedule and outcome, when it ran or will, the agent it targets, and a
 * way to message that agent.
 */
export function RunDetails({
	item,
	onClose,
	onMessage,
	snapshot,
}: {
	item: RunItem;
	onClose?: () => void;
	onMessage: (agentId: string) => void;
	snapshot: InterfaceSnapshot;
}) {
	const { event } = item;
	const agent = agentById(snapshot, event.agentId);
	const outcome = runOutcome(event);
	const count = aggregateCount(item);
	const duration = runDuration(item);
	let detail = compactTime(item.start);
	if (count > 0) {
		detail = `${count} ${event.kind === "upcoming" ? "runs scheduled" : "runs"}`;
	} else if (duration) {
		detail = `${detail} · took ${duration}`;
	}
	return (
		<div className="flex flex-col gap-4" data-testid="calendar-run-details">
			<div className="flex items-start gap-3">
				<span className="flex h-6 w-5 shrink-0 items-center justify-center">
					<span
						aria-hidden="true"
						className={cn("size-3", ITEM_RADIUS_CLASS, OUTCOME_SWATCH[outcome])}
					/>
				</span>
				<div className="flex min-w-0 flex-1 flex-col">
					<h3 className="font-heading font-semibold text-base text-foreground leading-6">
						{event.title}
					</h3>
					<p className="truncate text-muted-foreground text-sm">
						{event.label ?? "One-off run"} ·{" "}
						<span className={OUTCOME_TEXT[outcome]}>
							{RUN_OUTCOME_LABELS[outcome]}
						</span>
					</p>
				</div>
				{onClose ? (
					<Button
						aria-label="Close run details"
						className="-me-1.5"
						onClick={onClose}
						size="icon-xs"
						type="button"
						variant="ghost-muted"
					>
						<X aria-hidden="true" />
					</Button>
				) : null}
			</div>
			<div className="flex flex-col gap-3">
				<DetailRow icon={<CalendarDays aria-hidden="true" />}>
					<span className="truncate text-foreground leading-5">
						{longDay(item.start)}
					</span>
					<span className="truncate text-muted-foreground text-xs tabular-nums">
						{detail}
					</span>
				</DetailRow>
				<DetailRow
					icon={
						agent ? (
							<BoardAvatar agent={agent} name={agent.name} size={20} />
						) : (
							<Bot aria-hidden="true" />
						)
					}
				>
					{agent ? (
						<>
							<span className="truncate text-foreground leading-5">
								{agent.name}
							</span>
							<span className="truncate text-muted-foreground text-xs">
								{agent.status === "working" ? "Working now" : agent.description}
							</span>
						</>
					) : (
						<span className="text-muted-foreground leading-5">
							No agent: a workflow run
						</span>
					)}
				</DetailRow>
			</div>
			{agent ? (
				<Button
					className="self-start"
					onClick={() => onMessage(agent.id)}
					size="sm"
					type="button"
				>
					<MessageSquarePlus aria-hidden="true" data-icon="inline-start" />
					Message {agent.name}
				</Button>
			) : null}
		</div>
	);
}

/**
 * A run as a button that opens its details in a popover. Open state is
 * controlled, so the keyboard ("Enter opens the day's first item") can open
 * it too.
 */
export function RunPopover({
	active = false,
	className,
	children,
	item,
	onMessage,
	onOpenChange,
	open,
	snapshot,
	tabStop,
	style,
}: {
	active?: boolean;
	children: ReactNode;
	className: string;
	item: RunItem;
	onMessage: (agentId: string) => void;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	snapshot: InterfaceSnapshot;
	style?: CSSProperties;
	tabStop: boolean;
}) {
	return (
		<Popover onOpenChange={onOpenChange} open={open}>
			<PopoverTrigger
				{...{ [CALENDAR_ITEM_ATTRIBUTE]: item.key }}
				aria-current={active ? "true" : undefined}
				aria-label={itemAccessibleName(snapshot, item)}
				className={className}
				style={style}
				tabIndex={tabStop ? 0 : -1}
				type="button"
			>
				{children}
			</PopoverTrigger>
			<PopoverContent
				align="start"
				appearance="composer-menu"
				className="w-80 max-w-[calc(100vw-2rem)]"
				corners="rounded"
				side="right"
				sideOffset={6}
			>
				<RunDetails
					item={item}
					onClose={() => onOpenChange(false)}
					onMessage={(agentId) => {
						onOpenChange(false);
						onMessage(agentId);
					}}
					snapshot={snapshot}
				/>
			</PopoverContent>
		</Popover>
	);
}
