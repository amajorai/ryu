import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { useId } from "react";
import {
	countdown,
	formatWeekdayClock,
	type TickerRun,
} from "./ticker-model.ts";
import { SYMBOL_TEXT } from "./ticker-parts.tsx";

function cadenceOf(run: TickerRun): string {
	const { event } = run;
	if (event.label?.trim()) {
		return event.label.trim();
	}
	return event.count && event.count > 1
		? `${event.count} times a day`
		: "Scheduled";
}

/**
 * One run, laid out like a watchlist row so its edges line up with the table
 * above: title over symbol and cadence on the left, countdown over the start
 * time on the right.
 */
function RunBody({ now, run }: { now: number; run: TickerRun }) {
	const { event } = run;
	return (
		<>
			<span className="flex min-w-0 flex-col gap-0.5">
				<span className="truncate text-foreground text-sm">{event.title}</span>
				<span className="flex min-w-0 items-baseline gap-1.5 text-muted-foreground text-xs">
					{run.symbol ? (
						<span className={cn(SYMBOL_TEXT, "text-xs")}>{run.symbol}</span>
					) : (
						<span>All agents</span>
					)}
					<span aria-hidden="true">·</span>
					<span className="truncate">{cadenceOf(run)}</span>
				</span>
			</span>
			<span className="flex shrink-0 flex-col items-end gap-0.5 tabular-nums">
				<span className="text-foreground text-sm">
					{countdown(event.start, now)}
				</span>
				<span className="text-muted-foreground text-xs">
					{formatWeekdayClock(Date.parse(event.start))}
				</span>
			</span>
		</>
	);
}

/**
 * Scheduled runs still ahead, like a market's earnings calendar. A run that
 * targets an agent selects its ticker; workspace-wide runs read "All agents".
 */
export function TickerCalendar({
	className,
	now,
	onSelect,
	runs,
}: {
	className?: string;
	now: number;
	onSelect: (agentId: string) => void;
	runs: TickerRun[];
}) {
	const tl = useLiteralMessages();
	const headingId = useId();
	if (runs.length === 0) {
		return null;
	}
	const rowClass =
		"flex w-full items-start justify-between gap-4 px-4 py-2 text-start";
	return (
		<section
			aria-labelledby={headingId}
			className={cn("border-border border-t", className)}
		>
			<h3
				className="flex h-11 items-center px-4 font-semibold text-foreground text-sm"
				id={headingId}
			>
				Upcoming runs
			</h3>
			<ul className="flex flex-col pb-2">
				{runs.map((run) => {
					const agentId = run.agentId;
					return (
						<li key={run.event.id}>
							{agentId && run.symbol ? (
								<button
									aria-label={tl("{title}, {countdown}. Show {symbol}", {
										countdown: countdown(run.event.start, now),
										symbol: run.symbol,
										title: run.event.title,
									})}
									className={cn(
										rowClass,
										"outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
									)}
									onClick={() => onSelect(agentId)}
									type="button"
								>
									<RunBody now={now} run={run} />
								</button>
							) : (
								<div className={rowClass}>
									<RunBody now={now} run={run} />
								</div>
							)}
						</li>
					);
				})}
			</ul>
		</section>
	);
}
