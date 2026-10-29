import type {
	InterfaceEvent,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { arenaUpcomingRuns, untilLabel } from "./arena-model.ts";
import { agentById } from "./interface-renderer.ts";

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
	day: "numeric",
	hour: "numeric",
	minute: "2-digit",
	month: "short",
	weekday: "short",
});

function runCount(event: InterfaceEvent): string {
	return event.count && event.count > 1 ? `${event.count} runs` : "";
}

/**
 * What the wall's agents will do next: the soonest scheduled runs, read-only,
 * so a quiet wall still shows when work is about to start.
 */
export function ArenaSchedule({
	now,
	snapshot,
}: {
	now: number;
	snapshot: InterfaceSnapshot;
}) {
	const runs = arenaUpcomingRuns(snapshot.events, now);
	if (runs.length === 0) {
		return null;
	}
	const headingId = "arena-schedule-heading";
	return (
		<section
			aria-labelledby={headingId}
			className="flex min-w-0 flex-col gap-2"
		>
			<h2
				className="flex items-baseline gap-2 text-sm leading-5"
				id={headingId}
			>
				<span className="font-semibold text-foreground">Scheduled</span>
				<span className="font-normal text-muted-foreground tabular-nums">
					{runs.length}
				</span>
			</h2>
			<ul className="flex flex-col">
				{runs.map((event) => {
					const agent = agentById(snapshot, event.agentId);
					const extra = [event.label, runCount(event)]
						.filter(Boolean)
						.join(" · ");
					return (
						<li
							className="flex h-10 min-w-0 items-center gap-3 text-sm leading-5"
							key={event.id}
						>
							<time
								className="w-14 shrink-0 text-muted-foreground tabular-nums"
								dateTime={event.start}
								title={TIME_FORMAT.format(new Date(event.start))}
							>
								{untilLabel(event.start, now)}
							</time>
							<span className="min-w-0 truncate">
								<span className="font-medium text-foreground">
									{event.title}
								</span>
								<span className="text-muted-foreground">
									{agent ? ` · ${agent.name}` : ""}
								</span>
							</span>
							{extra ? (
								<span className="ms-auto shrink-0 text-[13px] text-muted-foreground leading-4 max-sm:hidden">
									{extra}
								</span>
							) : null}
						</li>
					);
				})}
			</ul>
		</section>
	);
}
