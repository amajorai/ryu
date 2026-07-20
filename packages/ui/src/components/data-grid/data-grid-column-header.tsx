"use client";

import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { getColumnVariant } from "@ryu/ui/lib/data-grid.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type {
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
	PinIcon,
	PinOffIcon,
	Settings2Icon,
	XIcon,
} from "lucide-react";
import { type ComponentProps, memo, useCallback } from "react";

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
		: typeof column.columnDef.header === "string"
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
					{column.getCanPin() && (
						<>
							{column.getCanSort() && <DropdownMenuSeparator />}

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
	const defaultColumnDef = table._getDefaultColumnDef();

	const onDoubleClick = useCallback(() => {
		header.column.resetSize();
	}, [header.column]);

	return (
		<div
			aria-label={`Resize ${label} column`}
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
