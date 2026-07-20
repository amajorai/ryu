"use client";

import { DataGridColumnHeader } from "@ryu/ui/components/data-grid/data-grid-column-header.tsx";
import { DataGridContextMenu } from "@ryu/ui/components/data-grid/data-grid-context-menu.tsx";
import { DataGridPasteDialog } from "@ryu/ui/components/data-grid/data-grid-paste-dialog.tsx";
import { DataGridRow } from "@ryu/ui/components/data-grid/data-grid-row.tsx";
import { DataGridSearch } from "@ryu/ui/components/data-grid/data-grid-search.tsx";
import { useAsRef } from "@ryu/ui/hooks/use-as-ref.ts";
import type { useDataGrid } from "@ryu/ui/hooks/use-data-grid.ts";
import {
	flexRender,
	getColumnBorderVisibility,
	getColumnPinningStyle,
} from "@ryu/ui/lib/data-grid.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { Direction } from "@ryu/ui/types/data-grid.ts";
import { Plus } from "lucide-react";
import {
	type ComponentProps,
	type KeyboardEvent,
	type MouseEvent,
	useCallback,
} from "react";

const EMPTY_CELL_SELECTION_SET = new Set<string>();

interface DataGridProps<TData>
	extends Omit<ReturnType<typeof useDataGrid<TData>>, "dir">,
		Omit<ComponentProps<"div">, "contextMenu"> {
	dir?: Direction;
	height?: number;
	stretchColumns?: boolean;
}

export function DataGrid<TData>({
	dataGridRef,
	headerRef,
	rowMapRef,
	footerRef,
	dir = "ltr",
	table,
	tableMeta,
	virtualTotalSize,
	virtualItems,
	measureElement,
	columns,
	columnSizeVars,
	searchState,
	searchMatchesByRow,
	activeSearchMatch,
	cellSelectionMap,
	focusedCell,
	editingCell,
	rowHeight,
	contextMenu,
	pasteDialog,
	onRowAdd: onRowAddProp,
	height = 600,
	stretchColumns = false,
	adjustLayout = false,
	className,
	...props
}: DataGridProps<TData>) {
	const rows = table.getRowModel().rows;
	const readOnly = tableMeta?.readOnly ?? false;
	const columnVisibility = table.getState().columnVisibility;
	const columnPinning = table.getState().columnPinning;

	const onRowAddRef = useAsRef(onRowAddProp);

	const onRowAdd = useCallback(
		(event: MouseEvent<HTMLDivElement>) => {
			onRowAddRef.current?.(event);
		},
		[onRowAddRef]
	);

	const onDataGridContextMenu = useCallback(
		(event: MouseEvent<HTMLDivElement>) => {
			event.preventDefault();
		},
		[]
	);

	const onFooterCellKeyDown = useCallback(
		(event: KeyboardEvent<HTMLDivElement>) => {
			if (!onRowAddRef.current) {
				return;
			}

			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				onRowAddRef.current();
			}
		},
		[onRowAddRef]
	);

	return (
		<div
			data-slot="grid-wrapper"
			dir={dir}
			{...props}
			className={cn("relative flex w-full flex-col", className)}
		>
			{searchState && <DataGridSearch {...searchState} />}
			<DataGridContextMenu
				columns={columns}
				contextMenu={contextMenu}
				tableMeta={tableMeta}
			/>
			<DataGridPasteDialog pasteDialog={pasteDialog} tableMeta={tableMeta} />
			<div
				aria-colcount={columns.length}
				aria-label="Data grid"
				aria-rowcount={rows.length + (onRowAddProp ? 1 : 0)}
				className="relative grid select-none overflow-auto rounded-md border focus:outline-none"
				data-slot="grid"
				onContextMenu={onDataGridContextMenu}
				ref={dataGridRef}
				role="grid"
				style={{
					...columnSizeVars,
					maxHeight: `${height}px`,
				}}
				tabIndex={0}
			>
				<div
					className="sticky top-0 z-10 grid border-b bg-background"
					data-slot="grid-header"
					ref={headerRef}
					role="rowgroup"
				>
					{table.getHeaderGroups().map((headerGroup, rowIndex) => (
						<div
							aria-rowindex={rowIndex + 1}
							className="flex w-full"
							data-slot="grid-header-row"
							key={headerGroup.id}
							role="row"
							tabIndex={-1}
						>
							{headerGroup.headers.map((header, colIndex) => {
								const sorting = table.getState().sorting;
								const currentSort = sorting.find(
									(sort) => sort.id === header.column.id
								);
								const isSortable = header.column.getCanSort();

								const nextHeader = headerGroup.headers[colIndex + 1];
								const isLastColumn =
									colIndex === headerGroup.headers.length - 1;

								const { showEndBorder, showStartBorder } =
									getColumnBorderVisibility({
										column: header.column,
										nextColumn: nextHeader?.column,
										isLastColumn,
									});

								return (
									<div
										aria-colindex={colIndex + 1}
										aria-sort={
											currentSort?.desc === false
												? "ascending"
												: currentSort?.desc === true
													? "descending"
													: isSortable
														? "none"
														: undefined
										}
										className={cn("relative", {
											grow: stretchColumns && header.column.id !== "select",
											"border-e":
												showEndBorder && header.column.id !== "select",
											"border-s":
												showStartBorder && header.column.id !== "select",
										})}
										data-slot="grid-header-cell"
										key={header.id}
										role="columnheader"
										style={{
											...getColumnPinningStyle({ column: header.column, dir }),
											width: `calc(var(--header-${header.id}-size) * 1px)`,
										}}
										tabIndex={-1}
									>
										{header.isPlaceholder ? null : typeof header.column
												.columnDef.header === "function" ? (
											<div className="size-full px-3 py-1.5">
												{flexRender(
													header.column.columnDef.header,
													header.getContext()
												)}
											</div>
										) : (
											<DataGridColumnHeader header={header} table={table} />
										)}
									</div>
								);
							})}
						</div>
					))}
				</div>
				<div
					className="relative grid"
					data-slot="grid-body"
					role="rowgroup"
					style={{
						height: `${virtualTotalSize}px`,
						contain: adjustLayout ? "layout paint" : "strict",
					}}
				>
					{virtualItems.map((virtualItem) => {
						const row = rows[virtualItem.index];
						if (!row) {
							return null;
						}

						const cellSelectionKeys =
							cellSelectionMap?.get(virtualItem.index) ??
							EMPTY_CELL_SELECTION_SET;

						const searchMatchColumns =
							searchMatchesByRow?.get(virtualItem.index) ?? null;
						const isActiveSearchRow =
							activeSearchMatch?.rowIndex === virtualItem.index;

						return (
							<DataGridRow
								activeSearchMatch={isActiveSearchRow ? activeSearchMatch : null}
								adjustLayout={adjustLayout}
								cellSelectionKeys={cellSelectionKeys}
								columnPinning={columnPinning}
								columnVisibility={columnVisibility}
								dir={dir}
								editingCell={editingCell}
								focusedCell={focusedCell}
								key={row.id}
								measureElement={measureElement}
								readOnly={readOnly}
								row={row}
								rowHeight={rowHeight}
								rowMapRef={rowMapRef}
								searchMatchColumns={searchMatchColumns}
								stretchColumns={stretchColumns}
								tableMeta={tableMeta}
								virtualItem={virtualItem}
							/>
						);
					})}
				</div>
				{!readOnly && onRowAdd && (
					<div
						className="sticky bottom-0 z-10 grid border-t bg-background"
						data-slot="grid-footer"
						ref={footerRef}
						role="rowgroup"
					>
						<div
							aria-rowindex={rows.length + 2}
							className="flex w-full"
							data-slot="grid-add-row"
							role="row"
							tabIndex={-1}
						>
							<div
								className="relative flex h-9 grow items-center bg-muted/30 transition-colors hover:bg-muted/50 focus:bg-muted/50 focus:outline-none"
								onClick={onRowAdd}
								onKeyDown={onFooterCellKeyDown}
								role="gridcell"
								style={{
									width: table.getTotalSize(),
									minWidth: table.getTotalSize(),
								}}
								tabIndex={0}
							>
								<div className="sticky start-0 flex items-center gap-2 px-3 text-muted-foreground">
									<Plus className="size-3.5" />
									<span className="text-sm">Add row</span>
								</div>
							</div>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
