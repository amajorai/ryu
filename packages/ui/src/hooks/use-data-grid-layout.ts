import type { DataGridEffectsContext } from "@ryu/ui/hooks/use-data-grid-effects.ts";
import {
	AUTO_SCROLL_MAX_SPEED,
	AUTO_SCROLL_MIN_SPEED,
	AUTO_SCROLL_SELECTION_THROTTLE_MS,
	AUTO_SCROLL_SPEED_RAMP_ZONE,
	getSelectionRect,
	NON_NAVIGABLE_COLUMN_IDS,
} from "@ryu/ui/hooks/use-data-grid-model.ts";
import { useIsomorphicLayoutEffect } from "@ryu/ui/hooks/use-isomorphic-layout-effect.ts";
import { parseCellKey } from "@ryu/ui/lib/data-grid.ts";
import {
	type SelectionSummary,
	summarizeValues,
} from "@ryu/ui/lib/data-grid-fill.ts";
import type { CellPosition } from "@ryu/ui/types/data-grid.ts";
import { useEffect, useMemo } from "react";

function useDataGridLayout<TData>(gridContext: DataGridEffectsContext<TData>) {
	const {
		columnIds,
		dataGridRef,
		dragDepsRef,
		editingCell,
		fillDragDepsRef,
		focusedCell,
		footerRef,
		headerRef,
		navigableColumnIds,
		propsRef,
		rowHeight,
		rowVirtualizer,
		selectionState,
		store,
		table,
		tableRef,
	} = gridContext;

	useEffect(() => {
		let rafId: number | null = null;
		let mouseX = 0;
		let mouseY = 0;
		let mouseReady = false;
		let active = false;
		let lastSelectionTime = 0;
		let resizeObserver: ResizeObserver | null = null;

		let cachedRect: DOMRect | null = null;
		let cachedHdrH = 0;
		let cachedFtrH = 0;
		let cachedLpw = 0;
		let cachedRpw = 0;

		function getAutoScrollSpeed(dist: number): number {
			const t = Math.min(dist / AUTO_SCROLL_SPEED_RAMP_ZONE, 1);
			return Math.round(
				AUTO_SCROLL_MIN_SPEED +
					(AUTO_SCROLL_MAX_SPEED - AUTO_SCROLL_MIN_SPEED) * t
			);
		}

		function cacheLayout(container: HTMLDivElement) {
			cachedRect = container.getBoundingClientRect();
			cachedHdrH = headerRef.current?.getBoundingClientRect().height ?? 0;
			cachedFtrH = footerRef.current?.getBoundingClientRect().height ?? 0;
			const tbl = tableRef.current;
			if (tbl) {
				cachedLpw = tbl
					.getLeftVisibleLeafColumns()
					.reduce((s, c) => s + c.getSize(), 0);
				cachedRpw = tbl
					.getRightVisibleLeafColumns()
					.reduce((s, c) => s + c.getSize(), 0);
			}
		}

		function tick() {
			if (!active) {
				return;
			}
			const container = dataGridRef.current;
			const tbl = tableRef.current;

			if (!(container && tbl)) {
				onAutoScrollStop();
				return;
			}

			if (!(mouseReady && cachedRect)) {
				rafId = requestAnimationFrame(tick);
				return;
			}

			const rect = cachedRect;
			const { dir } = dragDepsRef.current;
			const hasNegativeScroll = container.scrollLeft < 0;
			const isActuallyRtl = dir === "rtl" || hasNegativeScroll;

			const dataTop = rect.top + cachedHdrH;
			const dataBottom = rect.bottom - cachedFtrH;

			const scrollAreaLeft = isActuallyRtl
				? rect.left + cachedRpw
				: rect.left + cachedLpw;
			const scrollAreaRight = isActuallyRtl
				? rect.right - cachedLpw
				: rect.right - cachedRpw;

			let dy = 0;
			let dx = 0;

			if (mouseY < dataTop) {
				dy = -getAutoScrollSpeed(dataTop - mouseY);
			} else if (mouseY > dataBottom) {
				dy = getAutoScrollSpeed(mouseY - dataBottom);
			}

			if (mouseX < scrollAreaLeft) {
				dx = -getAutoScrollSpeed(scrollAreaLeft - mouseX);
			} else if (mouseX > scrollAreaRight) {
				dx = getAutoScrollSpeed(mouseX - scrollAreaRight);
			}

			if (dx === 0 && dy === 0) {
				rafId = requestAnimationFrame(tick);
				return;
			}

			container.scrollTop += dy;
			container.scrollLeft += dx;

			const now = performance.now();
			if (now - lastSelectionTime < AUTO_SCROLL_SELECTION_THROTTLE_MS) {
				rafId = requestAnimationFrame(tick);
				return;
			}

			const { rowHeightValue: rh, columnIds } = dragDepsRef.current;
			if (columnIds.length === 0) {
				rafId = requestAnimationFrame(tick);
				return;
			}

			const totalRows = tbl.getRowModel().rows.length;
			const clampedY = Math.max(dataTop, Math.min(mouseY, dataBottom));
			const absY = container.scrollTop + (clampedY - dataTop);
			const rowIndex = Math.max(
				0,
				Math.min(Math.floor(absY / rh), totalRows - 1)
			);

			const st = store.getState();
			const range = st.selectionState.selectionRange;
			const fillEnd = st.fillDrag?.end;
			const currentEnd = fillEnd ?? range?.end;

			let columnId: string | undefined;

			if (dx !== 0) {
				const clampedX = Math.max(rect.left, Math.min(mouseX, rect.right));
				const relX = clampedX - rect.left;

				const leftZoneWidth = isActuallyRtl ? cachedRpw : cachedLpw;
				const rightZoneWidth = isActuallyRtl ? cachedLpw : cachedRpw;

				if (relX < leftZoneWidth) {
					const columns = isActuallyRtl
						? tbl.getRightVisibleLeafColumns()
						: tbl.getLeftVisibleLeafColumns();
					columnId = columns[0]?.id ?? columnIds[0] ?? "";
					let cx = 0;
					for (const col of columns) {
						if (relX < cx + col.getSize()) {
							columnId = col.id;
							break;
						}
						cx += col.getSize();
					}
				} else if (relX > rect.width - rightZoneWidth) {
					const columns = isActuallyRtl
						? tbl.getLeftVisibleLeafColumns()
						: tbl.getRightVisibleLeafColumns();
					columnId = columns[0]?.id ?? columnIds.at(-1) ?? "";
					let cx = rect.width - rightZoneWidth;
					for (const col of columns) {
						if (relX < cx + col.getSize()) {
							columnId = col.id;
							break;
						}
						cx += col.getSize();
					}
				} else {
					const center = tbl.getCenterVisibleLeafColumns();
					const centerZoneWidth = rect.width - leftZoneWidth - rightZoneWidth;
					const distFromVisualLeft = relX - leftZoneWidth;

					let absX: number;
					if (isActuallyRtl) {
						const scrollFromRight = hasNegativeScroll
							? -container.scrollLeft
							: container.scrollWidth -
								container.clientWidth -
								container.scrollLeft;
						absX = scrollFromRight + (centerZoneWidth - distFromVisualLeft);
					} else {
						absX = container.scrollLeft + distFromVisualLeft;
					}

					columnId = center.at(-1)?.id ?? columnIds.at(-1) ?? "";
					let cw = 0;
					for (const col of center) {
						cw += col.getSize();
						if (absX < cw) {
							columnId = col.id;
							break;
						}
					}
				}
			}

			if (!columnId) {
				columnId = currentEnd?.columnId ?? columnIds[0] ?? "";
			}

			if (
				currentEnd &&
				(rowIndex !== currentEnd.rowIndex || columnId !== currentEnd.columnId)
			) {
				if (fillEnd) {
					fillDragDepsRef.current.updateFillDrag({ rowIndex, columnId });
				} else if (range) {
					dragDepsRef.current.selectRange(
						range.start,
						{ rowIndex, columnId },
						true
					);
				}
				lastSelectionTime = now;
			}

			rafId = requestAnimationFrame(tick);
		}

		function onMove(event: globalThis.MouseEvent) {
			mouseX = event.clientX;
			mouseY = event.clientY;
			mouseReady = true;
		}

		function onUp() {
			onAutoScrollStop();
			const st = store.getState();
			if (st.selectionState.isSelecting) {
				store.setState("selectionState", {
					...st.selectionState,
					isSelecting: false,
				});
			}
		}

		function onAutoScrollStart() {
			if (active) {
				return;
			}

			const container = dataGridRef.current;
			if (!container) {
				return;
			}

			active = true;
			mouseReady = false;
			cachedRect = null;
			lastSelectionTime = 0;
			document.addEventListener("mousemove", onMove);
			document.addEventListener("mouseup", onUp);
			resizeObserver = new ResizeObserver(() => {
				const currentContainer = dataGridRef.current;
				if (currentContainer) {
					cacheLayout(currentContainer);
				}
			});
			resizeObserver.observe(container);
			rafId = requestAnimationFrame(() => {
				const currentContainer = dataGridRef.current;
				if (currentContainer) {
					cacheLayout(currentContainer);
				}
				rafId = requestAnimationFrame(tick);
			});
		}

		function onAutoScrollStop() {
			if (!active) {
				return;
			}
			active = false;
			cachedRect = null;
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseup", onUp);
			resizeObserver?.disconnect();
			resizeObserver = null;
			if (rafId !== null) {
				cancelAnimationFrame(rafId);
				rafId = null;
			}
		}

		const isDragging = () => {
			const st = store.getState();
			return st.selectionState.isSelecting || st.fillDrag !== null;
		};

		if (isDragging()) {
			onAutoScrollStart();
		}

		const onUnsubscribe = store.subscribe(() => {
			const dragging = isDragging();
			if (dragging && !active) {
				onAutoScrollStart();
			} else if (!dragging && active) {
				onAutoScrollStop();
			}
		});

		return () => {
			onAutoScrollStop();
			onUnsubscribe();
		};
	}, [store, dragDepsRef, fillDragDepsRef]);

	useIsomorphicLayoutEffect(() => {
		const rafId = requestAnimationFrame(() => {
			rowVirtualizer.measure();
		});
		return () => cancelAnimationFrame(rafId);
	}, [
		rowHeight,
		table.getState().columnFilters,
		table.getState().columnOrder,
		table.getState().columnPinning,
		table.getState().columnSizing,
		table.getState().columnVisibility,
		table.getState().expanded,
		table.getState().globalFilter,
		table.getState().grouping,
		table.getState().rowSelection,
		table.getState().sorting,
	]);

	const readOnly = propsRef.current.readOnly ?? false;

	// The fill handle sits on the bottom-end cell of a rectangular selection.
	const fillHandleCell = useMemo<CellPosition | null>(() => {
		if (readOnly || editingCell) {
			return null;
		}
		const rect = getSelectionRect({
			columnIds,
			focusedCell,
			navigableColumnIds,
			selectionState,
		});
		const columnId = rect && navigableColumnIds[rect.maxCol];
		return rect && columnId ? { rowIndex: rect.maxRow, columnId } : null;
	}, [
		readOnly,
		editingCell,
		focusedCell,
		selectionState,
		columnIds,
		navigableColumnIds,
	]);

	const enableSelectionSummary =
		propsRef.current.enableSelectionSummary ?? false;

	// The row model's identity changes when sorting or filtering reorders rows,
	// which re-maps the visual row indices the selection is stored as.
	const visibleRows = table.getRowModel().rows;

	const selectionSummary = useMemo<SelectionSummary | null>(() => {
		if (!enableSelectionSummary || selectionState.selectedCells.size < 2) {
			return null;
		}
		const rows = visibleRows;
		const values: unknown[] = [];
		for (const cellKey of selectionState.selectedCells) {
			const { rowIndex, columnId } = parseCellKey(cellKey);
			if (!NON_NAVIGABLE_COLUMN_IDS.has(columnId)) {
				values.push(rows[rowIndex]?.getValue(columnId));
			}
		}
		return summarizeValues(values);
	}, [enableSelectionSummary, selectionState.selectedCells, visibleRows]);

	const virtualTotalSize = rowVirtualizer.getTotalSize();
	const virtualItems = rowVirtualizer.getVirtualItems();
	const measureElement = rowVirtualizer.measureElement;

	return {
		...gridContext,
		enableSelectionSummary,
		fillHandleCell,
		measureElement,
		selectionSummary,
		virtualItems,
		virtualTotalSize,
	};
}

type DataGridLayoutContext<TData> = ReturnType<typeof useDataGridLayout<TData>>;

export { type DataGridLayoutContext, useDataGridLayout };
