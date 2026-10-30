"use client";

import { Calendar03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import { Calendar, useDisplayToday } from "@ryu/ui/components/calendar";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover";
import { formatDate } from "@ryu/ui/lib/timezone.ts";
import { useState } from "react";
import type { UsageDateRange } from "./usage-analytics.ts";
import {
	usagePresetRange,
	usageRangeDays,
	usageRangeFromDays,
} from "./usage-range-days.ts";

export const RANGE_LABEL_FORMAT = {
	day: "numeric",
	month: "short",
	year: "numeric",
} as const satisfies Intl.DateTimeFormatOptions;

/** The range's first and last day, named in the display zone and language. */
export function dateRangeLabel(range: UsageDateRange): string {
	const lastDay = new Date(range.to.getTime() - 1);
	return `${formatDate(range.from, RANGE_LABEL_FORMAT)} – ${formatDate(lastDay, RANGE_LABEL_FORMAT)}`;
}

export function DateRangeControl({
	range,
	onChange,
}: {
	onChange: (range: UsageDateRange) => void;
	range: UsageDateRange;
}) {
	const [open, setOpen] = useState(false);
	// Days are civil dates in the display zone. Reading today through the
	// subscribed hook also re-renders the label and the highlight at that zone's
	// midnight and when the zone changes.
	const today = useDisplayToday();
	const selected = usageRangeDays(range);
	const choosePreset = (days: number) => {
		onChange(usagePresetRange(days));
		setOpen(false);
	};
	return (
		<Popover onOpenChange={setOpen} open={open}>
			<PopoverTrigger aria-label="Choose usage date range" variant="date-range">
				<HugeiconsIcon icon={Calendar03Icon} size={16} />
				<span className="max-w-48 truncate">{dateRangeLabel(range)}</span>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-auto">
				<div className="flex flex-col gap-3">
					<div className="flex flex-wrap gap-1">
						{[
							[1, "24 hours"],
							[7, "7 days"],
							[30, "30 days"],
							[90, "90 days"],
							[365, "12 months"],
						].map(([days, label]) => (
							<Button
								key={String(days)}
								onClick={() => choosePreset(Number(days))}
								size="sm"
								type="button"
								variant="ghost"
							>
								{label}
							</Button>
						))}
					</div>
					<Calendar
						defaultMonth={selected.from}
						disabled={{ after: today }}
						mode="range"
						numberOfMonths={2}
						onSelect={(next) => {
							if (!next?.from) {
								return;
							}
							onChange(usageRangeFromDays(next.from, next.to));
							if (next.to) {
								setOpen(false);
							}
						}}
						selected={selected}
					/>
				</div>
			</PopoverContent>
		</Popover>
	);
}
