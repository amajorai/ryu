"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { getColumnVariant } from "@ryu/ui/lib/data-grid.ts";
import { collectFilterOptions } from "@ryu/ui/lib/data-grid-fill.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type {
	Column,
	ColumnSort,
	Header,
	SortDirection,
	SortingState,
	Table,
} from "@tanstack/react-table";
import {
	ChevronDownIcon,
	ChevronUpIcon,
	EyeOffIcon,
	FilterIcon,
	FilterXIcon,
	MoveHorizontalIcon,
	PinIcon,
	PinOffIcon,
	Settings2Icon,
	XIcon,
} from "lucide-react";
import { type ComponentProps, memo, useCallback, useMemo } from "react";
import { isNativeText } from "../../lib/native-primitive-observation.ts";

interface DataGridColumnHeaderProps<TData, TValue>
	extends ComponentProps<typeof DropdownMenuTrigger> {
	header: Header<TData, TValue>;
	table: Table<TData>;
}

export function DataGridColumnHeader<TData, TValue>({
	header,
	table,
	className,
	onPointerDown,
	...props
}: DataGridColumnHeaderProps<TData, TValue>) {
	const column = header.column;
	const label = column.columnDef.meta?.label
		? column.columnDef.meta.label
		: isNativeText(column.columnDef.header)
			? column.columnDef.header
			: column.id;

	const isAnyColumnResizing =
		table.getState().columnSizingInfo.isResizingColumn;

	const cellVariant = column.columnDef.meta?.cell;
	const columnVariant = getColumnVariant(cellVariant?.variant);

	const pinnedPosition = column.getIsPinned();
	const isPinnedLeft = pinnedPosition === "left";
	const isPinnedRight = pinnedPosition === "right";

	const onSortingChange = useCallback(
		(direction: SortDirection) => {
			table.setSorting((prev: SortingState) => {
				const existingSortIndex = prev.findIndex(
					(sort) => sort.id === column.id
				);
				const newSort: ColumnSort = {
					id: column.id,
					desc: direction === "desc",
				};

				if (existingSortIndex >= 0) {
					const updated = [...prev];
					updated[existingSortIndex] = newSort;
					return updated;
				}
				return [...prev, newSort];
			});
		},
		[column.id, table]
	);

	const onSortRemove = useCallback(() => {
		table.setSorting((prev: SortingState) =>
			prev.filter((sort) => sort.id !== column.id)
		);
	}, [column.id, table]);

	const onLeftPin = useCallback(() => {
		column.pin("left");
	}, [column]);

	const onRightPin = useCallback(() => {
		column.pin("right");
	}, [column]);

	const onUnpin = useCallback(() => {
		column.pin(false);
	}, [column]);

	const onTriggerPointerDown = useCallback<
		NonNullable<ComponentProps<typeof DropdownMenuTrigger>["onPointerDown"]>
	>(
		(event) => {
			onPointerDown?.(event);
			if (event.defaultPrevented) {
				return;
			}

			if (event.button !== 0) {
				return;
			}
			table.options.meta?.onColumnClick?.(column.id);
		},
		[table.options.meta, column.id, onPointerDown]
	);

	return (
		<>
			<DropdownMenu modal={false}>
				<DropdownMenuTrigger
					className={cn(
						"flex size-full items-center justify-between gap-2 p-2 text-sm hover:bg-accent/40 data-[popup-open]:bg-accent/40 [&_svg]:size-4",
						isAnyColumnResizing && "pointer-events-none",
						className
					)}
					onPointerDown={onTriggerPointerDown}
					{...props}
				>
					<div className="flex min-w-0 flex-1 items-center gap-1.5">
						{columnVariant && (
							<Tooltip>
								<TooltipTrigger
									render={
										<columnVariant.icon className="size-3.5 shrink-0 text-muted-foreground" />
									}
								/>
								<TooltipContent side="top">
									<p>{columnVariant.label}</p>
								</TooltipContent>
							</Tooltip>
						)}
						<span className="truncate">{label}</span>
						{column.getIsFiltered() && (
							<FilterIcon
								aria-label="Filtered"
								className="size-3.5 shrink-0 text-primary"
							/>
						)}
					</div>
					<ChevronDownIcon className="shrink-0 text-muted-foreground" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="w-60" sideOffset={0}>
					{table.options.meta?.onColumnEdit && (
						<>
							<DropdownMenuItem
								onClick={() => table.options.meta?.onColumnEdit?.(column.id)}
							>
								<Settings2Icon />
								Edit property
							</DropdownMenuItem>
							{(column.getCanSort() ||
								column.getCanPin() ||
								column.getCanHide()) && <DropdownMenuSeparator />}
						</>
					)}
					{column.getCanSort() && (
						<>
							<DropdownMenuCheckboxItem
								checked={column.getIsSorted() === "asc"}
								className="relative ltr:pr-8 ltr:pl-2 rtl:pr-2 rtl:pl-8 [&>span:first-child]:ltr:right-2 [&>span:first-child]:ltr:left-auto [&>span:first-child]:rtl:right-auto [&>span:first-child]:rtl:left-2 [&_svg]:text-muted-foreground"
								onClick={() => onSortingChange("asc")}
							>
								<ChevronUpIcon />
								Sort asc
							</DropdownMenuCheckboxItem>
							<DropdownMenuCheckboxItem
								checked={column.getIsSorted() === "desc"}
								className="relative ltr:pr-8 ltr:pl-2 rtl:pr-2 rtl:pl-8 [&>span:first-child]:ltr:right-2 [&>span:first-child]:ltr:left-auto [&>span:first-child]:rtl:right-auto [&>span:first-child]:rtl:left-2 [&_svg]:text-muted-foreground"
								onClick={() => onSortingChange("desc")}
							>
								<ChevronDownIcon />
								Sort desc
							</DropdownMenuCheckboxItem>
							{column.getIsSorted() && (
								<DropdownMenuItem onClick={onSortRemove}>
									<XIcon />
									Remove sort
								</DropdownMenuItem>
							)}
						</>
					)}
					{column.getCanFilter() && (
						<>
							{column.getCanSort() && <DropdownMenuSeparator />}
							<DropdownMenuSub>
								<DropdownMenuSubTrigger className="[&_svg]:text-muted-foreground">
									<FilterIcon />
									Filter
								</DropdownMenuSubTrigger>
								<DropdownMenuSubContent className="max-h-80 w-56 overflow-y-auto">
									<DataGridColumnFilterItems column={column} table={table} />
								</DropdownMenuSubContent>
							</DropdownMenuSub>
							{column.getIsFiltered() && (
								<DropdownMenuItem
									className="[&_svg]:text-muted-foreground"
									onClick={() => column.setFilterValue(undefined)}
								>
									<FilterXIcon />
									Clear filter
								</DropdownMenuItem>
							)}
						</>
					)}
					{column.getCanPin() && (
						<>
							{(column.getCanSort() || column.getCanFilter()) && (
								<DropdownMenuSeparator />
							)}

							{isPinnedLeft ? (
								<DropdownMenuItem
									className="[&_svg]:text-muted-foreground"
									onClick={onUnpin}
								>
									<PinOffIcon />
									Unpin from left
								</DropdownMenuItem>
							) : (
								<DropdownMenuItem
									className="[&_svg]:text-muted-foreground"
									onClick={onLeftPin}
								>
									<PinIcon />
									Pin to left
								</DropdownMenuItem>
							)}
							{isPinnedRight ? (
								<DropdownMenuItem
									className="[&_svg]:text-muted-foreground"
									onClick={onUnpin}
								>
									<PinOffIcon />
									Unpin from right
								</DropdownMenuItem>
							) : (
								<DropdownMenuItem
									className="[&_svg]:text-muted-foreground"
									onClick={onRightPin}
								>
									<PinIcon />
									Pin to right
								</DropdownMenuItem>
							)}
						</>
					)}
					{column.getCanResize() && table.options.meta?.onColumnAutoFit && (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuItem
								className="[&_svg]:text-muted-foreground"
								onClick={() => table.options.meta?.onColumnAutoFit?.(column.id)}
							>
								<MoveHorizontalIcon />
								Auto-fit width
							</DropdownMenuItem>
						</>
					)}
					{column.getCanHide() && (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuItem
								className="[&_svg]:text-muted-foreground"
								onClick={() => column.toggleVisibility(false)}
							>
								<EyeOffIcon />
								Hide column
							</DropdownMenuItem>
						</>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
			{header.column.getCanResize() && (
				<DataGridColumnResizer header={header} label={label} table={table} />
			)}
		</>
	);
}

const FILTER_OPTION_LIMIT = 200;

/**
 * Excel-style AutoFilter checklist: one checkbox per distinct value (blanks
 * last). Unchecking hides matching rows; checking everything clears the filter.
 */
function DataGridColumnFilterItems<TData, TValue>({
	column,
	table,
}: {
	column: Column<TData, TValue>;
	table: Table<TData>;
}) {
	const tl = useLiteralMessages();
	const coreRows = table.getCoreRowModel().rows;
	const cellOpts = column.columnDef.meta?.cell;
	const options = useMemo(
		() =>
			collectFilterOptions(
				coreRows.map((row) => row.getValue(column.id)),
				cellOpts
			),
		[coreRows, column.id, cellOpts]
	);
	const shown = options.slice(0, FILTER_OPTION_LIMIT);
	const filterValue = column.getFilterValue();
	const selected = Array.isArray(filterValue)
		? new Set(filterValue.map(String))
		: null;

	const onToggle = (key: string, checked: boolean) => {
		const next = new Set(selected ?? options.map((option) => option.key));
		if (checked) {
			next.add(key);
		} else {
			next.delete(key);
		}
		column.setFilterValue(
			next.size === options.length ? undefined : Array.from(next)
		);
	};

	return (
		<>
			<DropdownMenuCheckboxItem
				checked={selected === null}
				onClick={() =>
					column.setFilterValue(selected === null ? [] : undefined)
				}
			>
				Select all
			</DropdownMenuCheckboxItem>
			<DropdownMenuSeparator />
			{shown.map((option) => (
				<DropdownMenuCheckboxItem
					checked={selected === null || selected.has(option.key)}
					key={option.key}
					onClick={() =>
						onToggle(
							option.key,
							!(selected === null || selected.has(option.key))
						)
					}
				>
					<span className="flex-1 truncate">{option.label}</span>
					<span className="text-muted-foreground text-xs tabular-nums">
						{option.count}
					</span>
				</DropdownMenuCheckboxItem>
			))}
			{options.length > shown.length && (
				<p className="px-2 py-1 text-muted-foreground text-xs">
					{tl("Showing the first {limit} of {total} values", {
						limit: FILTER_OPTION_LIMIT,
						total: String(options.length),
					})}
				</p>
			)}
		</>
	);
}

// SAFETY: React.memo retains this complete native generic props forwarding and comparator. This restores the generic JSX component signature erased by React's memo overload; the runtime memo descriptor is used only by JSX, never invoked as an ordinary function.
const DataGridColumnResizer = memo(DataGridColumnResizerImpl, (prev, next) => {
	const prevColumn = prev.header.column;
	const nextColumn = next.header.column;

	if (
		prevColumn.getIsResizing() !== nextColumn.getIsResizing() ||
		prevColumn.getSize() !== nextColumn.getSize()
	) {
		return false;
	}

	if (prev.label !== next.label) {
		return false;
	}

	return true;
}) as typeof DataGridColumnResizerImpl;

interface DataGridColumnResizerProps<TData, TValue>
	extends DataGridColumnHeaderProps<TData, TValue> {
	label: string;
}

function DataGridColumnResizerImpl<TData, TValue>({
	header,
	table,
	label,
}: DataGridColumnResizerProps<TData, TValue>) {
	const tl = useLiteralMessages();
	const defaultColumnDef = table._getDefaultColumnDef();

	// Excel: double-click a column border to fit it to its contents.
	const onDoubleClick = useCallback(() => {
		const onColumnAutoFit = table.options.meta?.onColumnAutoFit;
		if (onColumnAutoFit) {
			onColumnAutoFit(header.column.id);
		} else {
			header.column.resetSize();
		}
	}, [header.column, table.options.meta]);

	return (
		<div
			aria-label={tl("Resize {label} column", { label })}
			aria-orientation="vertical"
			aria-valuemax={defaultColumnDef.maxSize}
			aria-valuemin={defaultColumnDef.minSize}
			aria-valuenow={header.column.getSize()}
			className={cn(
				"absolute -end-px top-0 z-50 h-full w-0.5 cursor-ew-resize touch-none select-none bg-border transition-opacity after:absolute after:inset-y-0 after:start-1/2 after:h-full after:w-[18px] after:-translate-x-1/2 after:content-[''] hover:bg-primary focus:bg-primary focus:outline-none",
				header.column.getIsResizing()
					? "bg-primary"
					: "opacity-0 hover:opacity-100"
			)}
			onDoubleClick={onDoubleClick}
			onMouseDown={header.getResizeHandler()}
			onTouchStart={header.getResizeHandler()}
			role="separator"
			tabIndex={0}
		/>
	);
}
