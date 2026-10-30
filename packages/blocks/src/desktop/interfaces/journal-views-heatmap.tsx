import { cn } from "@ryu/ui/lib/utils";
import { localDayKey } from "@ryuhq/protocol/interfaces";
import { type KeyboardEvent, useState } from "react";
import {
	countLabel,
	fullDateLabel,
	type HeatCell,
	type HeatColumn,
	weekdayShort,
} from "./journal-model.ts";

export const HEAT_LEVEL: Record<HeatCell["level"], string> = {
	0: "bg-muted",
	1: "bg-primary/35",
	2: "bg-primary/55",
	3: "bg-primary/75",
	4: "bg-primary",
};

const HEAT_WEEKDAY_ROWS = new Set([1, 3, 5]);
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

function heatCellLabel(cell: HeatCell): string {
	return `${fullDateLabel(cell.key)}, ${
		cell.count === 0 ? "no entries" : countLabel(cell.count, "entry", "entries")
	}`;
}

/** Arrow-key steps in days: columns are weeks, rows are weekdays. */
const HEAT_STEP: Record<string, number> = {
	ArrowDown: 1,
	ArrowLeft: -7,
	ArrowRight: 7,
	ArrowUp: -1,
};

/**
 * A year of activity as one tab stop: Tab lands on the focused day, arrows
 * move by day and week, Home and End jump to the ends, Enter opens the day.
 */
export function YearHeatmap({
	columns,
	onSelectDay,
	todayKey,
}: {
	columns: HeatColumn[];
	onSelectDay: (key: string) => void;
	todayKey: string;
}) {
	const cells = columns.flatMap((column) => column.cells);
	const keys = cells.filter((cell) => !cell.future).map((cell) => cell.key);
	const [focusKey, setFocusKey] = useState(todayKey);
	const activeKey = keys.includes(focusKey) ? focusKey : (keys.at(-1) ?? "");

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const index = keys.indexOf(activeKey);
		let next = -1;
		if (event.key in HEAT_STEP) {
			next = index + (HEAT_STEP[event.key] ?? 0);
		} else if (event.key === "Home") {
			next = 0;
		} else if (event.key === "End") {
			next = keys.length - 1;
		} else {
			return;
		}
		event.preventDefault();
		const key = keys[Math.min(Math.max(next, 0), keys.length - 1)];
		if (!key) {
			return;
		}
		setFocusKey(key);
		const target = event.currentTarget.querySelector(`[data-day="${key}"]`);
		if (target instanceof HTMLElement) {
			target.focus();
		}
	};

	return (
		<div className="mt-3 overflow-x-auto pb-1">
			<div className="flex min-w-[42rem] gap-[3px]">
				<div
					aria-hidden="true"
					className="grid shrink-0 grid-rows-[1rem_repeat(7,minmax(0,1fr))] gap-[3px] pe-1"
				>
					<span />
					{WEEKDAYS.map((weekday) => (
						<span
							className="flex items-center text-muted-foreground text-xs leading-3"
							key={weekday}
						>
							{HEAT_WEEKDAY_ROWS.has(weekday)
								? weekdayShort(localDayKey(new Date(2026, 0, 4 + weekday)))
								: ""}
						</span>
					))}
				</div>
				<div
					aria-label="Activity by day, last 12 months"
					aria-roledescription="heatmap"
					className="flex min-w-0 flex-1 gap-[3px]"
					onKeyDown={onKeyDown}
					role="group"
				>
					{columns.map((column) => (
						<div
							className="grid min-w-0 flex-1 grid-rows-[1rem_repeat(7,auto)] gap-[3px]"
							key={column.cells[0]?.key}
						>
							<span
								aria-hidden="true"
								className="w-0 overflow-visible whitespace-nowrap text-muted-foreground text-xs leading-3"
							>
								{column.month ?? ""}
							</span>
							{column.cells.map((cell) =>
								cell.future ? (
									<span
										aria-hidden="true"
										className="aspect-square w-full"
										key={cell.key}
									/>
								) : (
									<button
										aria-label={heatCellLabel(cell)}
										className={cn(
											"aspect-square w-full rounded-[3px] outline-none transition-shadow hover:ring-1 hover:ring-foreground/40 focus-visible:ring-2 focus-visible:ring-ring",
											HEAT_LEVEL[cell.level]
										)}
										data-day={cell.key}
										key={cell.key}
										onClick={() => onSelectDay(cell.key)}
										onFocus={() => setFocusKey(cell.key)}
										tabIndex={cell.key === activeKey ? 0 : -1}
										title={heatCellLabel(cell)}
										type="button"
									/>
								)
							)}
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
