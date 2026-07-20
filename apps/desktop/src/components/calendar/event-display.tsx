// apps/desktop/src/components/calendar/event-display.tsx
//
// Shared rendering bits for the Calendar page's views: the colour tone of an
// event, its short time label, and the full detail row used by the day panel
// and the agenda list.

import {
	CancelCircleIcon,
	CheckmarkCircle02Icon,
	Clock01Icon,
	WorkflowSquare01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { cn } from "@ryu/ui/lib/utils";
import { format } from "date-fns";
import type { CalendarEvent } from "@/src/lib/calendar/events.ts";

/** Border/background tone reflecting an event's kind and outcome. */
export function eventTone(event: CalendarEvent): string {
	if (event.kind === "past") {
		return event.outcome === "success"
			? "border-l-green-500 bg-success/10 text-foreground"
			: "border-l-destructive bg-destructive/10 text-foreground";
	}
	return "border-l-primary bg-primary/10 text-foreground";
}

/** Short leading label for an event pill: a run count or the start time. */
export function eventTime(event: CalendarEvent): string {
	if (event.aggregateCount) {
		return `${event.aggregateCount}×`;
	}
	return format(event.start, "HH:mm");
}

/** Badge naming what an event's job runs: system job, agent, or workflow. */
function targetBadge(event: CalendarEvent) {
	if (event.system) {
		return <Badge variant="secondary">System</Badge>;
	}
	if (event.agentId) {
		return <Badge variant="secondary">{event.agentId}</Badge>;
	}
	return (
		<Badge className="gap-1" variant="secondary">
			<HugeiconsIcon className="size-3" icon={WorkflowSquare01Icon} />
			{event.workflowName ?? "Workflow"}
		</Badge>
	);
}

/** Full detail card for a single event (day panel + agenda list). */
export function EventRow({ event }: { event: CalendarEvent }) {
	let icon = Clock01Icon;
	let iconColor = "text-primary";
	if (event.kind === "past") {
		icon =
			event.outcome === "success" ? CheckmarkCircle02Icon : CancelCircleIcon;
		iconColor =
			event.outcome === "success" ? "text-success" : "text-destructive";
	}

	return (
		<div className="flex flex-col gap-1 rounded-md border p-2.5">
			<div className="flex items-center gap-2">
				<HugeiconsIcon
					className={cn("size-4 shrink-0", iconColor)}
					icon={icon}
				/>
				<span className="min-w-0 flex-1 truncate font-medium text-sm">
					{event.jobName}
				</span>
				<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
					{event.aggregateCount
						? `${event.aggregateCount} runs`
						: format(event.start, "HH:mm")}
				</span>
			</div>
			<div className="flex flex-wrap items-center gap-1.5 pl-6">
				<Badge className="gap-1" variant="secondary">
					<HugeiconsIcon className="size-3" icon={Clock01Icon} />
					{event.scheduleLabel}
				</Badge>
				{targetBadge(event)}
				{event.kind === "upcoming" ? (
					<Badge variant="outline">Upcoming</Badge>
				) : null}
			</div>
			{event.kind === "past" && event.outcome === "failure" && event.error ? (
				<p className="line-clamp-2 pl-6 text-destructive text-xs">
					{event.error}
				</p>
			) : null}
		</div>
	);
}
