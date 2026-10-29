// apps/desktop/src/components/calendar/event-display.tsx
//
// Shared rendering bits for the Calendar page's views: the colour tone of an
// event, its short time label, and the full detail row used by the day panel
// and the agenda list.

import {
	CancelCircleIcon,
	CheckmarkCircle02Icon,
	Clock01Icon,
	WorkflowCircle06Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { eventClock } from "@/src/lib/calendar/display-days.ts";
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

/**
 * Short leading label for an event pill: a run count or the start time, read
 * on the display time zone's clock.
 */
export function eventTime(event: CalendarEvent): string {
	if (event.aggregateCount) {
		return `${event.aggregateCount}×`;
	}
	return eventClock(event.start);
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
		<Badge variant="secondary">
			<HugeiconsIcon className="size-3" icon={WorkflowCircle06Icon} />
			{event.workflowName ?? "Workflow"}
		</Badge>
	);
}

/** Full detail card for a single event (day panel + agenda list). */
export function EventRow({ event }: { event: CalendarEvent }) {
	const tl = useLiteralMessages();
	let icon = Clock01Icon;
	let iconColor = "text-primary";
	if (event.kind === "past") {
		icon =
			event.outcome === "success" ? CheckmarkCircle02Icon : CancelCircleIcon;
		iconColor =
			event.outcome === "success"
				? "text-status-success"
				: "text-status-destructive";
	}

	return (
		<div className="flex flex-col gap-1 rounded-md border p-2.5">
			<div className="flex items-center gap-2">
				<HugeiconsIcon
					className={cn("size-4 shrink-0", iconColor)}
					icon={icon}
				/>
				<span
					className="min-w-0 flex-1 truncate font-medium text-sm"
					data-ryu-i18n="off"
					title={event.jobName}
				>
					{event.jobName}
				</span>
				<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
					{event.aggregateCount
						? tl("{aggregateCount} runs", {
								aggregateCount: event.aggregateCount,
							})
						: eventClock(event.start)}
				</span>
			</div>
			<div className="flex flex-wrap items-center gap-1.5 pl-6">
				<Badge variant="secondary">
					<HugeiconsIcon className="size-3" icon={Clock01Icon} />
					{event.scheduleLabel}
				</Badge>
				{targetBadge(event)}
				{event.kind === "upcoming" ? (
					<Badge variant="outline">Upcoming</Badge>
				) : null}
			</div>
			{event.kind === "past" && event.outcome === "failure" && event.error ? (
				<p className="line-clamp-2 pl-6 text-status-destructive text-xs">
					{event.error}
				</p>
			) : null}
		</div>
	);
}
