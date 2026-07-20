import {
	ArrowLeft01Icon,
	CalendarCheckIn01Icon,
	PlusSignIcon,
	Refresh01Icon,
	ZapIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { Spinner } from "@ryu/ui/components/spinner";
import { Toggle } from "@ryu/ui/components/toggle";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import { cn } from "@ryu/ui/lib/utils";
import { format, isSameDay, isSameMonth, isToday } from "date-fns";
import { useMemo, useState } from "react";
import { AgendaView } from "@/src/components/calendar/AgendaView.tsx";
import {
	EventRow,
	eventTime,
	eventTone,
} from "@/src/components/calendar/event-display.tsx";
import { NewAutomationDialog } from "@/src/components/calendar/NewAutomationDialog.tsx";
import { TimeGridView } from "@/src/components/calendar/TimeGridView.tsx";
import type { ScheduledJob } from "@/src/lib/api/schedules.ts";
import {
	buildCalendarEvents,
	type CalendarEvent,
	eventDayKey,
	groupEventsByDay,
} from "@/src/lib/calendar/events.ts";
import {
	CALENDAR_VIEWS,
	type CalendarView,
	navigate,
	viewDays,
	viewLabel,
	viewRange,
} from "@/src/lib/calendar/views.ts";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MAX_PILLS_PER_CELL = 3;

function EventPill({
	event,
	onSelect,
}: {
	event: CalendarEvent;
	onSelect: (event: CalendarEvent) => void;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						className={cn(
							"flex w-full items-center gap-1 truncate rounded-sm border-l-2 px-1 py-0.5 text-left text-[11px] leading-tight transition-colors hover:brightness-110",
							eventTone(event)
						)}
						onClick={(e) => {
							e.stopPropagation();
							onSelect(event);
						}}
						type="button"
					>
						<span className="shrink-0 font-medium tabular-nums opacity-70">
							{eventTime(event)}
						</span>
						<span className="truncate">{event.jobName}</span>
					</button>
				}
			/>
			<TooltipContent>{`${event.jobName} — ${event.scheduleLabel}`}</TooltipContent>
		</Tooltip>
	);
}

function DayCell({
	day,
	monthCursor,
	events,
	selected,
	onSelectDay,
	onSelectEvent,
}: {
	day: Date;
	monthCursor: Date;
	events: CalendarEvent[];
	selected: boolean;
	onSelectDay: (day: Date) => void;
	onSelectEvent: (event: CalendarEvent) => void;
}) {
	const inMonth = isSameMonth(day, monthCursor);
	const today = isToday(day);
	const overflow = events.length - MAX_PILLS_PER_CELL;

	return (
		<button
			className={cn(
				"flex min-h-[104px] flex-col gap-1 border-r border-b p-1.5 text-left transition-colors hover:bg-muted/40",
				inMonth ? "bg-background" : "bg-muted/20",
				selected && "ring-1 ring-primary ring-inset"
			)}
			onClick={() => onSelectDay(day)}
			type="button"
		>
			<div className="flex items-center justify-between">
				<span
					className={cn(
						"flex size-6 items-center justify-center rounded-full text-xs",
						today && "bg-primary font-semibold text-primary-foreground",
						!(today || inMonth) && "text-muted-foreground/50",
						!today && inMonth && "text-foreground"
					)}
				>
					{format(day, "d")}
				</span>
				{events.length > 0 && (
					<span className="text-[10px] text-muted-foreground tabular-nums">
						{events.length}
					</span>
				)}
			</div>
			<div className="flex flex-col gap-0.5">
				{events.slice(0, MAX_PILLS_PER_CELL).map((event) => (
					<EventPill event={event} key={event.id} onSelect={onSelectEvent} />
				))}
				{overflow > 0 && (
					<span className="px-1 text-[10px] text-muted-foreground">
						+{overflow} more
					</span>
				)}
			</div>
		</button>
	);
}

function MonthView({
	cursor,
	days,
	eventsByDay,
	selectedDay,
	onSelectDay,
	onSelectEvent,
}: {
	cursor: Date;
	days: Date[];
	eventsByDay: Map<string, CalendarEvent[]>;
	selectedDay: Date | null;
	onSelectDay: (day: Date) => void;
	onSelectEvent: (event: CalendarEvent) => void;
}) {
	return (
		<div className="flex min-w-0 flex-1 flex-col">
			<div className="grid shrink-0 grid-cols-7 border-b">
				{WEEKDAY_LABELS.map((label) => (
					<div
						className="border-r py-1.5 text-center font-medium text-muted-foreground text-xs last:border-r-0"
						key={label}
					>
						{label}
					</div>
				))}
			</div>
			<div className="grid flex-1 auto-rows-fr grid-cols-7 overflow-auto border-l">
				{days.map((day) => (
					<DayCell
						day={day}
						events={eventsByDay.get(eventDayKey(day)) ?? []}
						key={day.toISOString()}
						monthCursor={cursor}
						onSelectDay={onSelectDay}
						onSelectEvent={onSelectEvent}
						selected={!!selectedDay && isSameDay(day, selectedDay)}
					/>
				))}
			</div>
		</div>
	);
}

function DayPanel({
	day,
	events,
	onClose,
}: {
	day: Date;
	events: CalendarEvent[];
	onClose: () => void;
}) {
	return (
		<aside className="flex w-72 shrink-0 flex-col border-l">
			<div className="flex shrink-0 items-center justify-between border-b px-3 py-2.5">
				<div>
					<p className="font-semibold text-sm">{format(day, "EEEE")}</p>
					<p className="text-muted-foreground text-xs">
						{format(day, "MMMM d, yyyy")}
					</p>
				</div>
				<Button onClick={onClose} size="icon" variant="ghost">
					<HugeiconsIcon className="size-4" icon={ArrowLeft01Icon} />
				</Button>
			</div>
			<div className="scroll-fade-effect-y flex-1 overflow-auto p-3">
				{events.length === 0 ? (
					<div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
						<HugeiconsIcon
							className="size-6 opacity-50"
							icon={CalendarCheckIn01Icon}
						/>
						<p className="text-sm">No runs scheduled</p>
					</div>
				) : (
					<div className="flex flex-col gap-2">
						{events.map((event) => (
							<EventRow event={event} key={event.id} />
						))}
					</div>
				)}
			</div>
		</aside>
	);
}

export interface CalendarContentProps {
	defaultAgentId?: string;
	emptyDescription?: string;
	emptyTitle?: string;
	error: string | null;
	jobs: ScheduledJob[];
	loading: boolean;
	onReload: () => Promise<void>;
	workflowNames: Map<string, string>;
}

export function CalendarContent({
	jobs,
	workflowNames,
	loading,
	error,
	onReload,
	defaultAgentId,
	emptyTitle = "No scheduled runs",
	emptyDescription = "Create an automation to see agent and workflow runs appear on the calendar.",
}: CalendarContentProps) {
	const [view, setView] = useState<CalendarView>("month");
	const [cursor, setCursor] = useState(() => new Date());
	const [selectedDay, setSelectedDay] = useState<Date | null>(null);
	const [newAutomationOpen, setNewAutomationOpen] = useState(false);
	// Core's internal maintenance jobs (identity-vault health, continual-learning
	// cycle) fire hourly and would wall-to-wall the grid, so they are hidden
	// unless the user opts in via the toolbar toggle.
	const [showSystemJobs, setShowSystemJobs] = useState(false);

	const days = useMemo(() => viewDays(view, cursor), [view, cursor]);
	const range = useMemo(() => viewRange(view, cursor), [view, cursor]);

	const hasSystemJobs = useMemo(() => jobs.some((j) => j.system), [jobs]);
	const visibleJobs = useMemo(
		() => (showSystemJobs ? jobs : jobs.filter((j) => !j.system)),
		[jobs, showSystemJobs]
	);

	const eventsByDay = useMemo(() => {
		const events = buildCalendarEvents(
			visibleJobs,
			range.start,
			range.end,
			workflowNames
		);
		return groupEventsByDay(events);
	}, [visibleJobs, range, workflowNames]);

	const selectedDayEvents = useMemo(() => {
		if (!selectedDay) {
			return [];
		}
		return eventsByDay.get(eventDayKey(selectedDay)) ?? [];
	}, [selectedDay, eventsByDay]);

	const handleSelectEvent = (event: CalendarEvent) => {
		setSelectedDay(event.start);
	};

	const goToday = () => {
		const now = new Date();
		setCursor(now);
		setSelectedDay(now);
	};

	const handleRefresh = () => {
		onReload();
	};

	// Only take over the whole surface on the very first load. Once any data
	// exists, a refresh keeps the toolbar and calendar in place (the Refresh
	// control spins instead) so the view never blanks out.
	if (loading && jobs.length === 0) {
		return (
			<div className="flex h-full items-center justify-center">
				<Spinner />
			</div>
		);
	}

	if (error) {
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={CalendarCheckIn01Icon} />
					</EmptyMedia>
					<EmptyTitle>Could not load calendar</EmptyTitle>
					<EmptyDescription>
						Something went wrong while loading your scheduled runs. Check your
						connection and try again.
					</EmptyDescription>
				</EmptyHeader>
				<Button className="mt-4" disabled={loading} onClick={handleRefresh}>
					<HugeiconsIcon
						className={cn("size-4", loading && "animate-spin")}
						icon={Refresh01Icon}
					/>
					Try again
				</Button>
			</Empty>
		);
	}

	return (
		<div className="relative flex h-full flex-col overflow-hidden">
			{visibleJobs.length === 0 ? (
				<Empty className="h-full pb-24">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<HugeiconsIcon icon={ZapIcon} />
						</EmptyMedia>
						<EmptyTitle>{emptyTitle}</EmptyTitle>
						<EmptyDescription>{emptyDescription}</EmptyDescription>
						<Button
							className="mt-4"
							onClick={() => setNewAutomationOpen(true)}
							size="sm"
						>
							<HugeiconsIcon className="size-4" icon={PlusSignIcon} />
							New automation
						</Button>
					</EmptyHeader>
				</Empty>
			) : (
				<div className="flex min-h-0 flex-1 pb-20">
					{view === "month" && (
						<MonthView
							cursor={cursor}
							days={days}
							eventsByDay={eventsByDay}
							onSelectDay={setSelectedDay}
							onSelectEvent={handleSelectEvent}
							selectedDay={selectedDay}
						/>
					)}
					{(view === "week" || view === "day") && (
						<TimeGridView
							days={days}
							eventsByDay={eventsByDay}
							onSelectEvent={handleSelectEvent}
						/>
					)}
					{view === "agenda" && (
						<AgendaView days={days} eventsByDay={eventsByDay} />
					)}

					{view !== "agenda" && selectedDay && (
						<DayPanel
							day={selectedDay}
							events={selectedDayEvents}
							onClose={() => setSelectedDay(null)}
						/>
					)}
				</div>
			)}

			{/* Floating bottom toolbar — beUI-style pill, matching the Store's
			    StoreSectionNav (packages/blocks/src/desktop/store.tsx): a centered,
			    rounded, frosted pill that floats above the calendar. Holds the date
			    navigation, the view switcher, and the section actions, so nothing
			    sits above the grid anymore. */}
			<div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-4 py-3">
				<div className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-1 rounded-full bg-muted/70 p-1.5 shadow-lg backdrop-blur-md">
					<Button
						aria-label="Previous"
						className="rounded-full"
						onClick={() => setCursor((c) => navigate(view, c, -1))}
						size="icon-sm"
						title="Previous"
						variant="ghost"
					>
						<HugeiconsIcon className="size-4" icon={ArrowLeft01Icon} />
					</Button>
					<Button
						className="rounded-full"
						onClick={goToday}
						size="sm"
						variant="ghost"
					>
						Today
					</Button>
					<Button
						aria-label="Next"
						className="rounded-full"
						onClick={() => setCursor((c) => navigate(view, c, 1))}
						size="icon-sm"
						title="Next"
						variant="ghost"
					>
						<HugeiconsIcon
							className="size-4 rotate-180"
							icon={ArrowLeft01Icon}
						/>
					</Button>
					<span className="px-2 font-medium text-sm tabular-nums">
						{viewLabel(view, cursor)}
					</span>

					<span
						aria-hidden
						className="mx-0.5 h-5 w-px shrink-0 self-center bg-border/60"
					/>

					{CALENDAR_VIEWS.map((option) => (
						<Button
							className="rounded-full"
							key={option.value}
							onClick={() => setView(option.value)}
							size="sm"
							variant={view === option.value ? "secondary" : "ghost"}
						>
							{option.label}
						</Button>
					))}

					<span
						aria-hidden
						className="mx-0.5 h-5 w-px shrink-0 self-center bg-border/60"
					/>

					{hasSystemJobs && (
						<Toggle
							aria-label="Show system jobs"
							className="rounded-full text-muted-foreground text-xs aria-pressed:text-foreground"
							onPressedChange={setShowSystemJobs}
							pressed={showSystemJobs}
							size="sm"
							title="Show Ryu's internal maintenance jobs on the calendar"
						>
							System jobs
						</Toggle>
					)}
					<Button
						aria-label="Refresh"
						className="rounded-full"
						disabled={loading}
						onClick={handleRefresh}
						size="icon-sm"
						title="Refresh"
						variant="ghost"
					>
						<HugeiconsIcon
							className={cn("size-4", loading && "animate-spin")}
							icon={Refresh01Icon}
						/>
					</Button>
					<Button
						className="rounded-full"
						onClick={() => setNewAutomationOpen(true)}
						size="sm"
					>
						<HugeiconsIcon className="size-4" icon={PlusSignIcon} />
						New automation
					</Button>
				</div>
			</div>

			<NewAutomationDialog
				defaultAgentId={defaultAgentId}
				onCreated={onReload}
				onOpenChange={setNewAutomationOpen}
				open={newAutomationOpen}
			/>
		</div>
	);
}
