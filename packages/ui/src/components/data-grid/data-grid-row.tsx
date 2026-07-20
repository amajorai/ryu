"use client";

import { DataGridCell } from "@ryu/ui/components/data-grid/data-grid-cell.tsx";
import { useComposedRefs } from "@ryu/ui/lib/compose-refs.ts";
import {
	flexRender,
	getCellKey,
	getColumnBorderVisibility,
	getColumnPinningStyle,
	getRowHeightValue,
} from "@ryu/ui/lib/data-grid.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type {
	CellPosition,
	Direction,
	RowHeightValue,
} from "@ryu/ui/types/data-grid.ts";
import type {
	ColumnPinningState,
	Row,
	TableMeta,
	VisibilityState,
} from "@tanstack/react-table";
import type { VirtualItem } from "@tanstack/react-virtual";
import {
	type ComponentProps,
	memo,
	type RefObject,
	useCallback,
	useMemo,
} from "react";

interface DataGridRowProps<TData> extends ComponentProps<"div"> {
	activeSearchMatch: CellPosition | null;
	adjustLayout: boolean;
	cellSelectionKeys: Set<string>;
	columnPinning: ColumnPinningState;
	columnVisibility: VisibilityState;
	dir: Direction;
	editingCell: CellPosition | null;
	focusedCell: CellPosition | null;
	measureElement: (node: Element | null) => void;
	readOnly: boolean;
	row: Row<TData>;
	rowHeight: RowHeightValue;
	rowMapRef: RefObject<Map<number, HTMLDivElement>>;
	searchMatchColumns: Set<string> | null;
	stretchColumns: boolean;
	tableMeta: TableMeta<TData>;
	virtualItem: VirtualItem;
}

export const DataGridRow = memo(DataGridRowImpl, (prev, next) => {
	const prevRowIndex = prev.virtualItem.index;
	const nextRowIndex = next.virtualItem.index;

	// Re-render if row identity changed
	if (prev.row.id !== next.row.id) {
		return false;
	}

	// Re-render if row data (original) reference changed
	if (prev.row.original !== next.row.original) {
		return false;
	}

	// Re-render if virtual position changed (handles transform updates)
	if (prev.virtualItem.start !== next.virtualItem.start) {
		return false;
	}

	// Re-render if focus state changed for this row
	const prevHasFocus = prev.focusedCell?.rowIndex === prevRowIndex;
	const nextHasFocus = next.focusedCell?.rowIndex === nextRowIndex;

	if (prevHasFocus !== nextHasFocus) {
		return false;
	}

	// Re-render if focused column changed within this row
	if (
		nextHasFocus &&
		prevHasFocus &&
		prev.focusedCell?.columnId !== next.focusedCell?.columnId
	) {
		return false;
	}

	// Re-render if editing state changed for this row
	const prevHasEditing = prev.editingCell?.rowIndex === prevRowIndex;
	const nextHasEditing = next.editingCell?.rowIndex === nextRowIndex;

	if (prevHasEditing !== nextHasEditing) {
		return false;
	}

	// Re-render if editing column changed within this row
	if (
		nextHasEditing &&
		prevHasEditing &&
		prev.editingCell?.columnId !== next.editingCell?.columnId
	) {
		return false;
	}

	// Re-render if this row's selected cells changed
	// Using stable Set reference that only includes this row's cells
	if (prev.cellSelectionKeys !== next.cellSelectionKeys) {
		return false;
	}

	// Re-render if column visibility changed
	if (prev.columnVisibility !== next.columnVisibility) {
		return false;
	}

	// Re-render if row height changed
	if (prev.rowHeight !== next.rowHeight) {
		return false;
	}

	// Re-render if column pinning state changed
	if (prev.columnPinning !== next.columnPinning) {
		return false;
	}

	// Re-render if readOnly changed
	if (prev.readOnly !== next.readOnly) {
		return false;
	}

	// Re-render if search match columns changed for this row
	if (prev.searchMatchColumns !== next.searchMatchColumns) {
		return false;
	}

	// Re-render if active search match changed for this row
	if (prev.activeSearchMatch?.columnId !== next.activeSearchMatch?.columnId) {
		return false;
	}

	// Re-render if direction changed
	if (prev.dir !== next.dir) {
		return false;
	}

	// Re-render if adjustLayout state changed
	if (prev.adjustLayout !== next.adjustLayout) {
		return false;
	}

	// Re-render if stretchColumns changed
	if (prev.stretchColumns !== next.stretchColumns) {
		return false;
	}

	// Skip re-render - props are equal
	return true;
}) as typeof DataGridRowImpl;

function DataGridRowImpl<TData>({
	row,
	tableMeta,
	virtualItem,
	measureElement,
	rowMapRef,
	rowHeight,
	columnVisibility,
	columnPinning,
	focusedCell,
	editingCell,
	cellSelectionKeys,
	searchMatchColumns,
	activeSearchMatch,
	dir,
	readOnly,
	stretchColumns,
	adjustLayout,
	className,
	style,
	ref,
	...props
}: DataGridRowProps<TData>) {
	const virtualRowIndex = virtualItem.index;

	const onRowChange = useCallback(
		(node: HTMLDivElement | null) => {
			if (typeof virtualRowIndex === "undefined") {
				return;
			}

			if (node) {
				measureElement(node);
				rowMapRef.current?.set(virtualRowIndex, node);
			} else {
				rowMapRef.current?.delete(virtualRowIndex);
			}
		},
		[virtualRowIndex, measureElement, rowMapRef]
	);

	const rowRef = useComposedRefs(ref, onRowChange);

	const isRowSelected = row.getIsSelected();

	// Memoize visible cells to avoid recreating cell array on every render
	// Though TanStack returns new Cell wrappers, memoizing the array helps React's reconciliation
	// biome-ignore lint/correctness/useExhaustiveDependencies: columnVisibility and columnPinning are used for calculating the visible cells
	const visibleCells = useMemo(
		() => row.getVisibleCells(),
		[row, columnVisibility, columnPinning]
	);

	return (
		<div
			aria-rowindex={virtualRowIndex + 2}
			aria-selected={isRowSelected}
			data-index={virtualRowIndex}
			data-slot="grid-row"
			key={row.id}
			role="row"
			tabIndex={-1}
			{...props}
			className={cn(
				"absolute flex w-full border-b [content-visibility:auto]",
				!adjustLayout && "will-change-transform",
				className
			)}
			ref={rowRef}
			style={{
				height: `${getRowHeightValue(rowHeight)}px`,
				...(adjustLayout
					? { top: `${virtualItem.start}px` }
					: { transform: `translateY(${virtualItem.start}px)` }),
				...style,
			}}
		>
			{visibleCells.map((cell, colIndex) => {
				const columnId = cell.column.id;

				const isCellFocused =
					focusedCell?.rowIndex === virtualRowIndex &&
					focusedCell?.columnId === columnId;
				const isCellEditing =
					editingCell?.rowIndex === virtualRowIndex &&
					editingCell?.columnId === columnId;
				const isCellSelected =
					cellSelectionKeys?.has(getCellKey(virtualRowIndex, columnId)) ??
					false;

				const isSearchMatch = searchMatchColumns?.has(columnId) ?? false;
				const isActiveSearchMatch = activeSearchMatch?.columnId === columnId;

				const nextCell = visibleCells[colIndex + 1];
				const isLastColumn = colIndex === visibleCells.length - 1;
				const { showEndBorder, showStartBorder } = getColumnBorderVisibility({
					column: cell.column,
					nextColumn: nextCell?.column,
					isLastColumn,
				});

				return (
					<div
						aria-colindex={colIndex + 1}
						className={cn({
							grow: stretchColumns && columnId !== "select",
							"border-e": showEndBorder && columnId !== "select",
							"border-s": showStartBorder && columnId !== "select",
						})}
						data-highlighted={isCellFocused ? "" : undefined}
						data-slot="grid-cell"
						key={cell.id}
						role="gridcell"
						style={{
							...getColumnPinningStyle({ column: cell.column, dir }),
							width: `calc(var(--col-${columnId}-size) * 1px)`,
						}}
						tabIndex={-1}
					>
						{typeof cell.column.columnDef.header === "function" ? (
							<div
								className={cn("size-full px-3 py-1.5", {
									"bg-primary/10": isRowSelected,
								})}
							>
								{flexRender(cell.column.columnDef.cell, cell.getContext())}
							</div>
						) : (
							<DataGridCell
								cell={cell}
								columnId={columnId}
								isActiveSearchMatch={isActiveSearchMatch}
								isEditing={isCellEditing}
								isFocused={isCellFocused}
								isSearchMatch={isSearchMatch}
								isSelected={isCellSelected}
								readOnly={readOnly}
								rowHeight={rowHeight}
								rowIndex={virtualRowIndex}
								tableMeta={tableMeta}
							/>
						)}
					</div>
				);
			})}
		</div>
	);
}
