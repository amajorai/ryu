import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { type KeyboardEvent, useId, useState } from "react";
import {
	type BankSpendDay,
	formatMoney,
	niceCeiling,
	shortDay,
	shortWeekday,
	transactionCountLabel,
} from "./bank-model.ts";

/** Minimum visible height for a day with spend, so tiny days still read. */
const MIN_BAR_PERCENT = 3;

/** One day as the readout line says it: `Wed, Sep 16 · $0.0092 · 2 transactions`. */
function dayReadout(
	day: BankSpendDay,
	isToday: boolean,
	currency: string
): string[] {
	const name = isToday ? "Today" : shortWeekday(day.date);
	if (day.count === 0) {
		return [name, isToday ? "No spend yet" : "No spend"];
	}
	return [
		name,
		formatMoney(day.spent, currency),
		transactionCountLabel(day.count),
	];
}

/**
 * Daily spend columns for the last 30 days, Monzo-style: one series in the
 * theme's solid primary, a faint baseline tick for days with no spend, and the
 * scale (a rounded top tick and zero) in a gutter on the right. The section
 * heading doubles as the readout line: hovering or arrowing to a day quiets
 * the others and swaps the heading for that day's figures, so nothing floats
 * over the chart. A hidden table carries every value for readers who cannot
 * see the bars.
 */
export function BankSpendChart({
	currency,
	days,
	headingId,
	title,
}: {
	currency: string;
	days: BankSpendDay[];
	headingId: string;
	title: string;
}) {
	const tl = useLiteralMessages();
	const [active, setActive] = useState<number | null>(null);
	const captionId = useId();
	const peak = Math.max(0, ...days.map((day) => day.spent));
	const max = niceCeiling(peak);
	const lastIndex = days.length - 1;
	const activeDay = active === null ? undefined : days[active];
	const first = days[0];
	const middleIndex = Math.floor(lastIndex / 2);
	const middle = days[middleIndex];
	const readIndex = active ?? lastIndex;
	const readDay = days[readIndex];
	const readout = readDay
		? dayReadout(readDay, readIndex === lastIndex, currency).join(", ")
		: "No days";

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const current = active ?? lastIndex;
		let next: number | null = null;
		if (event.key === "ArrowLeft") {
			next = Math.max(0, current - 1);
		} else if (event.key === "ArrowRight") {
			next = Math.min(lastIndex, current + 1);
		} else if (event.key === "Home") {
			next = 0;
		} else if (event.key === "End") {
			next = lastIndex;
		}
		if (next !== null) {
			event.preventDefault();
			setActive(next);
		}
	};

	const barCenter = (index: number) =>
		`${((index + 0.5) / Math.max(1, days.length)) * 100}%`;

	return (
		<figure className="flex flex-1 flex-col" data-testid="bank-spend-chart">
			<figcaption className="sr-only" id={captionId}>
				{tl("Daily spend over the last {dayCount} days", {
					dayCount: days.length,
				})}
			</figcaption>
			<div className="grid h-5 items-center text-sm">
				<h2
					className={cn(
						"col-start-1 row-start-1 truncate font-medium text-muted-foreground transition-opacity duration-100 motion-reduce:transition-none",
						activeDay && "opacity-0"
					)}
					id={headingId}
				>
					{title}
				</h2>
				{activeDay && active !== null ? (
					<p
						aria-hidden="true"
						className="col-start-1 row-start-1 flex min-w-0 items-center gap-1.5 truncate tabular-nums"
						data-testid="bank-chart-readout"
					>
						{dayReadout(activeDay, active === lastIndex, currency).map(
							(part, index) => (
								<span
									className={cn(
										"flex items-center gap-1.5",
										index === 1
											? "font-medium text-foreground"
											: "text-muted-foreground"
									)}
									key={part}
								>
									{index > 0 ? <span aria-hidden="true">·</span> : null}
									{part}
								</span>
							)
						)}
					</p>
				) : null}
			</div>
			<div className="mt-4 flex min-h-36 flex-1">
				<div
					aria-describedby={captionId}
					aria-label="Daily spend. Use the arrow keys to read each day."
					aria-valuemax={days.length}
					aria-valuemin={1}
					aria-valuenow={(active ?? lastIndex) + 1}
					aria-valuetext={readout}
					className="group/plot relative min-w-0 flex-1 outline-hidden"
					onBlur={() => setActive(null)}
					onFocus={() => setActive((current) => current ?? lastIndex)}
					onKeyDown={onKeyDown}
					onPointerLeave={() => setActive(null)}
					role="slider"
					tabIndex={0}
				>
					{max > 0 ? (
						<div
							aria-hidden="true"
							className="absolute inset-x-0 top-0 border-border border-t border-dashed"
						/>
					) : (
						<p className="absolute inset-0 grid place-items-center text-muted-foreground text-sm">
							{tl("No spend in the last {dayCount} days", {
								dayCount: days.length,
							})}
						</p>
					)}
					<div
						aria-hidden="true"
						className="absolute inset-0 flex items-end gap-1 border-border border-b max-sm:gap-0.5"
					>
						{days.map((day, index) => {
							const height =
								max > 0 && day.spent > 0
									? Math.max(MIN_BAR_PERCENT, (day.spent / max) * 100)
									: 0;
							const current = active === index;
							const quiet = active !== null && !current;
							return (
								<div
									className="flex h-full min-w-0 flex-1 items-end justify-center"
									key={day.key}
									onPointerEnter={() => setActive(index)}
								>
									<div
										className={cn(
											"w-full max-w-6 transition-opacity duration-150 motion-reduce:transition-none",
											height > 0
												? "rounded-t-[3px] bg-primary"
												: "h-0.5 rounded-full bg-muted-foreground/25",
											current &&
												"group-focus-visible/plot:outline-2 group-focus-visible/plot:outline-ring group-focus-visible/plot:outline-solid group-focus-visible/plot:outline-offset-1",
											current && height === 0 && "bg-muted-foreground",
											quiet && "opacity-35"
										)}
										style={height > 0 ? { height: `${height}%` } : undefined}
									/>
								</div>
							);
						})}
					</div>
				</div>
				<div
					aria-hidden="true"
					className="relative w-16 shrink-0 text-muted-foreground text-xs tabular-nums"
				>
					<span className="absolute top-0 left-3 -translate-y-1/2">
						{max > 0 ? formatMoney(max, currency) : null}
					</span>
					<span className="absolute bottom-0 left-3 translate-y-1/2">
						{formatMoney(0, currency)}
					</span>
				</div>
			</div>
			<div aria-hidden="true" className="mt-2 flex">
				<div className="relative h-4 min-w-0 flex-1 text-muted-foreground text-xs tabular-nums">
					{first ? (
						<span className="absolute left-0">{shortDay(first.date)}</span>
					) : null}
					{middle && middleIndex > 0 ? (
						<span
							className="absolute -translate-x-1/2"
							style={{ left: barCenter(middleIndex) }}
						>
							{shortDay(middle.date)}
						</span>
					) : null}
					<span className="absolute right-0">Today</span>
				</div>
				<div className="w-16 shrink-0" />
			</div>
			<table className="sr-only">
				<caption>Daily spend</caption>
				<thead>
					<tr>
						<th scope="col">Day</th>
						<th scope="col">Spent</th>
					</tr>
				</thead>
				<tbody>
					{days.map((day) => (
						<tr key={day.key}>
							<th scope="row">{shortWeekday(day.date)}</th>
							<td>{formatMoney(day.spent, currency)}</td>
						</tr>
					))}
				</tbody>
			</table>
		</figure>
	);
}
