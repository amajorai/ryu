import type { DataGridHistoryContext } from "@ryu/ui/hooks/use-data-grid-history.ts";
import { VIEWPORT_OFFSET } from "@ryu/ui/hooks/use-data-grid-model.ts";
import { getCellKey, scrollCellIntoView } from "@ryu/ui/lib/data-grid.ts";
import type { CellPosition } from "@ryu/ui/types/data-grid.ts";
import { type MouseEvent, useCallback, useMemo } from "react";

function useDataGridPointer<TData>(gridContext: DataGridHistoryContext<TData>) {
	const {
		cellMapRef,
		columnIds,
		dataGridRef,
		dir,
		focusCell,
		matchIndex,
		onCellEditingStart,
		onSelectionClear,
		propsRef,
		rowVirtualizerRef,
		searchMatches,
		selectRange,
		store,
		tableRef,
		updateFillDrag,
	} = gridContext;

	const onSearch = useCallback(
		(query: string) => {
			if (!query.trim()) {
				store.batch(() => {
					store.setState("searchMatches", []);
					store.setState("matchIndex", -1);
				});
				return;
			}

			const matches: CellPosition[] = [];
			const currentTable = tableRef.current;
			const rows = currentTable?.getRowModel().rows ?? [];

			const lowerQuery = query.toLowerCase();

			for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
				const row = rows[rowIndex];
				if (!row) {
					continue;
				}

				const cellById = new Map(
					row.getVisibleCells().map((c) => [c.column.id, c])
				);

				for (const columnId of columnIds) {
					const cell = cellById.get(columnId);
					if (!cell) {
						continue;
					}

					const value = cell.getValue();
					const stringValue = String(value ?? "").toLowerCase();

					if (stringValue.includes(lowerQuery)) {
						matches.push({ rowIndex, columnId });
					}
				}
			}

			store.batch(() => {
				store.setState("searchMatches", matches);
				store.setState("matchIndex", matches.length > 0 ? 0 : -1);
			});

			if (matches.length > 0 && matches[0]) {
				const firstMatch = matches[0];
				rowVirtualizerRef.current?.scrollToIndex(firstMatch.rowIndex, {
					align: "center",
				});
			}
		},
		[columnIds, store]
	);

	const onSearchQueryChange = useCallback(
		(query: string) => store.setState("searchQuery", query),
		[store]
	);

	const onNavigateToPrevMatch = useCallback(() => {
		const currentState = store.getState();
		if (currentState.searchMatches.length === 0) {
			return;
		}

		const prevIndex =
			currentState.matchIndex - 1 < 0
				? currentState.searchMatches.length - 1
				: currentState.matchIndex - 1;
		const match = currentState.searchMatches[prevIndex];

		if (match) {
			rowVirtualizerRef.current?.scrollToIndex(match.rowIndex, {
				align: "center",
			});

			requestAnimationFrame(() => {
				store.setState("matchIndex", prevIndex);
				requestAnimationFrame(() => {
					focusCell(match.rowIndex, match.columnId);
				});
			});
		}
	}, [store, focusCell]);

	const onNavigateToNextMatch = useCallback(() => {
		const currentState = store.getState();
		if (currentState.searchMatches.length === 0) {
			return;
		}

		const nextIndex =
			(currentState.matchIndex + 1) % currentState.searchMatches.length;
		const match = currentState.searchMatches[nextIndex];

		if (match) {
			rowVirtualizerRef.current?.scrollToIndex(match.rowIndex, {
				align: "center",
			});

			requestAnimationFrame(() => {
				store.setState("matchIndex", nextIndex);
				requestAnimationFrame(() => {
					focusCell(match.rowIndex, match.columnId);
				});
			});
		}
	}, [store, focusCell]);

	const searchMatchSet = useMemo(() => {
		return new Set(
			searchMatches.map((m) => getCellKey(m.rowIndex, m.columnId))
		);
	}, [searchMatches]);

	const getIsSearchMatch = useCallback(
		(rowIndex: number, columnId: string) => {
			return searchMatchSet.has(getCellKey(rowIndex, columnId));
		},
		[searchMatchSet]
	);

	const getIsActiveSearchMatch = useCallback(
		(rowIndex: number, columnId: string) => {
			const currentState = store.getState();
			if (currentState.matchIndex < 0) {
				return false;
			}
			const currentMatch = currentState.searchMatches[currentState.matchIndex];
			return (
				currentMatch?.rowIndex === rowIndex &&
				currentMatch?.columnId === columnId
			);
		},
		[store]
	);

	// Compute search match data for targeted row re-renders
	const searchMatchesByRow = useMemo(() => {
		if (searchMatches.length === 0) {
			return null;
		}
		const rowMap = new Map<number, Set<string>>();
		for (const match of searchMatches) {
			let columnSet = rowMap.get(match.rowIndex);
			if (!columnSet) {
				columnSet = new Set<string>();
				rowMap.set(match.rowIndex, columnSet);
			}
			columnSet.add(match.columnId);
		}
		return rowMap;
	}, [searchMatches]);

	const activeSearchMatch = useMemo<CellPosition | null>(() => {
		if (matchIndex < 0 || searchMatches.length === 0) {
			return null;
		}
		return searchMatches[matchIndex] ?? null;
	}, [searchMatches, matchIndex]);

	const blurCell = useCallback(() => {
		const currentState = store.getState();
		if (
			currentState.editingCell &&
			document.activeElement instanceof HTMLElement
		) {
			document.activeElement.blur();
		}

		store.batch(() => {
			store.setState("focusedCell", null);
			store.setState("editingCell", null);
		});
	}, [store]);

	const scrollToCell = useCallback(
		(rowIndex: number, columnId: string) => {
			requestAnimationFrame(() => {
				const container = dataGridRef.current;
				const cellKey = getCellKey(rowIndex, columnId);
				const targetCell = cellMapRef.current.get(cellKey);

				if (container && targetCell) {
					scrollCellIntoView({
						container,
						targetCell,
						tableRef,
						viewportOffset: VIEWPORT_OFFSET,
						isRtl: dir === "rtl",
					});
				}
			});
		},
		[dir]
	);

	const onCellClick = useCallback(
		(rowIndex: number, columnId: string, event?: MouseEvent) => {
			if (event?.button === 2) {
				return;
			}

			const currentState = store.getState();
			const currentFocused = currentState.focusedCell;

			if (event) {
				if (event.ctrlKey || event.metaKey) {
					event.preventDefault();
					const cellKey = getCellKey(rowIndex, columnId);
					const newSelectedCells = new Set(
						currentState.selectionState.selectedCells
					);

					if (newSelectedCells.has(cellKey)) {
						newSelectedCells.delete(cellKey);
					} else {
						newSelectedCells.add(cellKey);
					}

					store.setState("selectionState", {
						selectedCells: newSelectedCells,
						selectionRange: null,
						isSelecting: false,
					});
					focusCell(rowIndex, columnId);
					scrollToCell(rowIndex, columnId);
					return;
				}

				if (event.shiftKey && currentState.focusedCell) {
					event.preventDefault();
					selectRange(currentState.focusedCell, { rowIndex, columnId });
					scrollToCell(rowIndex, columnId);
					return;
				}
			}

			const hasSelectedCells =
				currentState.selectionState.selectedCells.size > 0;
			const hasSelectedRows = Object.keys(currentState.rowSelection).length > 0;

			if (hasSelectedCells && !currentState.selectionState.isSelecting) {
				const cellKey = getCellKey(rowIndex, columnId);
				const isClickingSelectedCell =
					currentState.selectionState.selectedCells.has(cellKey);

				if (isClickingSelectedCell) {
					focusCell(rowIndex, columnId);
					scrollToCell(rowIndex, columnId);
					return;
				}
				onSelectionClear();
			} else if (hasSelectedRows && columnId !== "select") {
				onSelectionClear();
			}

			if (
				currentFocused?.rowIndex === rowIndex &&
				currentFocused?.columnId === columnId
			) {
				onCellEditingStart(rowIndex, columnId);
			} else {
				focusCell(rowIndex, columnId);
				scrollToCell(rowIndex, columnId);
			}
		},
		[
			store,
			focusCell,
			scrollToCell,
			onCellEditingStart,
			selectRange,
			onSelectionClear,
		]
	);

	const onCellDoubleClick = useCallback(
		(rowIndex: number, columnId: string, event?: MouseEvent) => {
			if (event?.defaultPrevented) {
				return;
			}

			onCellEditingStart(rowIndex, columnId);
		},
		[onCellEditingStart]
	);

	const onCellMouseDown = useCallback(
		(rowIndex: number, columnId: string, event: MouseEvent) => {
			if (event.button === 2) {
				return;
			}

			event.preventDefault();

			if (!(event.ctrlKey || event.metaKey || event.shiftKey)) {
				const cellKey = getCellKey(rowIndex, columnId);
				store.batch(() => {
					store.setState("selectionState", {
						selectedCells: propsRef.current.enableSingleCellSelection
							? new Set([cellKey])
							: new Set(),
						selectionRange: {
							start: { rowIndex, columnId },
							end: { rowIndex, columnId },
						},
						isSelecting: true,
					});
					store.setState("rowSelection", {});
				});
			}
		},
		[store, propsRef]
	);

	const onCellMouseEnter = useCallback(
		(rowIndex: number, columnId: string) => {
			const currentState = store.getState();
			if (currentState.fillDrag) {
				updateFillDrag({ rowIndex, columnId });
				return;
			}
			if (
				currentState.selectionState.isSelecting &&
				currentState.selectionState.selectionRange
			) {
				const start = currentState.selectionState.selectionRange.start;
				const end = { rowIndex, columnId };

				if (
					currentState.focusedCell?.rowIndex !== start.rowIndex ||
					currentState.focusedCell?.columnId !== start.columnId
				) {
					focusCell(start.rowIndex, start.columnId);
				}

				selectRange(start, end, true);
			}
		},
		[store, selectRange, focusCell, updateFillDrag]
	);

	const onCellMouseUp = useCallback(() => {
		const currentState = store.getState();
		store.setState("selectionState", {
			...currentState.selectionState,
			isSelecting: false,
		});
	}, [store]);

	const onCellContextMenu = useCallback(
		(rowIndex: number, columnId: string, event: MouseEvent) => {
			event.preventDefault();
			event.stopPropagation();

			const currentState = store.getState();
			const cellKey = getCellKey(rowIndex, columnId);
			const isTargetCellSelected =
				currentState.selectionState.selectedCells.has(cellKey);

			if (!isTargetCellSelected) {
				store.batch(() => {
					store.setState("selectionState", {
						selectedCells: new Set([cellKey]),
						selectionRange: {
							start: { rowIndex, columnId },
							end: { rowIndex, columnId },
						},
						isSelecting: false,
					});
					store.setState("focusedCell", { rowIndex, columnId });
				});
			}

			store.setState("contextMenu", {
				open: true,
				x: event.clientX,
				y: event.clientY,
			});
		},
		[store]
	);

	const onContextMenuOpenChange = useCallback(
		(open: boolean) => {
			if (!open) {
				const currentMenu = store.getState().contextMenu;
				store.setState("contextMenu", {
					open: false,
					x: currentMenu.x,
					y: currentMenu.y,
				});
			}
		},
		[store]
	);

	return {
		...gridContext,
		activeSearchMatch,
		blurCell,
		getIsActiveSearchMatch,
		getIsSearchMatch,
		onCellClick,
		onCellContextMenu,
		onCellDoubleClick,
		onCellMouseDown,
		onCellMouseEnter,
		onCellMouseUp,
		onContextMenuOpenChange,
		onNavigateToNextMatch,
		onNavigateToPrevMatch,
		onSearch,
		onSearchQueryChange,
		searchMatchesByRow,
	};
}

type DataGridPointerContext<TData> = ReturnType<
	typeof useDataGridPointer<TData>
>;

export { type DataGridPointerContext, useDataGridPointer };
