import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { type KeyboardEvent, useId, useRef, useState } from "react";
import {
	DAY_LEVEL_LABELS,
	type DayLevel,
	describeActivity,
	describeDay,
	formatUptime,
	type StatusComponent,
	UPTIME_DAYS,
} from "./status-model.ts";

export const DAY_BAR: Record<DayLevel, string> = {
	degraded: "bg-warning",
	operational: "bg-success",
	outage: "bg-destructive",
};

/** Problems listed in a day's tooltip before collapsing to "and N more". */
const TOOLTIP_PROBLEMS = 3;
/** Matches `w-64`: the tooltip never runs past either end of the strip. */
const TOOLTIP_WIDTH = "16rem";

const dayFormat = new Intl.DateTimeFormat("en-US", {
	day: "numeric",
	month: "short",
	weekday: "short",
	year: "numeric",
});

/**
 * A component's 30-day history: one bar per day, coloured by that day's worst
 * moment, with a Statuspage-style legend below. Hover, focus, or tap a bar for
 * the day's detail. The strip is one tab stop; arrow keys walk the days.
 */
export function StatusUptime({ component }: { component: StatusComponent }) {
	const tl = useLiteralMessages();
	const { agent, days, uptime } = component;
	const tooltipId = useId();
	const listRef = useRef<HTMLOListElement>(null);
	const [shown, setShown] = useState<number | null>(null);
	const [focusIndex, setFocusIndex] = useState(days.length - 1);
	const shownDay = shown === null ? undefined : days[shown];

	const moveTo = (index: number) => {
		const next = Math.min(days.length - 1, Math.max(0, index));
		setFocusIndex(next);
		setShown(next);
		listRef.current
			?.querySelectorAll<HTMLButtonElement>("button")
			[next]?.focus();
	};

	const onKeyDown = (event: KeyboardEvent<HTMLOListElement>) => {
		const keys: Record<string, number> = {
			ArrowLeft: focusIndex - 1,
			ArrowRight: focusIndex + 1,
			End: days.length - 1,
			Home: 0,
		};
		const target = keys[event.key];
		if (target !== undefined) {
			event.preventDefault();
			moveTo(target);
			return;
		}
		if (event.key === "Escape" && shown !== null) {
			event.preventDefault();
			event.stopPropagation();
			setShown(null);
		}
	};

	const position =
		shown === null ? 0 : ((shown + 0.5) / Math.max(1, days.length)) * 100;

	return (
		<div className="flex flex-col gap-2">
			<div className="relative">
				<ol
					aria-label={tl("{agentName}, last {uptimeDays} days", {
						agentName: agent.name,
						uptimeDays: UPTIME_DAYS,
					})}
					className="flex h-8 items-stretch gap-0.5 sm:gap-1"
					onBlur={(event) => {
						if (!event.currentTarget.contains(event.relatedTarget)) {
							setShown(null);
						}
					}}
					onKeyDown={onKeyDown}
					onMouseLeave={() => {
						if (!listRef.current?.contains(document.activeElement)) {
							setShown(null);
						}
					}}
					ref={listRef}
				>
					{days.map((day, index) => (
						<li className="flex min-w-0 flex-1" key={day.key}>
							<button
								aria-describedby={shown === index ? tooltipId : undefined}
								aria-label={`${dayFormat.format(day.start)}: ${describeDay(day)}`}
								className={cn(
									"w-full rounded-xs outline-none transition-opacity duration-100 hover:opacity-70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
									DAY_BAR[day.level],
									shown === index && "opacity-70"
								)}
								data-level={day.level}
								onClick={() => {
									setFocusIndex(index);
									setShown((current) => (current === index ? null : index));
								}}
								onFocus={() => {
									setFocusIndex(index);
									setShown(index);
								}}
								onMouseEnter={() => setShown(index)}
								tabIndex={index === focusIndex ? 0 : -1}
								type="button"
							/>
						</li>
					))}
				</ol>
				{shownDay ? (
					<div
						className="pointer-events-none absolute bottom-full z-30 mb-2 flex w-64 flex-col gap-2 rounded-md border border-border bg-popover p-3 text-popover-foreground text-xs shadow-md"
						id={tooltipId}
						role="tooltip"
						style={{
							left: `clamp(0px, calc(${position}% - ${TOOLTIP_WIDTH} / 2), calc(100% - ${TOOLTIP_WIDTH}))`,
						}}
					>
						<p className="font-semibold text-foreground">
							{dayFormat.format(shownDay.start)}
						</p>
						<p className="flex items-center gap-2">
							<span
								aria-hidden="true"
								className={cn("size-2 rounded-xs", DAY_BAR[shownDay.level])}
							/>
							{shownDay.level === "operational"
								? describeDay(shownDay)
								: DAY_LEVEL_LABELS[shownDay.level]}
						</p>
						{shownDay.problems.length > 0 ? (
							<div className="flex flex-col gap-1 border-border border-t pt-2">
								<p className="text-muted-foreground">Related</p>
								<ul className="flex flex-col gap-1">
									{shownDay.problems
										.slice(0, TOOLTIP_PROBLEMS)
										.map((title, index) => (
											<li
												className="truncate font-medium"
												key={`${index}-${title}`}
											>
												{title}
											</li>
										))}
								</ul>
								{shownDay.problems.length > TOOLTIP_PROBLEMS ? (
									<p className="text-muted-foreground">
										{tl("and {count} more", {
											count: String(
												shownDay.problems.length - TOOLTIP_PROBLEMS
											),
										})}
									</p>
								) : null}
							</div>
						) : null}
						{describeActivity(shownDay) ? (
							<p className="text-muted-foreground">
								{describeActivity(shownDay)}
							</p>
						) : null}
					</div>
				) : null}
			</div>
			<div
				aria-hidden="true"
				className="flex items-center gap-3 text-muted-foreground text-xs tabular-nums"
			>
				<span>{tl("{uptimeDays} days ago", { uptimeDays: UPTIME_DAYS })}</span>
				<span className="h-px flex-1 bg-border" />
				<span className="text-foreground">
					{tl("{uptimePercent}% uptime", {
						uptimePercent: formatUptime(uptime),
					})}
				</span>
				<span className="h-px flex-1 bg-border" />
				<span>Today</span>
			</div>
			<p className="sr-only">
				{tl("{uptimePercent}% uptime over the last {uptimeDays} days.", {
					uptimeDays: UPTIME_DAYS,
					uptimePercent: formatUptime(uptime),
				})}
			</p>
		</div>
	);
}
