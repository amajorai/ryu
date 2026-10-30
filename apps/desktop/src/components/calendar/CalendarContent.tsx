import {
	CalendarCheckIn01Icon,
	PlusSignIcon,
	ZapIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useDisplayDayRevision } from "@ryu/ui/lib/display-day.ts";
import { useTimezoneRevision } from "@ryu/ui/lib/timezone.ts";
import { useMemo, useState } from "react";
import { QuietEmpty } from "@/src/components/agents/shared/quiet-empty.tsx";
import { AgendaView } from "@/src/components/calendar/AgendaView.tsx";
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
	type CalendarView,
	navigate,
	viewDays,
	viewLabel,
	viewRange,
} from "@/src/lib/calendar/views.ts";
import { CalendarToolbar } from "./calendar-toolbar.tsx";
import { DayPanel } from "./day-panel.tsx";
import { MonthView } from "./month-view.tsx";

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
	emptyDescription = "Create an automation to see its runs on the calendar.",
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
			<QuietEmpty
				action={
					<Button
						loading={loading}
						onClick={handleRefresh}
						size="sm"
						variant="outline"
					>
						Try again
					</Button>
				}
				className="h-full"
				description="Check your connection and try again."
				icon={CalendarCheckIn01Icon}
				title="Could not load calendar"
			/>
		);
	}

	return (
		<div className="relative flex h-full flex-col overflow-hidden">
			<CalendarToolbar
				hasSystemJobs={hasSystemJobs}
				label={viewLabel(view, cursor, locale)}
				loading={loading}
				onNewAutomation={() => setNewAutomationOpen(true)}
				onNext={() => setCursor((c) => navigate(view, c, 1))}
				onPrevious={() => setCursor((c) => navigate(view, c, -1))}
				onRefresh={handleRefresh}
				onShowSystemJobsChange={setShowSystemJobs}
				onToday={goToday}
				onViewChange={setView}
				showSystemJobs={showSystemJobs}
				view={view}
			/>
			{visibleJobs.length === 0 ? (
				<QuietEmpty
					action={
						<Button
							onClick={() => setNewAutomationOpen(true)}
							size="sm"
							variant="outline"
						>
							<HugeiconsIcon className="size-4" icon={PlusSignIcon} />
							New automation
						</Button>
					}
					className="h-full"
					description={emptyDescription}
					icon={ZapIcon}
					title={emptyTitle}
				/>
			) : (
				<div className="flex min-h-0 flex-1">
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

			<NewAutomationDialog
				defaultAgentId={defaultAgentId}
				onCreated={onReload}
				onOpenChange={setNewAutomationOpen}
				open={newAutomationOpen}
			/>
		</div>
	);
}
