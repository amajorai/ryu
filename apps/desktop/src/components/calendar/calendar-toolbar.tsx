import {
	ArrowLeft01Icon,
	PlusSignIcon,
	Refresh01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Toggle } from "@ryu/ui/components/toggle.tsx";
import { CALENDAR_VIEWS, type CalendarView } from "@/src/lib/calendar/views.ts";

/** Date navigation, view switcher and section actions for the calendar. */
export function CalendarToolbar({
	hasSystemJobs,
	label,
	loading,
	onNewAutomation,
	onNext,
	onPrevious,
	onRefresh,
	onShowSystemJobsChange,
	onToday,
	onViewChange,
	showSystemJobs,
	view,
}: {
	hasSystemJobs: boolean;
	label: string;
	loading: boolean;
	onNewAutomation: () => void;
	onNext: () => void;
	onPrevious: () => void;
	onRefresh: () => void;
	onShowSystemJobsChange: (pressed: boolean) => void;
	onToday: () => void;
	onViewChange: (view: CalendarView) => void;
	showSystemJobs: boolean;
	view: CalendarView;
}) {
	return (
		<div className="flex min-h-10 shrink-0 flex-wrap items-center gap-1 border-border border-b px-2 py-1">
			<Button
				aria-label="Previous"
				onClick={onPrevious}
				size="icon-sm"
				title="Previous"
				variant="ghost-muted"
			>
				<HugeiconsIcon className="size-4" icon={ArrowLeft01Icon} />
			</Button>
			<Button
				aria-label="Next"
				onClick={onNext}
				size="icon-sm"
				title="Next"
				variant="ghost-muted"
			>
				<HugeiconsIcon className="size-4 rotate-180" icon={ArrowLeft01Icon} />
			</Button>
			<Button onClick={onToday} size="sm" variant="ghost">
				Today
			</Button>
			<span className="truncate px-2 font-medium text-sm tabular-nums">
				{label}
			</span>

			<div className="ml-auto flex flex-wrap items-center gap-1">
				{CALENDAR_VIEWS.map((option) => (
					<Button
						aria-pressed={view === option.value}
						className={
							view === option.value ? "bg-muted text-foreground" : undefined
						}
						key={option.value}
						onClick={() => onViewChange(option.value)}
						size="sm"
						variant={view === option.value ? "ghost" : "ghost-muted"}
					>
						{option.label}
					</Button>
				))}
				{hasSystemJobs && (
					<Toggle
						aria-label="Show system jobs"
						onPressedChange={onShowSystemJobsChange}
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
					onClick={onRefresh}
					size="icon-sm"
					title="Refresh"
					variant="ghost-muted"
				>
					<HugeiconsIcon className="size-4" icon={Refresh01Icon} />
				</Button>
				<Button onClick={onNewAutomation} size="sm" variant="outline">
					<HugeiconsIcon className="size-4" icon={PlusSignIcon} />
					New automation
				</Button>
			</div>
		</div>
	);
}
