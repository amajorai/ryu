import { useAsRef } from "@ryu/ui/hooks/use-as-ref.ts";
import {
	getSelectionRect,
	isFillValueCompatible,
} from "@ryu/ui/hooks/use-data-grid-model.ts";
import type { DataGridNavigationContext } from "@ryu/ui/hooks/use-data-grid-navigation.ts";
import {
	buildFillSeries,
	type FillExtension,
	type GridRect,
	getFillExtension,
	getFilledRect,
	isCellValueEmpty,
	repeatPattern,
} from "@ryu/ui/lib/data-grid-fill.ts";
import type {
	CellOpts,
	CellPosition,
	CellUpdate,
	NavigationDirection,
} from "@ryu/ui/types/data-grid.ts";
import { type MouseEvent, useCallback } from "react";

function useDataGridFill<TData>(gridContext: DataGridNavigationContext<TData>) {
	const {
		applyDataUpdate,
		columnIds,
		committedValueRef,
		dataGridRef,
		fillOnCommitRef,
		focusCell,
		focusCellWrapper,
		navigableColumnIds,
		navigateCell,
		onDataUpdate,
		propsRef,
		restoreFocus,
		selectRange,
		store,
		tableRef,
	} = gridContext;

	const onCellEditingStart = useCallback(
		(rowIndex: number, columnId: string) => {
			if (propsRef.current.readOnly) {
				return;
			}

			const variant =
				tableRef.current?.getColumn(columnId)?.columnDef.meta?.cell?.variant;
			if (variant === "formula") {
				return;
			}

			fillOnCommitRef.current = null;
			committedValueRef.current = null;
			store.batch(() => {
				store.setState("focusedCell", { rowIndex, columnId });
				store.setState("editingCell", { rowIndex, columnId });
			});
		},
		[store, propsRef]
	);

	const onCellEditingStop = useCallback(
		(opts?: { moveToNextRow?: boolean; direction?: NavigationDirection }) => {
			const currentState = store.getState();
			const currentEditing = currentState.editingCell;
			const pendingFill = fillOnCommitRef.current;
			const committed = committedValueRef.current;
			fillOnCommitRef.current = null;
			committedValueRef.current = null;

			store.setState("editingCell", null);

			if (
				pendingFill &&
				currentEditing &&
				pendingFill.cell.rowIndex === currentEditing.rowIndex &&
				pendingFill.cell.columnId === currentEditing.columnId
			) {
				const { rowIndex, columnId } = currentEditing;
				const currentTable = tableRef.current;
				const value = committed
					? committed.value
					: currentTable?.getRowModel().rows[rowIndex]?.getValue(columnId);
				const getCellOpts = (id: string) =>
					currentTable?.getColumn(id)?.columnDef.meta?.cell;
				const sourceVariant = getCellOpts(columnId)?.variant;
				const { rect } = pendingFill;
				const updates: CellUpdate[] = [];
				for (let col = rect.minCol; col <= rect.maxCol; col++) {
					const id = navigableColumnIds[col];
					const targetOpts = id ? getCellOpts(id) : undefined;
					if (
						!id ||
						targetOpts?.variant !== sourceVariant ||
						!isFillValueCompatible(value, targetOpts)
					) {
						continue;
					}
					for (let row = rect.minRow; row <= rect.maxRow; row++) {
						updates.push({
							rowIndex: row,
							columnId: id,
							value: repeatPattern([value], 1)[0],
						});
					}
				}
				applyDataUpdate(updates, true);
				focusCellWrapper(rowIndex, columnId);
				return;
			}

			if (opts?.moveToNextRow && currentEditing) {
				const { rowIndex, columnId } = currentEditing;
				const currentTable = tableRef.current;
				const rows = currentTable?.getRowModel().rows ?? [];
				const rowCount = rows.length ?? propsRef.current.data.length;

				const nextRowIndex = rowIndex + 1;
				if (nextRowIndex < rowCount) {
					requestAnimationFrame(() => {
						focusCell(nextRowIndex, columnId);
					});
				}
			} else if (opts?.direction && currentEditing) {
				const { rowIndex, columnId } = currentEditing;
				focusCell(rowIndex, columnId);
				requestAnimationFrame(() => {
					navigateCell(opts.direction ?? "right");
				});
			} else if (currentEditing) {
				const { rowIndex, columnId } = currentEditing;
				focusCellWrapper(rowIndex, columnId);
			}
		},
		[
			store,
			propsRef,
			focusCell,
			navigateCell,
			focusCellWrapper,
			navigableColumnIds,
			applyDataUpdate,
		]
	);

	const getCurrentSelectionRect = useCallback(() => {
		const currentState = store.getState();
		return getSelectionRect({
			columnIds,
			focusedCell: currentState.focusedCell,
			navigableColumnIds,
			selectionState: currentState.selectionState,
		});
	}, [store, columnIds, navigableColumnIds]);

	const selectRect = useCallback(
		(rect: GridRect) => {
			const startColumnId = navigableColumnIds[rect.minCol];
			const endColumnId = navigableColumnIds[rect.maxCol];
			if (!(startColumnId && endColumnId)) {
				return;
			}
			const start = { rowIndex: rect.minRow, columnId: startColumnId };
			if (rect.minRow === rect.maxRow && rect.minCol === rect.maxCol) {
				store.setState("selectionState", {
					selectedCells: new Set(),
					selectionRange: { start, end: start },
					isSelecting: false,
				});
				return;
			}
			selectRange(start, { rowIndex: rect.maxRow, columnId: endColumnId });
		},
		[store, navigableColumnIds, selectRange]
	);

	/**
	 * Extend `source` by `extension`, either continuing its series (fill handle)
	 * or repeating it verbatim (Ctrl+D / Ctrl+R). Returns the filled rectangle,
	 * or null when nothing was written.
	 */
	const applyFill = useCallback(
		(
			source: GridRect,
			extension: FillExtension,
			mode: "series" | "copy"
		): GridRect | null => {
			const currentTable = tableRef.current;
			if (propsRef.current.readOnly || !currentTable) {
				return null;
			}
			const rows = currentTable.getRowModel().rows;
			const { direction } = extension;
			const room =
				direction === "down"
					? rows.length - 1 - source.maxRow
					: direction === "up"
						? source.minRow
						: direction === "right"
							? navigableColumnIds.length - 1 - source.maxCol
							: source.minCol;
			const count = Math.min(extension.count, room);
			if (count <= 0) {
				return null;
			}

			const getCellOpts = (columnId: string) =>
				currentTable.getColumn(columnId)?.columnDef.meta?.cell;
			const reverse = direction === "up" || direction === "left";
			const extend = (values: unknown[], cellOpts?: CellOpts) => {
				const ordered = reverse ? [...values].reverse() : values;
				return mode === "copy"
					? repeatPattern(ordered, count)
					: buildFillSeries(ordered, count, cellOpts, reverse);
			};
			const updates: CellUpdate[] = [];

			if (direction === "down" || direction === "up") {
				for (let col = source.minCol; col <= source.maxCol; col++) {
					const columnId = navigableColumnIds[col];
					if (!columnId) {
						continue;
					}
					const values: unknown[] = [];
					for (let row = source.minRow; row <= source.maxRow; row++) {
						values.push(rows[row]?.getValue(columnId));
					}
					for (const [i, value] of extend(
						values,
						getCellOpts(columnId)
					).entries()) {
						updates.push({
							rowIndex: reverse ? source.minRow - 1 - i : source.maxRow + 1 + i,
							columnId,
							value,
						});
					}
				}
			} else {
				const width = source.maxCol - source.minCol + 1;
				const sourceIds = navigableColumnIds.slice(
					source.minCol,
					source.maxCol + 1
				);
				const sourceOpts = sourceIds.map(getCellOpts);
				const firstVariant = sourceOpts[0]?.variant;
				const sharedOpts = sourceOpts.every((o) => o?.variant === firstVariant)
					? sourceOpts[0]
					: { variant: "checkbox" as const };

				for (let row = source.minRow; row <= source.maxRow; row++) {
					const values = sourceIds.map((id) => rows[row]?.getValue(id));
					for (const [i, value] of extend(values, sharedOpts).entries()) {
						const col = reverse ? source.minCol - 1 - i : source.maxCol + 1 + i;
						const columnId = navigableColumnIds[col];
						if (!columnId) {
							continue;
						}
						// Horizontal fills cross column types; only write where the target
						// column has the same type (and options) as the cell it copies.
						const patternIndex = reverse ? width - 1 - (i % width) : i % width;
						const targetOpts = getCellOpts(columnId);
						if (
							targetOpts?.variant !== sourceOpts[patternIndex]?.variant ||
							!isFillValueCompatible(value, targetOpts)
						) {
							continue;
						}
						updates.push({ rowIndex: row, columnId, value });
					}
				}
			}

			if (updates.length === 0) {
				return null;
			}
			onDataUpdate(updates);
			return getFilledRect(source, { direction, count });
		},
		[propsRef, navigableColumnIds, onDataUpdate]
	);

	const updateFillDrag = useCallback(
		(target: CellPosition) => {
			const { fillDrag } = store.getState();
			if (
				!fillDrag ||
				(fillDrag.end.rowIndex === target.rowIndex &&
					fillDrag.end.columnId === target.columnId)
			) {
				return;
			}
			store.setState("fillDrag", { ...fillDrag, end: target });
			const col = navigableColumnIds.indexOf(target.columnId);
			const extension = getFillExtension(fillDrag.source, {
				row: target.rowIndex,
				col: col === -1 ? fillDrag.source.minCol : col,
			});
			selectRect(
				extension ? getFilledRect(fillDrag.source, extension) : fillDrag.source
			);
		},
		[store, navigableColumnIds, selectRect]
	);
	const fillDragDepsRef = useAsRef({ updateFillDrag });

	const commitFillDrag = useCallback(() => {
		const { fillDrag } = store.getState();
		if (!fillDrag) {
			return;
		}
		store.setState("fillDrag", null);
		const col = navigableColumnIds.indexOf(fillDrag.end.columnId);
		const extension = getFillExtension(fillDrag.source, {
			row: fillDrag.end.rowIndex,
			col: col === -1 ? fillDrag.source.minCol : col,
		});
		const filled = extension
			? applyFill(fillDrag.source, extension, "series")
			: null;
		selectRect(filled ?? fillDrag.source);
		restoreFocus(dataGridRef.current);
	}, [store, navigableColumnIds, applyFill, selectRect, restoreFocus]);

	const onFillHandleMouseDown = useCallback(
		(event: MouseEvent) => {
			if (event.button !== 0 || propsRef.current.readOnly) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			const source = getCurrentSelectionRect();
			const endColumnId = source && navigableColumnIds[source.maxCol];
			if (!(source && endColumnId)) {
				return;
			}
			store.setState("fillDrag", {
				source,
				end: { rowIndex: source.maxRow, columnId: endColumnId },
			});
			function onMouseUp() {
				document.removeEventListener("mouseup", onMouseUp);
				commitFillDrag();
			}
			document.addEventListener("mouseup", onMouseUp);
		},
		[
			propsRef,
			store,
			navigableColumnIds,
			getCurrentSelectionRect,
			commitFillDrag,
		]
	);

	// Excel's double-click on the fill handle: fill down as far as the adjacent
	// column's data runs. Without adjacent data, fill the blank gap below (to
	// the next filled row or the end of the table).
	const onFillHandleDoubleClick = useCallback(() => {
		const source = getCurrentSelectionRect();
		const rows = tableRef.current?.getRowModel().rows ?? [];
		if (!source || propsRef.current.readOnly) {
			return;
		}
		const isFilled = (row: number, col: number) => {
			const columnId = navigableColumnIds[col];
			return columnId
				? !isCellValueEmpty(rows[row]?.getValue(columnId))
				: false;
		};

		let lastRow = source.maxRow;
		for (const neighbor of [source.minCol - 1, source.maxCol + 1]) {
			if (neighbor < 0 || neighbor >= navigableColumnIds.length) {
				continue;
			}
			let row = source.maxRow;
			while (row + 1 < rows.length && isFilled(row + 1, neighbor)) {
				row++;
			}
			if (row > source.maxRow) {
				lastRow = row;
				break;
			}
		}
		if (lastRow === source.maxRow) {
			const isRowBlank = (row: number) => {
				for (let col = source.minCol; col <= source.maxCol; col++) {
					if (isFilled(row, col)) {
						return false;
					}
				}
				return true;
			};
			while (lastRow + 1 < rows.length && isRowBlank(lastRow + 1)) {
				lastRow++;
			}
		}
		if (lastRow === source.maxRow) {
			return;
		}

		const filled = applyFill(
			source,
			{ direction: "down", count: lastRow - source.maxRow },
			"series"
		);
		if (filled) {
			selectRect(filled);
		}
		restoreFocus(dataGridRef.current);
	}, [
		propsRef,
		navigableColumnIds,
		getCurrentSelectionRect,
		applyFill,
		selectRect,
		restoreFocus,
	]);

	return {
		...gridContext,
		applyFill,
		fillDragDepsRef,
		getCurrentSelectionRect,
		onCellEditingStart,
		onCellEditingStop,
		onFillHandleDoubleClick,
		onFillHandleMouseDown,
		updateFillDrag,
	};
}

type DataGridFillContext<TData> = ReturnType<typeof useDataGridFill<TData>>;

export { type DataGridFillContext, useDataGridFill };
