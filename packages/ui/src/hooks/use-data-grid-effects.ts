import type { DataGridKeyboardContext } from "@ryu/ui/hooks/use-data-grid-keyboard.ts";
import {
	isGridEventInside,
	SEARCH_SHORTCUT_KEY,
} from "@ryu/ui/hooks/use-data-grid-model.ts";
import { getCellKey, getIsInPopover } from "@ryu/ui/lib/data-grid.ts";
import { useEffect } from "react";

function useDataGridEffects<TData>(
	gridContext: DataGridKeyboardContext<TData>
) {
	const {
		blurCell,
		cellMapRef,
		columns,
		data,
		dataGridRef,
		focusCell,
		focusGuardRef,
		navigableColumnIds,
		onSearchOpenChange,
		onSelectionClear,
		propsRef,
		store,
	} = gridContext;

	useEffect(() => {
		function onGlobalKeyDown(event: KeyboardEvent) {
			const dataGridElement = dataGridRef.current;
			if (!dataGridElement) {
				return;
			}

			const target = event.target;
			if (!(target instanceof HTMLElement)) {
				return;
			}

			const { key, ctrlKey, metaKey, shiftKey } = event;
			const isCommandPressed = ctrlKey || metaKey;

			if (
				propsRef.current.enableSearch &&
				isCommandPressed &&
				!shiftKey &&
				key === SEARCH_SHORTCUT_KEY
			) {
				const isInInput =
					target.tagName === "INPUT" || target.tagName === "TEXTAREA";
				const isInDataGrid = dataGridElement.contains(target);
				const isInSearchInput = target.closest('[role="search"]') !== null;

				if (isInDataGrid || isInSearchInput || !isInInput) {
					event.preventDefault();
					event.stopPropagation();

					const nextSearchOpen = !store.getState().searchOpen;
					onSearchOpenChange(nextSearchOpen);

					if (nextSearchOpen && !isInDataGrid && !isInSearchInput) {
						requestAnimationFrame(() => {
							dataGridElement.focus();
						});
					}
					return;
				}
			}

			const isInDataGrid = dataGridElement.contains(target);
			if (!isInDataGrid) {
				return;
			}

			if (key === "Escape") {
				const currentState = store.getState();
				const hasSelections =
					currentState.selectionState.selectedCells.size > 0 ||
					Object.keys(currentState.rowSelection).length > 0;

				if (hasSelections) {
					event.preventDefault();
					event.stopPropagation();
					onSelectionClear();
				}
			}
		}

		window.addEventListener("keydown", onGlobalKeyDown, true);
		return () => {
			window.removeEventListener("keydown", onGlobalKeyDown, true);
		};
	}, [propsRef, onSearchOpenChange, store, onSelectionClear]);

	useEffect(() => {
		const currentState = store.getState();
		const autoFocus = propsRef.current.autoFocus;

		if (
			autoFocus &&
			data.length > 0 &&
			columns.length > 0 &&
			!currentState.focusedCell &&
			navigableColumnIds.length > 0
		) {
			const rafId = requestAnimationFrame(() => {
				if (autoFocus !== true) {
					const { rowIndex, columnId } = autoFocus;
					if (columnId) {
						focusCell(rowIndex ?? 0, columnId);
					}
					return;
				}

				const firstColumnId = navigableColumnIds[0];
				if (firstColumnId) {
					focusCell(0, firstColumnId);
				}
			});
			return () => cancelAnimationFrame(rafId);
		}
	}, [store, propsRef, data, columns, navigableColumnIds, focusCell]);

	// Restore focus to container when virtualized cells are unmounted
	useEffect(() => {
		const container = dataGridRef.current;
		if (!container) {
			return;
		}

		function onFocusOut(event: FocusEvent) {
			if (focusGuardRef.current) {
				return;
			}

			const currentContainer = dataGridRef.current;
			if (!currentContainer) {
				return;
			}

			const currentState = store.getState();

			if (!currentState.focusedCell || currentState.editingCell) {
				return;
			}

			const relatedTarget = event.relatedTarget;

			const isFocusMovingOutsideGrid = !(
				relatedTarget && isGridEventInside(currentContainer, relatedTarget)
			);

			const isFocusMovingToPopover = getIsInPopover(relatedTarget);

			if (isFocusMovingOutsideGrid && !isFocusMovingToPopover) {
				const { rowIndex, columnId } = currentState.focusedCell;
				const cellKey = getCellKey(rowIndex, columnId);
				const cellElement = cellMapRef.current.get(cellKey);

				requestAnimationFrame(() => {
					if (focusGuardRef.current) {
						return;
					}

					if (cellElement && document.body.contains(cellElement)) {
						cellElement.focus();
					} else {
						currentContainer.focus();
					}
				});
			}
		}

		container.addEventListener("focusout", onFocusOut);

		return () => {
			container.removeEventListener("focusout", onFocusOut);
		};
	}, [store]);

	useEffect(() => {
		function onOutsideClick(event: globalThis.MouseEvent) {
			if (event.button === 2) {
				return;
			}

			if (
				dataGridRef.current &&
				!isGridEventInside(dataGridRef.current, event.target)
			) {
				const elements = document.elementsFromPoint(
					event.clientX,
					event.clientY
				);

				// Compensate for event.target bubbling up
				const isInsidePopover = elements.some((element) =>
					getIsInPopover(element)
				);

				if (!isInsidePopover) {
					blurCell();
					const currentState = store.getState();
					if (
						currentState.selectionState.selectedCells.size > 0 ||
						Object.keys(currentState.rowSelection).length > 0
					) {
						onSelectionClear();
					}
				}
			}
		}

		document.addEventListener("mousedown", onOutsideClick);
		return () => {
			document.removeEventListener("mousedown", onOutsideClick);
		};
	}, [store, blurCell, onSelectionClear]);

	useEffect(() => {
		function onSelectStart(event: Event) {
			event.preventDefault();
		}

		function onContextMenu(event: Event) {
			event.preventDefault();
		}

		function onCleanup() {
			document.removeEventListener("selectstart", onSelectStart);
			document.removeEventListener("contextmenu", onContextMenu);
			document.body.style.userSelect = "";
		}

		const onUnsubscribe = store.subscribe(() => {
			const currentState = store.getState();
			if (currentState.selectionState.isSelecting) {
				document.addEventListener("selectstart", onSelectStart);
				document.addEventListener("contextmenu", onContextMenu);
				document.body.style.userSelect = "none";
			} else {
				onCleanup();
			}
		});

		return () => {
			onCleanup();
			onUnsubscribe();
		};
	}, [store]);

	return { ...gridContext };
}

type DataGridEffectsContext<TData> = ReturnType<
	typeof useDataGridEffects<TData>
>;

export { type DataGridEffectsContext, useDataGridEffects };
