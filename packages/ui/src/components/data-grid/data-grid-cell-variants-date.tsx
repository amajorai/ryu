"use client";

import {
	Calendar,
	useCalendarLocalization,
} from "@ryu/ui/components/calendar.tsx";
import { DataGridCellWrapper } from "@ryu/ui/components/data-grid/data-grid-cell-wrapper.tsx";
import {
	Popover,
	PopoverAnchor,
	PopoverContent,
} from "@ryu/ui/components/popover.tsx";
import {
	formatDateForDisplay,
	formatDateToString,
	parseLocalDate,
} from "@ryu/ui/lib/data-grid.ts";
import { displayCivilDay } from "@ryu/ui/lib/display-civil-day.ts";
import { useDisplayLocale } from "@ryu/ui/lib/timezone.ts";
import type { DataGridCellProps } from "@ryu/ui/types/data-grid.ts";
import { type KeyboardEvent, useCallback, useRef, useState } from "react";

export function DateCell<TData>({
	cell,
	tableMeta,
	rowIndex,
	columnId,
	rowHeight,
	isFocused,
	isEditing,
	isSelected,
	isSearchMatch,
	isActiveSearchMatch,
	readOnly,
}: DataGridCellProps<TData>) {
	const displayLocale = useDisplayLocale();
	const calendarText = useCalendarLocalization(displayLocale);
	// SAFETY: This renderer is selected for the text cell schema; its column accessor returns a string.
	const initialValue = cell.getValue() as string;
	const [value, setValue] = useState(initialValue ?? "");
	const containerRef = useRef<HTMLDivElement>(null);

	const prevInitialValueRef = useRef(initialValue);
	if (initialValue !== prevInitialValueRef.current) {
		prevInitialValueRef.current = initialValue;
		setValue(initialValue ?? "");
	}

	// Parse date as local time to avoid timezone shifts
	const selectedDate = value ? (parseLocalDate(value) ?? undefined) : undefined;

	const onDateSelect = useCallback(
		(date: Date | undefined) => {
			if (!date || readOnly) {
				return;
			}

			// Format using local date components to avoid timezone issues
			const formattedDate = formatDateToString(date);
			setValue(formattedDate);
			tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: formattedDate });
			tableMeta?.onCellEditingStop?.();
		},
		[tableMeta, rowIndex, columnId, readOnly]
	);

	const onOpenChange = useCallback(
		(open: boolean) => {
			if (open && !readOnly) {
				tableMeta?.onCellEditingStart?.(rowIndex, columnId);
			} else {
				tableMeta?.onCellEditingStop?.();
			}
		},
		[tableMeta, rowIndex, columnId, readOnly]
	);

	const onWrapperKeyDown = useCallback(
		(event: KeyboardEvent<HTMLDivElement>) => {
			if (isEditing && event.key === "Escape") {
				event.preventDefault();
				setValue(initialValue);
				tableMeta?.onCellEditingStop?.();
			} else if (isFocused && event.key === "Tab") {
				event.preventDefault();
				tableMeta?.onCellEditingStop?.({
					direction: event.shiftKey ? "left" : "right",
				});
			}
		},
		[isEditing, isFocused, initialValue, tableMeta]
	);

	return (
		<DataGridCellWrapper<TData>
			cell={cell}
			columnId={columnId}
			isActiveSearchMatch={isActiveSearchMatch}
			isEditing={isEditing}
			isFocused={isFocused}
			isSearchMatch={isSearchMatch}
			isSelected={isSelected}
			onKeyDown={onWrapperKeyDown}
			readOnly={readOnly}
			ref={containerRef}
			rowHeight={rowHeight}
			rowIndex={rowIndex}
			tableMeta={tableMeta}
		>
			<Popover onOpenChange={onOpenChange} open={isEditing}>
				<PopoverAnchor asChild>
					<span data-slot="grid-cell-content">
						{formatDateForDisplay(value)}
					</span>
				</PopoverAnchor>
				{isEditing && (
					<PopoverContent
						align="start"
						alignOffset={-8}
						className="w-auto p-0"
						data-grid-cell-editor=""
					>
						<Calendar
							autoFocus
							captionLayout="dropdown"
							// An empty cell opens on today's month in the display zone, which is the
							// computer's month only while the two zones share a date. DayPicker reads
							// this once as the opening month, so it needs no subscription.
							defaultMonth={selectedDate ?? displayCivilDay(Date.now())}
							formatters={calendarText.formatters}
							labels={calendarText.labels}
							locale={calendarText.locale}
							mode="single"
							onSelect={onDateSelect}
							selected={selectedDate}
						/>
					</PopoverContent>
				)}
			</Popover>
		</DataGridCellWrapper>
	);
}
