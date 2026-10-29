import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceAgent,
	type InterfaceEvent,
	THREAD_STATUS_LABELS,
	THREAD_STATUS_ORDER,
} from "@ryuhq/protocol/interfaces";
import { useId } from "react";
import {
	eventDay,
	eventSchedule,
	eventTime,
	type NewspaperGlance,
} from "./newspaper-model.ts";
import { BoxHead, SMALL_CAPS } from "./newspaper-parts.tsx";

/** "At a glance": the paper's numbers box, one ruled row per status. */
export function AtAGlance({
	agentCount,
	agentsWorking,
	counts,
	id,
}: {
	agentCount: number;
	agentsWorking: number;
	counts: NewspaperGlance;
	id: string;
}) {
	const headingId = useId();
	const rows: { label: string; value: number }[] = [
		...THREAD_STATUS_ORDER.map((status) => ({
			label: THREAD_STATUS_LABELS[status],
			value: counts[status],
		})),
	];
	return (
		<section aria-labelledby={headingId} id={id}>
			<BoxHead id={headingId}>At a glance</BoxHead>
			<dl>
				{rows.map((row) => (
					<div
						className="flex items-baseline justify-between gap-4 border-border border-b py-2 first:pt-0"
						key={row.label}
					>
						<dt className="text-foreground text-sm">{row.label}</dt>
						<dd
							className={cn(
								"font-semibold font-serif text-lg tabular-nums leading-6",
								row.value === 0 ? "text-muted-foreground" : "text-foreground"
							)}
						>
							{row.value}
						</dd>
					</div>
				))}
				<div className="flex items-baseline justify-between gap-4 py-2">
					<dt className="text-foreground text-sm">Agents at work</dt>
					<dd className="font-semibold font-serif text-foreground text-lg tabular-nums leading-6">
						{agentsWorking}
						<span className="font-normal text-muted-foreground">
							{" "}
							of {agentCount}
						</span>
					</dd>
				</div>
			</dl>
		</section>
	);
}

/** "Upcoming": the next scheduled runs, a time column beside each title. */
export function UpcomingRuns({
	agents,
	events,
	id,
	now,
}: {
	agents: InterfaceAgent[];
	events: InterfaceEvent[];
	id: string;
	now: number;
}) {
	const headingId = useId();
	return (
		<section aria-labelledby={headingId} id={id}>
			<BoxHead id={headingId}>Upcoming</BoxHead>
			{events.length === 0 ? (
				<p className="text-muted-foreground text-sm">Nothing is scheduled.</p>
			) : (
				<ol>
					{events.map((event) => {
						const agent = agents.find((item) => item.id === event.agentId);
						const schedule = eventSchedule(event);
						return (
							<li
								className="grid grid-cols-[5.5rem_1fr] gap-3 border-border border-b py-3 first:pt-0 last:border-b-0"
								key={event.id}
							>
								<time className="flex flex-col" dateTime={event.start}>
									<span className={cn(SMALL_CAPS, "text-foreground")}>
										{eventDay(event.start, now)}
									</span>
									<span className="text-muted-foreground text-xs tabular-nums leading-5">
										{eventTime(event.start)}
									</span>
								</time>
								<div className="min-w-0">
									<p className="font-semibold font-serif text-[15px] text-foreground leading-5">
										{event.title}
									</p>
									<p className="mt-1 text-muted-foreground text-xs leading-4">
										{[schedule, agent?.name].filter(Boolean).join(" · ")}
									</p>
								</div>
							</li>
						);
					})}
				</ol>
			)}
		</section>
	);
}
