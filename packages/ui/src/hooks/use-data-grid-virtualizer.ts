import {
	gridColumnIdSchema,
	NON_NAVIGABLE_COLUMN_IDS,
	SCROLL_SYNC_RETRY_COUNT,
	VIEWPORT_OFFSET,
} from "@ryu/ui/hooks/use-data-grid-model.ts";
import type { DataGridTableContext } from "@ryu/ui/hooks/use-data-grid-table.ts";
import { getCellKey } from "@ryu/ui/lib/data-grid.ts";
import type { CellPosition } from "@ryu/ui/types/data-grid.ts";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
	type MouseEvent,
	useCallback,
	useMemo,
	useSyncExternalStore,
} from "react";

function useDataGridVirtualizer<TData>(
	gridContext: DataGridTableContext<TData>
) {
	const {
		cellMapRef,
		dataGridRef,
		focusGuardRef,
		footerRef,
		headerRef,
		onSelectionClear,
		overscan,
		propsRef,
		pushHistory,
		releaseFocusGuard,
		rowHeightValue,
		rowMapRef,
		rowVirtualizerRef,
		store,
		table,
		tableRef,
	} = gridContext;

	const isFirefox = useSyncExternalStore(
		useCallback(() => () => {}, []),
		useCallback(() => {
			if (
				globalThis.window === undefined ||
				globalThis.navigator === undefined
			) {
				return false;
			}
			return navigator.userAgent.indexOf("Firefox") !== -1;
		}, []),
		useCallback(() => false, [])
	);

	const adjustLayout = useMemo(() => {
		const columnPinning = table.getState().columnPinning;
		return (
			isFirefox &&
			((columnPinning.left?.length ?? 0) > 0 ||
				(columnPinning.right?.length ?? 0) > 0)
		);
	}, [isFirefox, table.getState().columnPinning]);

	const rowVirtualizer = useVirtualizer({
		count: table.getRowModel().rows.length,
		getScrollElement: () => dataGridRef.current,
		estimateSize: () => rowHeightValue,
		overscan,
		measureElement: isFirefox
			? undefined
			: (element) => element?.getBoundingClientRect().height,
		scrollPaddingStart:
			(headerRef.current?.getBoundingClientRect().bottom ?? 0) -
			(dataGridRef.current?.getBoundingClientRect().top ?? 0) +
			VIEWPORT_OFFSET,
		// Add extra row buffer to absorb virtual position drift after render measurements
		scrollPaddingEnd:
			(dataGridRef.current?.getBoundingClientRect().bottom ?? 0) -
			(footerRef.current?.getBoundingClientRect().top ??
				dataGridRef.current?.getBoundingClientRect().bottom ??
				0) +
			rowHeightValue +
			VIEWPORT_OFFSET,
	});

	if (!rowVirtualizerRef.current) {
		rowVirtualizerRef.current = rowVirtualizer;
	}

	const onScrollToRow = useCallback(
		async (opts: Partial<CellPosition>) => {
			const rowIndex = opts?.rowIndex ?? 0;
			const columnId = opts?.columnId;

			focusGuardRef.current = true;

			const navigableIds = propsRef.current.columns
				.map((c) => {
					if (c.id) {
						return c.id;
					}
					if ("accessorKey" in c) {
						const parsed = gridColumnIdSchema.safeParse(c.accessorKey);
						return parsed.success ? parsed.data : undefined;
					}
					return undefined;
				})
				.filter((id): id is string => Boolean(id))
				.filter((c) => !NON_NAVIGABLE_COLUMN_IDS.has(c));

			const targetColumnId = columnId ?? navigableIds[0];

			if (!targetColumnId) {
				releaseFocusGuard(true);
				return;
			}

			async function onScrollAndFocus(retryCount: number) {
				if (!targetColumnId) {
					return;
				}
				const currentRowCount = propsRef.current.data.length;

				// If the requested row doesn't exist yet, wait for data to update
				if (rowIndex >= currentRowCount && retryCount > 0) {
					await new Promise((resolve) => setTimeout(resolve, 50));
					await onScrollAndFocus(retryCount - 1);
					return;
				}

				const safeRowIndex = Math.min(
					rowIndex,
					Math.max(0, currentRowCount - 1)
				);

				const isBottomHalf = safeRowIndex > currentRowCount / 2;
				rowVirtualizer.scrollToIndex(safeRowIndex, {
					align: isBottomHalf ? "end" : "start",
				});

				await new Promise((resolve) => requestAnimationFrame(resolve));

				// Adjust scroll position to account for sticky header/footer
				const container = dataGridRef.current;
				const targetRow = rowMapRef.current.get(safeRowIndex);

				if (container && targetRow) {
					const containerRect = container.getBoundingClientRect();
					const headerHeight =
						headerRef.current?.getBoundingClientRect().height ?? 0;
					const footerHeight =
						footerRef.current?.getBoundingClientRect().height ?? 0;

					const viewportTop =
						containerRect.top + headerHeight + VIEWPORT_OFFSET;
					const viewportBottom =
						containerRect.bottom - footerHeight - VIEWPORT_OFFSET;

					const rowRect = targetRow.getBoundingClientRect();
					const isFullyVisible =
						rowRect.top >= viewportTop && rowRect.bottom <= viewportBottom;

					if (!isFullyVisible) {
						if (rowRect.top < viewportTop) {
							// Scroll up as row is partially hidden by header
							container.scrollTop -= viewportTop - rowRect.top;
						} else if (rowRect.bottom > viewportBottom) {
							// Scroll down as row is partially hidden by footer
							container.scrollTop += rowRect.bottom - viewportBottom;
						}
					}
				}

				store.batch(() => {
					store.setState("focusedCell", {
						rowIndex: safeRowIndex,
						columnId: targetColumnId,
					});
					store.setState("editingCell", null);
				});

				const cellKey = getCellKey(safeRowIndex, targetColumnId);
				const cellElement = cellMapRef.current.get(cellKey);

				if (cellElement) {
					cellElement.focus();
					releaseFocusGuard();
				} else if (retryCount > 0) {
					await new Promise((resolve) => requestAnimationFrame(resolve));
					await onScrollAndFocus(retryCount - 1);
				} else {
					dataGridRef.current?.focus();
					releaseFocusGuard();
				}
			}

			await onScrollAndFocus(SCROLL_SYNC_RETRY_COUNT);
		},
		[rowVirtualizer, propsRef, store, releaseFocusGuard]
	);

	// After an "Add row", record whichever rows appeared so Ctrl+Z removes them.
	const getCoreRowIds = useCallback(
		() =>
			new Set(
				(tableRef.current?.getCoreRowModel().rows ?? []).map((r) => r.id)
			),
		[]
	);

	const recordAddedRows = useCallback(
		(before: Set<string>) => {
			const added = (tableRef.current?.getCoreRowModel().rows ?? []).filter(
				(row) => !before.has(row.id)
			);
			if (added.length > 0) {
				pushHistory({
					kind: "rows-inserted",
					rows: added.map((row) => ({
						rowId: row.id,
						dataIndex: row.index,
						original: null,
					})),
				});
			}
		},
		[pushHistory]
	);

	const onRowAdd = useCallback(
		async (event?: MouseEvent<HTMLDivElement>) => {
			if (propsRef.current.readOnly || !propsRef.current.onRowAdd) {
				return;
			}

			const initialRowCount = propsRef.current.data.length;
			const rowIdsBefore = getCoreRowIds();

			let result: Partial<CellPosition> | null;
			try {
				result = await propsRef.current.onRowAdd(event);
			} catch {
				// Callback threw an error, don't proceed with scroll/focus
				return;
			}

			if (result === null || event?.defaultPrevented) {
				return;
			}

			onSelectionClear();

			// onScrollToRow will handle retries if the row isn't rendered yet
			const targetRowIndex = result.rowIndex ?? initialRowCount;
			const targetColumnId = result.columnId;

			await onScrollToRow({
				rowIndex: targetRowIndex,
				columnId: targetColumnId,
			});
			recordAddedRows(rowIdsBefore);
		},
		[propsRef, onScrollToRow, onSelectionClear, getCoreRowIds, recordAddedRows]
	);

	return {
		...gridContext,
		adjustLayout,
		getCoreRowIds,
		onRowAdd,
		onScrollToRow,
		recordAddedRows,
		rowVirtualizer,
	};
}

type DataGridVirtualizerContext<TData> = ReturnType<
	typeof useDataGridVirtualizer<TData>
>;

export { type DataGridVirtualizerContext, useDataGridVirtualizer };
