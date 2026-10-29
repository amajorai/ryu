import {
	ArrowLeft01Icon,
	CalendarCheckIn01Icon,
	PlusSignIcon,
	Refresh01Icon,
	ZapIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Toggle } from "@ryu/ui/components/toggle.tsx";
import { useDisplayDayRevision } from "@ryu/ui/lib/display-day.ts";
import { useTimezoneRevision } from "@ryu/ui/lib/timezone.ts";
import { useMemo, useState } from "react";
import { AgendaView } from "@/src/components/calendar/AgendaView.tsx";
import {
	DayPanel,
	MonthView,
} from "@/src/components/calendar/CalendarMonthView.tsx";
import { NewAutomationDialog } from "@/src/components/calendar/NewAutomationDialog.tsx";
import { TimeGridView } from "@/src/components/calendar/TimeGridView.tsx";
import { useCalendarLocale } from "@/src/components/calendar/use-calendar-locale.ts";
import type { ScheduledJob } from "@/src/lib/api/schedules.ts";
import {
	civilDayKey,
	displayCivilDay,
	displayToday,
} from "@/src/lib/calendar/display-days.ts";
import {
	buildCalendarEvents,
	type CalendarEvent,
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
	const locale = useCalendarLocale();
	const [view, setView] = useState<CalendarView>("month");
	// The calendar's days are civil dates in the display time zone, so "today"
	// is that zone's today, which the revisions below keep current when the zone
	// is changed or its midnight passes while the page is open.
	const zoneRevision = useTimezoneRevision();
	useDisplayDayRevision();
	const [cursor, setCursor] = useState(() => displayToday());
	const [selectedDay, setSelectedDay] = useState<Date | null>(null);
	const [newAutomationOpen, setNewAutomationOpen] = useState(false);
	// Core's internal maintenance jobs (identity-vault health, continual-learning
	// cycle) fire hourly and would wall-to-wall the grid, so they are hidden
	// unless the user opts in via the toolbar toggle.
	const [showSystemJobs, setShowSystemJobs] = useState(false);

	const days = useMemo(() => viewDays(view, cursor), [view, cursor]);
	// The fetch window is a pair of display-zone instants, so it follows the zone.
	const range = useMemo(
		() => viewRange(view, cursor),
		[view, cursor, zoneRevision]
	);

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
		return eventsByDay.get(civilDayKey(selectedDay)) ?? [];
	}, [selectedDay, eventsByDay]);

	const handleSelectEvent = (event: CalendarEvent) => {
		setSelectedDay(displayCivilDay(event.start));
	};

	const goToday = () => {
		const today = displayToday();
		setCursor(today);
		setSelectedDay(today);
	};

	const handleRefresh = () => {
		onReload();
	};

	// Only take over the whole surface on the very first load. Once any data
	// exists, a refresh keeps the toolbar and calendar in place (the Refresh
	// control spins instead) so the view never blanks out.
	if (loading && jobs.length === 0) {
		return <SkeletonRows rows={6} spacing="library" />;
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
				<Button className="mt-4" loading={loading} onClick={handleRefresh}>
					<HugeiconsIcon className="size-4" icon={Refresh01Icon} />
					Try again
				</Button>
			</Empty>
		);
	}

	return (
		<div className="relative flex h-full flex-col overflow-hidden">
			{visibleJobs.length === 0 ? (
				<Empty className="h-full" purpose="calendar">
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
						<AgendaView
							days={days}
							eventsByDay={eventsByDay}
							jobs={visibleJobs}
						/>
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

			{/* Floating bottom toolbar — beUI-style pill: a centered, rounded,
			    frosted pill that floats above the calendar, holding the date
			    navigation, the view switcher and the section actions so nothing sits
			    above the grid. The Store and the Library used to share this shape and
			    no longer do (their tabs are inline page furniture now, see
			    StoreSectionTabs) — this is a per-day toolbar over a fixed grid, not an
			    open-ended list of sections, so it stays. */}
			<div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-4 py-3">
				<div className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-1 rounded-full bg-muted/70 p-1.5 shadow-lg backdrop-blur-md">
					<Button
						aria-label="Previous"
						onClick={() => setCursor((c) => navigate(view, c, -1))}
						radius="pill"
						size="icon-sm"
						title="Previous"
						variant="ghost"
					>
						<HugeiconsIcon className="size-4" icon={ArrowLeft01Icon} />
					</Button>
					<Button onClick={goToday} radius="pill" size="sm" variant="ghost">
						Today
					</Button>
					<Button
						aria-label="Next"
						onClick={() => setCursor((c) => navigate(view, c, 1))}
						radius="pill"
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
						{viewLabel(view, cursor, locale)}
					</span>

					<span
						aria-hidden
						className="mx-0.5 h-5 w-px shrink-0 self-center bg-border/60"
					/>

					{CALENDAR_VIEWS.map((option) => (
						<Button
							className=""
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
							onPressedChange={setShowSystemJobs}
							pressed={showSystemJobs}
							purpose="calendar-filter"
							size="sm"
							title="Show Ryu's internal maintenance jobs on the calendar"
						>
							System jobs
						</Toggle>
					)}
					<Button
						aria-label="Refresh"
						loading={loading}
						onClick={handleRefresh}
						radius="pill"
						size="icon-sm"
						title="Refresh"
						variant="ghost"
					>
						<HugeiconsIcon className="size-4" icon={Refresh01Icon} />
					</Button>
					<Button
						onClick={() => setNewAutomationOpen(true)}
						radius="pill"
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
