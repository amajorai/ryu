// apps/desktop/src/components/calendar/event-display.tsx
//
// Shared rendering bits for the Calendar page's views: the colour tone of an
// event, its short time label, and the full detail row used by the day panel
// and the agenda list.

import {
	CancelCircleIcon,
	CheckmarkCircle02Icon,
	Clock01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import { InlineErrorRow } from "@/src/components/chat/InlineErrorRow.tsx";
import { eventClock } from "@/src/lib/calendar/display-days.ts";
import type { CalendarEvent } from "@/src/lib/calendar/events.ts";

/** Background tone reflecting an event's kind and outcome. Runs are plain
 *  muted pills (past ones dimmer); only a failure carries a tint. */
export function eventTone(event: CalendarEvent): string {
	if (event.kind === "past") {
		return event.outcome === "success"
			? "bg-muted text-muted-foreground"
			: "bg-destructive/10 text-foreground";
	}
	return "bg-muted text-foreground";
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

/** Plain label naming what an event's job runs: system job, agent, or workflow. */
function targetLabel(event: CalendarEvent): string {
	if (event.system) {
		return "System";
	}
	if (event.agentId) {
		return event.agentId;
	}
	return event.workflowName ?? "Workflow";
}

/** One hairline row for a single event (day panel + agenda list). */
export function EventRow({ event }: { event: CalendarEvent }) {
	const tl = useLiteralMessages();
	let icon = Clock01Icon;
	let iconColor = "text-muted-foreground";
	if (event.kind === "past") {
		icon =
			event.outcome === "success" ? CheckmarkCircle02Icon : CancelCircleIcon;
		iconColor =
			event.outcome === "success"
				? "text-muted-foreground"
				: "text-status-destructive";
	}

	return (
		<div className="flex flex-col gap-0.5 border-border border-b py-2 last:border-b-0">
			<div className="flex items-center gap-2">
				<HugeiconsIcon
					className={cn("size-4 shrink-0", iconColor)}
					icon={icon}
				/>
				<span
					className="min-w-0 flex-1 truncate text-sm"
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
			<p className="truncate pl-6 text-detail text-muted-foreground">
				{event.scheduleLabel} · {targetLabel(event)}
			</p>
			{event.kind === "past" && event.outcome === "failure" && event.error ? (
				<InlineErrorRow
					className="h-6 pl-6"
					details={event.error}
					message="This run failed."
				/>
			) : null}
		</div>
	);
}
