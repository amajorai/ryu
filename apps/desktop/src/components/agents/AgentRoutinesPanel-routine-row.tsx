// apps/desktop/src/components/agents/AgentRoutinesPanel-routine-row.tsx
//
// One routine row of the agent routines panel.

import { Delete02Icon, Edit02Icon, PlayIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { RunStatusTimeline } from "@ryu/ui/components/run-status-timeline.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ScheduledJob } from "@/src/lib/api/schedules.ts";
import {
	buildRunStatusTimelineEntries,
	type CalendarEvent,
	describeSchedule,
} from "@/src/lib/calendar/events.ts";
import {
	formatLastRun,
	type RoutineStatus,
} from "./AgentRoutinesPanel-model.ts";
import { StatusPill } from "./AgentRoutinesPanel-status-pill.tsx";

/** One routine: name, status, schedule, last run, actions and its 24-hour timeline. */
export function RoutineRow({
	disabled,
	job,
	jobEvents,
	onDelete,
	onEdit,
	onRun,
	running,
	status,
	windowEnd,
	windowStart,
}: {
	disabled: boolean;
	job: ScheduledJob;
	jobEvents: CalendarEvent[];
	onDelete: () => void;
	onEdit: () => void;
	onRun: () => void;
	running: boolean;
	status: RoutineStatus;
	windowEnd: Date;
	windowStart: Date;
}) {
	const tl = useLiteralMessages();
	return (
		<div
			className="group/routine border-border border-b py-3 last:border-b-0"
			data-testid="agent-routine-row"
			role="listitem"
		>
			<div className="flex flex-col gap-2">
				<div className="flex items-start gap-3">
					<div className="min-w-0 flex-1">
						<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
							<p className="truncate font-medium text-sm" title={job.name}>
								{job.name}
							</p>
							<StatusPill status={status} />
						</div>
						<p className="mt-0.5 truncate text-detail text-muted-foreground">
							{describeSchedule(job.schedule)} ·{" "}
							{job.target.type === "agent" && job.target.conversationId
								? "Persistent chat"
								: "New chat each run"}{" "}
							· {formatLastRun(job)}
						</p>
					</div>
					<div
						className={cn(
							"flex shrink-0 items-center gap-1 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/routine:opacity-100 group-hover/routine:duration-0",
							running && "opacity-100"
						)}
					>
						<Button
							disabled={disabled || running}
							loading={running}
							onClick={onRun}
							size="icon-sm"
							variant="ghost-muted"
						>
							<span className="sr-only">
								{tl("Run {name} now", { name: job.name })}
							</span>
							<HugeiconsIcon className="size-4" icon={PlayIcon} />
						</Button>
						<Button
							aria-label={tl("Edit {name}", { name: job.name })}
							disabled={disabled}
							onClick={onEdit}
							size="icon-sm"
							variant="ghost-muted"
						>
							<HugeiconsIcon className="size-4" icon={Edit02Icon} />
						</Button>
						<Button
							aria-label={tl("Delete {name}", { name: job.name })}
							disabled={disabled}
							onClick={onDelete}
							size="icon-sm"
							variant="ghost-muted"
						>
							<HugeiconsIcon className="size-4" icon={Delete02Icon} />
						</Button>
					</div>
				</div>
				<RunStatusTimeline
					ariaLabel={tl("{name} run status for the last 24 hours", {
						name: job.name,
					})}
					endAt={windowEnd.getTime()}
					entries={buildRunStatusTimelineEntries(
						windowStart,
						windowEnd,
						jobEvents
					)}
					startAt={windowStart.getTime()}
				/>
			</div>
		</div>
	);
}
