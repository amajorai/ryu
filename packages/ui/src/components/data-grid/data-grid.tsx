"use client";

import { DataGridColumnHeader } from "@ryu/ui/components/data-grid/data-grid-column-header.tsx";
import { DataGridContextMenu } from "@ryu/ui/components/data-grid/data-grid-context-menu.tsx";
import { DataGridPasteDialog } from "@ryu/ui/components/data-grid/data-grid-paste-dialog.tsx";
import { DataGridRow } from "@ryu/ui/components/data-grid/data-grid-row.tsx";
import { DataGridSearch } from "@ryu/ui/components/data-grid/data-grid-search.tsx";
import { useAsRef } from "@ryu/ui/hooks/use-as-ref.ts";
import type { useDataGrid } from "@ryu/ui/hooks/use-data-grid.ts";
import {
	type ColumnPinningStyle,
	flexRender,
	getColumnBorderVisibility,
	getColumnPinningStyle,
} from "@ryu/ui/lib/data-grid.ts";
import type { SelectionSummary } from "@ryu/ui/lib/data-grid-fill.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { Direction } from "@ryu/ui/types/data-grid.ts";
import { Plus } from "lucide-react";
import {
	type ComponentProps,
	type CSSProperties,
	type KeyboardEvent,
	type MouseEvent,
	useCallback,
	useLayoutEffect,
} from "react";
import { isNativeFunction } from "../../lib/native-primitive-observation.ts";

import styles from "./data-grid.module.css";

interface GridColumnStyle extends CSSProperties {
	[key: `--header-${string}-size`]: number;
	[key: `--col-${string}-size`]: number;
}
interface GridStyle extends Partial<ColumnPinningStyle> {
	"--grid-body-height"?: string;
	"--grid-cell-width"?: string;
	"--grid-contain"?: string;
	"--grid-height"?: string;
	"--grid-total-width"?: string;
}

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
	fillHandleCell,
	enableSelectionSummary,
	selectionSummary,
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

	const gridStyle: GridStyle = { "--grid-height": `${height}px` };
	const columnStyle: GridColumnStyle = { ...columnSizeVars };
	useLayoutEffect(() => {
		const element = dataGridRef.current;
		if (!element) {
			return;
		}
		for (const [name, size] of Object.entries(columnStyle)) {
			element.style.setProperty(name, String(size));
		}
		return () => {
			for (const name of Object.keys(columnStyle)) {
				element.style.removeProperty(name);
			}
		};
	}, [columnStyle, dataGridRef]);
	const minimumStyle: GridStyle = {
		"--grid-total-width": `${table.getTotalSize()}px`,
	};
	const bodyStyle: GridStyle = {
		...minimumStyle,
		"--grid-body-height": `${virtualTotalSize}px`,
		"--grid-contain": adjustLayout ? "layout paint" : "strict",
	};

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
				className={cn(
					"relative grid select-none overflow-auto rounded-md border focus:outline-none",
					styles.grid
				)}
				data-slot="grid"
				onContextMenu={onDataGridContextMenu}
				ref={dataGridRef}
				role="grid"
				style={gridStyle}
				tabIndex={0}
			>
				{/* `minWidth` is load-bearing, not cosmetic. The scroll container is a
				    `grid`, so a rowgroup with no explicit width resolves against the
				    container's CONTENT box rather than its scroll width — the header and
				    the body then size themselves independently, and once the columns
				    total wider than the viewport the two stop agreeing on where each
				    column starts. That is the header/row misalignment. The add-row below
				    already pinned `table.getTotalSize()` for exactly this reason; the
				    header and body were simply never given the same treatment. */}
				<div
					className={cn(
						"sticky top-0 z-10 grid border-b bg-background",
						styles.minimum
					)}
					data-slot="grid-header"
					ref={headerRef}
					role="rowgroup"
					style={minimumStyle}
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

								const pinStyle = getColumnPinningStyle({
									column: header.column,
									dir,
								});
								const cellStyle: GridStyle = {
									"--data-grid-pin-left": pinStyle["--data-grid-pin-left"],
									"--data-grid-pin-right": pinStyle["--data-grid-pin-right"],
									"--data-grid-pin-opacity":
										pinStyle["--data-grid-pin-opacity"],
									"--data-grid-pin-position":
										pinStyle["--data-grid-pin-position"],
									"--data-grid-pin-shadow": pinStyle["--data-grid-pin-shadow"],
									"--data-grid-pin-width": pinStyle["--data-grid-pin-width"],
									"--data-grid-pin-z-index":
										pinStyle["--data-grid-pin-z-index"],
									"--grid-cell-width": `calc(var(--header-${header.id}-size) * 1px)`,
								};
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
										className={cn("relative", styles.cell, {
											grow: stretchColumns && header.column.id !== "select",
											"border-e":
												showEndBorder && header.column.id !== "select",
											"border-s":
												showStartBorder && header.column.id !== "select",
										})}
										data-slot="grid-header-cell"
										key={header.id}
										role="columnheader"
										style={cellStyle}
										tabIndex={-1}
									>
										{header.isPlaceholder ? null : isNativeFunction(
												header.column.columnDef.header
											) ? (
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
					className={cn("relative grid", styles.body)}
					data-slot="grid-body"
					role="rowgroup"
					style={bodyStyle}
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
								columnDefs={columns}
								columnPinning={columnPinning}
								columnVisibility={columnVisibility}
								dir={dir}
								editingCell={editingCell}
								fillHandleColumnId={
									fillHandleCell?.rowIndex === virtualItem.index
										? fillHandleCell.columnId
										: null
								}
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
				{!readOnly && onRowAddProp && (
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
								className={cn(
									"relative flex h-9 grow items-center bg-muted/30 transition-colors hover:bg-muted/50 focus:bg-muted/50 focus:outline-none",
									styles.add
								)}
								onClick={onRowAdd}
								onKeyDown={onFooterCellKeyDown}
								role="gridcell"
								style={minimumStyle}
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
			{enableSelectionSummary && (
				<DataGridStatusBar
					rowCount={rows.length}
					summary={selectionSummary}
					totalRowCount={table.getCoreRowModel().rows.length}
				/>
			)}
		</div>
	);
}

const numberFormat = new Intl.NumberFormat(undefined, {
	maximumFractionDigits: 4,
});

function DataGridStatusBar({
	rowCount,
	summary,
	totalRowCount,
}: {
	rowCount: number;
	summary: SelectionSummary | null;
	totalRowCount: number;
}) {
	const rowsLabel =
		rowCount === totalRowCount
			? numberFormat.format(rowCount)
			: `${numberFormat.format(rowCount)} of ${numberFormat.format(totalRowCount)}`;
	const items: [label: string, value: string][] = summary
		? [["Count", numberFormat.format(summary.count)]]
		: [[totalRowCount === 1 ? "Row" : "Rows", rowsLabel]];
	if (summary && summary.numericCount > 0) {
		for (const [label, value] of [
			["Average", summary.average],
			["Min", summary.min],
			["Max", summary.max],
			["Sum", summary.sum],
		] as const) {
			if (value !== null) {
				items.push([label, numberFormat.format(value)]);
			}
		}
	}

	return (
		<output
			aria-live="polite"
			className="flex h-7 items-center justify-end gap-4 px-1 text-muted-foreground text-xs tabular-nums"
			data-slot="grid-status-bar"
		>
			{items.map(([label, value]) => (
				<span key={label}>
					{label}: <span className="text-foreground">{value}</span>
				</span>
			))}
		</output>
	);
}
