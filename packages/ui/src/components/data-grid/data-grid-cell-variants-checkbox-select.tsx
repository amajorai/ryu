"use client";

import { Badge } from "@ryu/ui/components/badge.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import { DataGridCellWrapper } from "@ryu/ui/components/data-grid/data-grid-cell-wrapper.tsx";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { getOptionColorClass } from "@ryu/ui/lib/data-grid.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { DataGridCellProps } from "@ryu/ui/types/data-grid.ts";
import {
	type KeyboardEvent,
	type MouseEvent,
	useCallback,
	useMemo,
	useRef,
	useState,
} from "react";

export function CheckboxCell<TData>({
	cell,
	tableMeta,
	rowIndex,
	columnId,
	rowHeight,
	isFocused,
	isSelected,
	isSearchMatch,
	isActiveSearchMatch,
	readOnly,
}: Omit<DataGridCellProps<TData>, "isEditing">) {
	const initialValue = cell.getValue();
	const [value, setValue] = useState(Boolean(initialValue));
	const containerRef = useRef<HTMLDivElement>(null);

	const prevInitialValueRef = useRef(initialValue);
	if (initialValue !== prevInitialValueRef.current) {
		prevInitialValueRef.current = initialValue;
		setValue(Boolean(initialValue));
	}

	const onCheckedChange = useCallback(
		(checked: boolean) => {
			if (readOnly) {
				return;
			}
			setValue(checked);
			tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: checked });
		},
		[tableMeta, rowIndex, columnId, readOnly]
	);

	const onWrapperKeyDown = useCallback(
		(event: KeyboardEvent<HTMLDivElement>) => {
			if (
				isFocused &&
				!readOnly &&
				(event.key === " " || event.key === "Enter")
			) {
				event.preventDefault();
				event.stopPropagation();
				onCheckedChange(!value);
			} else if (isFocused && event.key === "Tab") {
				event.preventDefault();
				tableMeta?.onCellEditingStop?.({
					direction: event.shiftKey ? "left" : "right",
				});
			}
		},
		[isFocused, value, onCheckedChange, tableMeta, readOnly]
	);

	const onWrapperClick = useCallback(
		(event: MouseEvent) => {
			if (isFocused && !readOnly) {
				event.preventDefault();
				event.stopPropagation();
				onCheckedChange(!value);
			}
		},
		[isFocused, value, onCheckedChange, readOnly]
	);

	const onCheckboxClick = useCallback((event: MouseEvent) => {
		event.stopPropagation();
	}, []);

	const onCheckboxMouseDown = useCallback((event: MouseEvent) => {
		event.stopPropagation();
	}, []);

	const onCheckboxDoubleClick = useCallback((event: MouseEvent) => {
		event.stopPropagation();
	}, []);

	return (
		<DataGridCellWrapper<TData>
			cell={cell}
			className="flex size-full justify-center"
			columnId={columnId}
			isActiveSearchMatch={isActiveSearchMatch}
			isEditing={false}
			isFocused={isFocused}
			isSearchMatch={isSearchMatch}
			isSelected={isSelected}
			onClick={onWrapperClick}
			onKeyDown={onWrapperKeyDown}
			readOnly={readOnly}
			ref={containerRef}
			rowHeight={rowHeight}
			rowIndex={rowIndex}
			tableMeta={tableMeta}
		>
			<Checkbox
				checked={value}
				className="border-primary"
				disabled={readOnly}
				onCheckedChange={onCheckedChange}
				onClick={onCheckboxClick}
				onDoubleClick={onCheckboxDoubleClick}
				onMouseDown={onCheckboxMouseDown}
			/>
		</DataGridCellWrapper>
	);
}

export function SelectCell<TData>({
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
	// SAFETY: This renderer is selected for the optional text cell schema; missing values normalize to undefined.
	const initialValue = (cell.getValue() ?? undefined) as string | undefined;

	const [value, setValue] = useState(initialValue);
	const containerRef = useRef<HTMLDivElement>(null);
	const cellOpts = cell.column.columnDef.meta?.cell;
	const options = useMemo(
		() => (cellOpts?.variant === "select" ? cellOpts.options : []),
		[cellOpts]
	);
	const optionByValue = useMemo(
		() => new Map(options.map((option) => [option.value, option])),
		[options]
	);

	const prevInitialValueRef = useRef(initialValue);
	if (initialValue !== prevInitialValueRef.current) {
		prevInitialValueRef.current = initialValue;
		setValue(initialValue);
	}

	const onValueChange = useCallback(
		// Base UI's Select calls back with `string | null` (+ event details).
		(newValue: string | null) => {
			if (readOnly || newValue === null) {
				return;
			}
			setValue(newValue);
			tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: newValue });
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

	const displayLabel = value
		? (optionByValue.get(value)?.label ?? value)
		: null;

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
			{isEditing ? (
				<Select
					onOpenChange={onOpenChange}
					onValueChange={onValueChange}
					open={isEditing}
					value={value}
				>
					<SelectTrigger className="size-full items-start border-none p-0 shadow-none focus-visible:ring-0 dark:bg-transparent [&_svg]:hidden">
						{displayLabel ? (
							<Badge
								className={cn(
									"whitespace-pre-wrap px-1.5 py-px",
									getOptionColorClass(optionByValue.get(value ?? "")?.color)
								)}
								variant="secondary"
							>
								<SelectValue />
							</Badge>
						) : (
							<SelectValue />
						)}
					</SelectTrigger>
					<SelectContent
						// compensate for the wrapper padding
						align="start"
						alignOffset={-8}
						className="min-w-[calc(var(--anchor-width)+16px)]"
						data-grid-cell-editor=""
						sideOffset={-8}
					>
						<SelectGroup>
							{options.map((option) => (
								<SelectItem key={option.value} value={option.value}>
									<Badge
										className={cn(
											"px-1.5 py-px font-normal",
											getOptionColorClass(option.color)
										)}
										variant="secondary"
									>
										{option.label}
									</Badge>
								</SelectItem>
							))}
						</SelectGroup>
					</SelectContent>
				</Select>
			) : displayLabel ? (
				<Badge
					className={cn(
						"whitespace-pre-wrap px-1.5 py-px",
						getOptionColorClass(optionByValue.get(value ?? "")?.color)
					)}
					data-slot="grid-cell-content"
					variant="secondary"
				>
					{displayLabel}
				</Badge>
			) : null}
		</DataGridCellWrapper>
	);
}
