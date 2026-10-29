"use client";

import "../../types/data-table.ts";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ryu/ui/components/table.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	type Column,
	flexRender,
	type Table as TanstackTable,
} from "@tanstack/react-table";
import type { ComponentProps, CSSProperties, ReactNode } from "react";
import { DataTablePagination } from "./data-table-pagination.tsx";

interface DataTableProps<TData> extends ComponentProps<"div"> {
	actionBar?: ReactNode;
	/** Shown in the body when the current page has no rows. */
	emptyMessage?: ReactNode;
	/** Called with the row's original data when a row is activated. */
	onRowClick?: (row: TData) => void;
	pageSizeOptions?: number[];
	table: TanstackTable<TData>;
}

function getAriaSort(
	column: Column<unknown>
): "ascending" | "descending" | undefined {
	const sorted = column.getIsSorted();
	if (sorted === "asc") {
		return "ascending";
	}
	if (sorted === "desc") {
		return "descending";
	}
	return;
}

function getColumnPinningStyle<TData>(column: Column<TData>): CSSProperties {
	const pinned = column.getIsPinned();
	if (!pinned) {
		return { width: column.getSize() };
	}
	return {
		insetInlineStart:
			pinned === "left" ? `${column.getStart("left")}px` : undefined,
		insetInlineEnd:
			pinned === "right" ? `${column.getAfter("right")}px` : undefined,
		position: "sticky",
		width: column.getSize(),
		zIndex: 1,
	};
}

/**
 * The Dice UI (tablecn) data table: a bordered table with sortable headers,
 * a pagination footer, and an optional action bar for selected rows. Render a
 * `DataTableToolbar` as `children` to add filters and column visibility.
 */
export function DataTable<TData>({
	table,
	actionBar,
	children,
	className,
	emptyMessage = "No results.",
	onRowClick,
	pageSizeOptions,
	...props
}: DataTableProps<TData>) {
	const rows = table.getRowModel().rows;

	return (
		<div
			className={cn("flex w-full flex-col gap-2.5 overflow-auto", className)}
			data-slot="data-table"
			{...props}
		>
			{children}
			<div className="isolate overflow-hidden rounded-md border">
				<Table className="table-fixed">
					<TableHeader>
						{table.getHeaderGroups().map((headerGroup) => (
							<TableRow className="group/row" key={headerGroup.id}>
								{headerGroup.headers.map((header) => (
									<TableHead
										aria-sort={getAriaSort(header.column as Column<unknown>)}
										className={cn(
											"overflow-hidden",
											header.column.getIsPinned() && "bg-background"
										)}
										colSpan={header.colSpan}
										key={header.id}
										style={getColumnPinningStyle(header.column)}
									>
										{header.isPlaceholder
											? null
											: flexRender(
													header.column.columnDef.header,
													header.getContext()
												)}
									</TableHead>
								))}
							</TableRow>
						))}
					</TableHeader>
					<TableBody>
						{rows.length > 0 ? (
							rows.map((row) => (
								<TableRow
									className={cn("group/row", onRowClick && "cursor-pointer")}
									data-state={row.getIsSelected() ? "selected" : undefined}
									key={row.id}
									onClick={
										onRowClick ? () => onRowClick(row.original) : undefined
									}
									onKeyDown={
										onRowClick
											? (event) => {
													if (event.key === "Enter" || event.key === " ") {
														event.preventDefault();
														onRowClick(row.original);
													}
												}
											: undefined
									}
									tabIndex={onRowClick ? 0 : undefined}
								>
									{row.getVisibleCells().map((cell) => (
										<TableCell
											className={cn(
												"overflow-hidden",
												cell.column.getIsPinned() && "bg-background"
											)}
											key={cell.id}
											style={getColumnPinningStyle(cell.column)}
										>
											{flexRender(
												cell.column.columnDef.cell,
												cell.getContext()
											)}
										</TableCell>
									))}
								</TableRow>
							))
						) : (
							<TableRow>
								<TableCell
									className="h-24 text-center text-muted-foreground"
									colSpan={table.getVisibleLeafColumns().length || 1}
								>
									{emptyMessage}
								</TableCell>
							</TableRow>
						)}
					</TableBody>
				</Table>
			</div>
			<div className="flex flex-col gap-2.5">
				<DataTablePagination pageSizeOptions={pageSizeOptions} table={table} />
				{actionBar && table.getFilteredSelectedRowModel().rows.length > 0
					? actionBar
					: null}
			</div>
		</div>
	);
}
