"use client";

import { useDraggable, useDropLine } from "@platejs/dnd";
import { resizeLengthClampStatic } from "@platejs/resizable";
import {
	BlockSelectionPlugin,
	useBlockSelected,
} from "@platejs/selection/react";
import {
	getTableColumnCount,
	setCellBackground,
	setTableColSize,
	setTableMarginLeft,
	setTableRowSize,
} from "@platejs/table";
import {
	roundCellSizeToStep,
	TablePlugin,
	TableProvider,
	useCellIndices,
	useOverrideColSize,
	useOverrideMarginLeft,
	useOverrideRowSize,
	useTableBordersDropdownMenuContentState,
	useTableCellBorders,
	useTableColSizes,
	useTableElement,
	useTableMergeState,
	useTableSelectionDom,
	useTableValue,
} from "@platejs/table/react";
import {
	ColorPicker,
	ColorPickerContent,
	ColorPickerPanel,
} from "@ryu/ui/components/color-picker.tsx";
import { Button } from "@ryu/ui/components/editor/ui/button.tsx";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuPortal,
	DropdownMenuTrigger,
} from "@ryu/ui/components/editor/ui/dropdown-menu.tsx";
import {
	Popover,
	PopoverAnchor,
	PopoverContent,
} from "@ryu/ui/components/editor/ui/popover.tsx";
import { useDropNudge } from "@ryu/ui/hooks/use-drop-nudge.ts";
import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	ArrowDown,
	ArrowLeft,
	ArrowRight,
	ArrowUp,
	CombineIcon,
	EraserIcon,
	Grid2X2Icon,
	GripVertical,
	PaintBucketIcon,
	SquareSplitHorizontalIcon,
	Trash2Icon,
	XIcon,
} from "lucide-react";
import {
	KEYS,
	PathApi,
	type TElement,
	type TTableCellElement,
	type TTableElement,
	type TTableRowElement,
} from "platejs";
import {
	PlateElement,
	type PlateElementProps,
	useComposedRef,
	useEditorPlugin,
	useEditorRef,
	useEditorSelector,
	useElement,
	useElementSelector,
	useFocusedLast,
	usePluginOption,
	useReadOnly,
	useRemoveNodeButton,
	useSelected,
	withHOC,
} from "platejs/react";
import type { CSSProperties as ReactCSSProperties } from "react";
import {
	type ComponentProps,
	type CSSProperties,
	createContext,
	type KeyboardEvent,
	memo,
	type PointerEvent,
	type ReactNode,
	type Ref,
	type RefObject,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import editorStyles from "../editor-lint.module.css";
import { blockSelectionVariants } from "./block-selection.tsx";
import {
	BorderAllIcon,
	BorderBottomIcon,
	BorderLeftIcon,
	BorderNoneIcon,
	BorderRightIcon,
	BorderTopIcon,
} from "./table-icons.tsx";
import { Toolbar, ToolbarButton, ToolbarGroup } from "./toolbar.tsx";

interface EditorVariableStyle extends ReactCSSProperties {
	"--editortableNode1-padding-left"?: string | number;
	"--editortableNode2-max-width"?: string | number;
	"--editortableNode2-min-width"?: string | number;
	"--editortableNode2-width"?: string | number;
	"--editortableNode3-max-width"?: string | number;
	"--editortableNode3-min-width"?: string | number;
	"--editortableNode3-width"?: string | number;
}

interface TableLayoutStyle extends CSSProperties {
	"--table-width": string;
}
interface TableColumnStyle extends CSSProperties {
	[column: `--table-col-${number}`]: string;
}
interface TableRowStyle extends CSSProperties {
	"--tableRowMinHeight"?: string;
}
interface TableCellStyle extends CSSProperties {
	"--cellBackground"?: TTableCellElement["background"];
	"--cellWidth"?: string;
}
type TableResizeDirection = "bottom" | "left" | "right";

interface TableResizeStartOptions {
	colIndex: number;
	direction: TableResizeDirection;
	handleKey: string;
	rowIndex: number;
}

interface TableResizeDragState {
	colIndex: number;
	direction: TableResizeDirection;
	initialPosition: number;
	initialSize: number;
	marginLeft: number;
	rowIndex: number;
}

interface TableResizeContextValue {
	clearResizePreview: (handleKey: string) => void;
	colSizes: number[];
	disableMarginLeft: boolean;
	marginLeft: number;
	minColumnWidth: number;
	resizeBy: (options: TableResizeStartOptions, delta: number) => void;
	setResizePreview: (
		event: PointerEvent<HTMLDivElement>,
		options: TableResizeStartOptions
	) => void;
	startResize: (
		event: PointerEvent<HTMLDivElement>,
		options: TableResizeStartOptions
	) => void;
}

const TABLE_CONTROL_COLUMN_WIDTH = 8;
const TABLE_DEFAULT_COLUMN_WIDTH = 120;
const TABLE_DEFERRED_COLUMN_RESIZE_CELL_COUNT = 1200;
const TABLE_KEYBOARD_RESIZE_STEP = 8;
const TABLE_KEYBOARD_RESIZE_LARGE_STEP = 40;
const TABLE_MULTI_SELECTION_TOOLBAR_DELAY_MS = 150;

const TableResizeContext = createContext<TableResizeContextValue | null>(null);

function useTableResizeContext() {
	const context = useContext(TableResizeContext);

	if (!context) {
		throw new Error("TableResizeContext is missing");
	}

	return context;
}

function useTableResizeController({
	deferColumnResize,
	dragIndicatorRef,
	hoverIndicatorRef,
	marginLeft,
	controlColumnWidth,
	tablePath,
	tableRef,
	wrapperRef,
}: {
	deferColumnResize: boolean;
	dragIndicatorRef: RefObject<HTMLDivElement | null>;
	hoverIndicatorRef: RefObject<HTMLDivElement | null>;
	marginLeft: number;
	controlColumnWidth: number;
	tablePath: number[];
	tableRef: RefObject<HTMLTableElement | null>;
	wrapperRef: RefObject<HTMLDivElement | null>;
}) {
	const { editor, getOptions } = useEditorPlugin(TablePlugin);
	const { disableMarginLeft = false, minColumnWidth = 0 } = getOptions();
	const colSizes = useTableColSizes({
		disableOverrides: true,
	});
	const effectiveColSizes = useMemo(
		() => colSizes.map((colSize) => colSize || TABLE_DEFAULT_COLUMN_WIDTH),
		[colSizes]
	);
	const effectiveColSizesRef = useRef(effectiveColSizes);
	const activeHandleKeyRef = useRef<string | null>(null);
	const activeRowElementRef = useRef<HTMLTableRowElement | null>(null);
	const cleanupListenersRef = useRef<(() => void) | null>(null);
	const marginLeftRef = useRef(marginLeft);
	const dragStateRef = useRef<TableResizeDragState | null>(null);
	const frozenRowIndicesRef = useRef<number[] | null>(null);
	const previewHandleKeyRef = useRef<string | null>(null);
	const overrideColSize = useOverrideColSize();
	const overrideMarginLeft = useOverrideMarginLeft();
	const overrideRowSize = useOverrideRowSize();

	useEffect(() => {
		effectiveColSizesRef.current = effectiveColSizes;
	}, [effectiveColSizes]);

	useEffect(() => {
		marginLeftRef.current = marginLeft;
	}, [marginLeft]);

	const hideDeferredResizeIndicator = useCallback(() => {
		const indicator = dragIndicatorRef.current;

		if (!indicator) {
			return;
		}

		indicator.style.display = "none";
		indicator.style.removeProperty("left");
	}, [dragIndicatorRef]);

	const showDeferredResizeIndicator = useCallback(
		(offset: number) => {
			const indicator = dragIndicatorRef.current;

			if (!indicator) {
				return;
			}

			indicator.style.display = "block";
			indicator.style.left = `${offset}px`;
		},
		[dragIndicatorRef]
	);

	const hideResizeIndicator = useCallback(() => {
		const indicator = hoverIndicatorRef.current;

		if (!indicator) {
			return;
		}

		indicator.style.display = "none";
		indicator.style.removeProperty("left");
	}, [hoverIndicatorRef]);

	const clearFrozenRowHeights = useCallback(() => {
		const frozenRowIndices = frozenRowIndicesRef.current;

		if (!frozenRowIndices) {
			return;
		}

		frozenRowIndicesRef.current = null;

		frozenRowIndices.forEach((rowIndex) => {
			overrideRowSize(rowIndex, null);
		});
	}, [overrideRowSize]);

	const freezeRowHeights = useCallback(() => {
		const table = tableRef.current;

		if (!table || deferColumnResize) {
			return;
		}

		clearFrozenRowHeights();

		const frozenRowIndices: number[] = [];

		Array.from(table.rows).forEach((row, rowIndex) => {
			const height = row.getBoundingClientRect().height;

			if (!height) {
				return;
			}

			overrideRowSize(rowIndex, height);
			frozenRowIndices.push(rowIndex);
		});

		frozenRowIndicesRef.current = frozenRowIndices;
	}, [clearFrozenRowHeights, deferColumnResize, overrideRowSize, tableRef]);

	const showResizeIndicatorAtOffset = useCallback(
		(offset: number) => {
			const indicator = hoverIndicatorRef.current;

			if (!indicator) {
				return;
			}

			indicator.style.display = "block";
			indicator.style.left = `${offset}px`;
		},
		[hoverIndicatorRef]
	);

	const showResizeIndicator = useCallback(
		({
			event,
			direction,
		}: Pick<TableResizeStartOptions, "direction"> & {
			event: PointerEvent<HTMLDivElement>;
		}) => {
			if (direction === "bottom") {
				return;
			}

			const wrapper = wrapperRef.current;

			if (!wrapper) {
				return;
			}

			const handleRect = event.currentTarget.getBoundingClientRect();
			const wrapperRect = wrapper.getBoundingClientRect();
			const boundaryOffset =
				handleRect.left - wrapperRect.left + handleRect.width / 2;

			showResizeIndicatorAtOffset(boundaryOffset);
		},
		[showResizeIndicatorAtOffset, wrapperRef]
	);

	const setResizePreview = useCallback(
		(event: PointerEvent<HTMLDivElement>, options: TableResizeStartOptions) => {
			if (activeHandleKeyRef.current) {
				return;
			}

			previewHandleKeyRef.current = options.handleKey;
			showResizeIndicator({ ...options, event });
		},
		[showResizeIndicator]
	);

	const clearResizePreview = useCallback(
		(handleKey: string) => {
			if (activeHandleKeyRef.current) {
				return;
			}
			if (previewHandleKeyRef.current !== handleKey) {
				return;
			}

			previewHandleKeyRef.current = null;
			hideResizeIndicator();
		},
		[hideResizeIndicator]
	);

	const commitColSize = useCallback(
		(colIndex: number, width: number) => {
			setTableColSize(editor, { colIndex, width }, { at: tablePath });
			setTimeout(() => overrideColSize(colIndex, null), 0);
		},
		[editor, overrideColSize, tablePath]
	);

	const commitRowSize = useCallback(
		(rowIndex: number, height: number) => {
			setTableRowSize(editor, { height, rowIndex }, { at: tablePath });
			setTimeout(() => overrideRowSize(rowIndex, null), 0);
		},
		[editor, overrideRowSize, tablePath]
	);

	const commitMarginLeft = useCallback(
		(nextMarginLeft: number) => {
			setTableMarginLeft(
				editor,
				{ marginLeft: nextMarginLeft },
				{ at: tablePath }
			);
			setTimeout(() => overrideMarginLeft(null), 0);
		},
		[editor, overrideMarginLeft, tablePath]
	);

	const getColumnBoundaryOffset = useCallback(
		(colIndex: number, currentWidth: number) =>
			controlColumnWidth +
			effectiveColSizesRef.current
				.slice(0, colIndex)
				.reduce((total, colSize) => total + colSize, 0) +
			currentWidth,
		[controlColumnWidth]
	);

	const applyResize = useCallback(
		(
			event: Pick<globalThis.PointerEvent, "clientX" | "clientY">,
			finished: boolean
		) => {
			const dragState = dragStateRef.current;

			if (!dragState) {
				return;
			}

			const currentPosition =
				dragState.direction === "bottom" ? event.clientY : event.clientX;
			const delta = currentPosition - dragState.initialPosition;

			if (dragState.direction === "bottom") {
				const newHeight = roundCellSizeToStep(
					dragState.initialSize + delta,
					undefined
				);

				if (finished) {
					commitRowSize(dragState.rowIndex, newHeight);
				} else {
					overrideRowSize(dragState.rowIndex, newHeight);
				}

				return;
			}

			if (dragState.direction === "left") {
				const initial =
					effectiveColSizesRef.current[dragState.colIndex] ??
					dragState.initialSize;
				const complement = (width: number) =>
					initial + dragState.marginLeft - width;
				const nextMarginLeft = roundCellSizeToStep(
					resizeLengthClampStatic(dragState.marginLeft + delta, {
						max: complement(minColumnWidth),
						min: 0,
					}),
					undefined
				);
				const nextWidth = complement(nextMarginLeft);

				if (finished) {
					commitMarginLeft(nextMarginLeft);
					commitColSize(dragState.colIndex, nextWidth);
				} else if (deferColumnResize) {
					showDeferredResizeIndicator(
						controlColumnWidth + (nextMarginLeft - dragState.marginLeft)
					);
				} else {
					showResizeIndicatorAtOffset(
						controlColumnWidth + (nextMarginLeft - dragState.marginLeft)
					);
					overrideMarginLeft(nextMarginLeft);
					overrideColSize(dragState.colIndex, nextWidth);
				}

				return;
			}

			const currentInitial =
				effectiveColSizesRef.current[dragState.colIndex] ??
				dragState.initialSize;
			const nextInitial = effectiveColSizesRef.current[dragState.colIndex + 1];
			const complement = (width: number) =>
				currentInitial + (nextInitial ?? 0) - width;
			const currentWidth = roundCellSizeToStep(
				resizeLengthClampStatic(currentInitial + delta, {
					max: nextInitial ? complement(minColumnWidth) : undefined,
					min: minColumnWidth,
				}),
				undefined
			);
			const nextWidth = nextInitial ? complement(currentWidth) : undefined;

			if (finished) {
				commitColSize(dragState.colIndex, currentWidth);

				if (nextWidth !== undefined) {
					commitColSize(dragState.colIndex + 1, nextWidth);
				}
			} else if (deferColumnResize) {
				showDeferredResizeIndicator(
					getColumnBoundaryOffset(dragState.colIndex, currentWidth)
				);
			} else {
				showResizeIndicatorAtOffset(
					getColumnBoundaryOffset(dragState.colIndex, currentWidth)
				);
				overrideColSize(dragState.colIndex, currentWidth);

				if (nextWidth !== undefined) {
					overrideColSize(dragState.colIndex + 1, nextWidth);
				}
			}
		},
		[
			commitColSize,
			commitMarginLeft,
			commitRowSize,
			controlColumnWidth,
			deferColumnResize,
			getColumnBoundaryOffset,
			showDeferredResizeIndicator,
			showResizeIndicatorAtOffset,
			minColumnWidth,
			overrideColSize,
			overrideMarginLeft,
			overrideRowSize,
		]
	);

	const stopResize = useCallback(() => {
		cleanupListenersRef.current?.();
		cleanupListenersRef.current = null;
		activeHandleKeyRef.current = null;
		previewHandleKeyRef.current = null;
		dragStateRef.current = null;

		if (activeRowElementRef.current) {
			delete activeRowElementRef.current.dataset.tableResizing;
			activeRowElementRef.current = null;
		}

		hideDeferredResizeIndicator();
		hideResizeIndicator();
		clearFrozenRowHeights();
	}, [clearFrozenRowHeights, hideDeferredResizeIndicator, hideResizeIndicator]);

	useEffect(() => stopResize, [stopResize]);

	const startResize = useCallback(
		(
			event: PointerEvent<HTMLDivElement>,
			{ colIndex, direction, handleKey, rowIndex }: TableResizeStartOptions
		) => {
			const rowHeight =
				tableRef.current?.rows.item(rowIndex)?.getBoundingClientRect().height ??
				0;

			dragStateRef.current = {
				colIndex,
				direction,
				initialPosition: direction === "bottom" ? event.clientY : event.clientX,
				initialSize:
					direction === "bottom"
						? rowHeight
						: (effectiveColSizesRef.current[colIndex] ??
							TABLE_DEFAULT_COLUMN_WIDTH),
				marginLeft: marginLeftRef.current,
				rowIndex,
			};
			activeHandleKeyRef.current = handleKey;
			previewHandleKeyRef.current = null;

			const rowElement = tableRef.current?.rows.item(rowIndex) ?? null;

			if (
				activeRowElementRef.current &&
				activeRowElementRef.current !== rowElement
			) {
				delete activeRowElementRef.current.dataset.tableResizing;
			}

			activeRowElementRef.current = rowElement;

			if (rowElement) {
				rowElement.dataset.tableResizing = "true";
			}

			cleanupListenersRef.current?.();

			if (direction !== "bottom") {
				freezeRowHeights();
			}

			const handlePointerMove = (pointerEvent: globalThis.PointerEvent) => {
				applyResize(pointerEvent, false);
			};

			const handlePointerEnd = (pointerEvent: globalThis.PointerEvent) => {
				applyResize(pointerEvent, true);
				stopResize();
			};

			window.addEventListener("pointermove", handlePointerMove);
			window.addEventListener("pointerup", handlePointerEnd);
			window.addEventListener("pointercancel", handlePointerEnd);

			cleanupListenersRef.current = () => {
				window.removeEventListener("pointermove", handlePointerMove);
				window.removeEventListener("pointerup", handlePointerEnd);
				window.removeEventListener("pointercancel", handlePointerEnd);
			};

			if (deferColumnResize && direction !== "bottom") {
				hideResizeIndicator();
				showDeferredResizeIndicator(
					direction === "left"
						? controlColumnWidth
						: getColumnBoundaryOffset(
								colIndex,
								effectiveColSizesRef.current[colIndex] ??
									TABLE_DEFAULT_COLUMN_WIDTH
							)
				);
			} else {
				showResizeIndicator({ direction, event });
			}

			event.preventDefault();
			event.stopPropagation();
		},
		[
			controlColumnWidth,
			deferColumnResize,
			getColumnBoundaryOffset,
			hideResizeIndicator,
			showDeferredResizeIndicator,
			showResizeIndicator,
			stopResize,
			tableRef,
			applyResize,
			freezeRowHeights,
		]
	);

	// Keyboard alternative to the drag (WCAG 2.1.1 / 2.5.7): runs the same
	// resize math as a pointer drag of `delta` pixels and commits immediately.
	const resizeBy = useCallback(
		(
			{ colIndex, direction, rowIndex }: TableResizeStartOptions,
			delta: number
		) => {
			if (dragStateRef.current) {
				return;
			}

			const rowHeight =
				tableRef.current?.rows.item(rowIndex)?.getBoundingClientRect().height ??
				0;

			dragStateRef.current = {
				colIndex,
				direction,
				initialPosition: 0,
				initialSize:
					direction === "bottom"
						? rowHeight
						: (effectiveColSizesRef.current[colIndex] ??
							TABLE_DEFAULT_COLUMN_WIDTH),
				marginLeft: marginLeftRef.current,
				rowIndex,
			};
			applyResize({ clientX: delta, clientY: delta }, true);
			dragStateRef.current = null;
		},
		[applyResize, tableRef]
	);

	return useMemo(
		() => ({
			clearResizePreview,
			colSizes: effectiveColSizes,
			disableMarginLeft,
			marginLeft,
			minColumnWidth,
			resizeBy,
			setResizePreview,
			startResize,
		}),
		[
			clearResizePreview,
			disableMarginLeft,
			effectiveColSizes,
			marginLeft,
			minColumnWidth,
			resizeBy,
			setResizePreview,
			startResize,
		]
	);
}

function getKeyboardResizeDelta(
	event: KeyboardEvent<HTMLDivElement>,
	direction: TableResizeDirection
): number | null {
	const step = event.shiftKey
		? TABLE_KEYBOARD_RESIZE_LARGE_STEP
		: TABLE_KEYBOARD_RESIZE_STEP;
	const decreaseKey = direction === "bottom" ? "ArrowUp" : "ArrowLeft";
	const increaseKey = direction === "bottom" ? "ArrowDown" : "ArrowRight";

	if (event.key === decreaseKey) {
		return -step;
	}

	if (event.key === increaseKey) {
		return step;
	}

	return null;
}

export const TableElement = withHOC(
	TableProvider,
	function TableElement({
		children,
		...props
	}: PlateElementProps<TTableElement>) {
		const readOnly = useReadOnly();
		const isSelectionAreaVisible = usePluginOption(
			BlockSelectionPlugin,
			"isSelectionAreaVisible"
		);
		const hasControls = !(readOnly || isSelectionAreaVisible);
		const { marginLeft, props: tableProps } = useTableElement();
		const colSizes = useTableColSizes();
		const controlColumnWidth = hasControls ? TABLE_CONTROL_COLUMN_WIDTH : 0;
		const dragIndicatorRef = useRef<HTMLDivElement>(null);
		const hoverIndicatorRef = useRef<HTMLDivElement>(null);
		const deferColumnResize =
			colSizes.length * props.element.children.length >
			TABLE_DEFERRED_COLUMN_RESIZE_CELL_COUNT;
		const tablePath = useElementSelector(([, path]) => path, [], {
			key: KEYS.table,
		});
		const tableRef = useRef<HTMLTableElement>(null);
		const wrapperRef = useRef<HTMLDivElement>(null);
		useTableSelectionDom(tableRef);
		const resizeController = useTableResizeController({
			controlColumnWidth,
			deferColumnResize,
			dragIndicatorRef,
			hoverIndicatorRef,
			marginLeft,
			tablePath,
			tableRef,
			wrapperRef,
		});
		const resolvedColSizes = useMemo(() => {
			if (colSizes.length > 0) {
				return colSizes.map((colSize) => colSize || TABLE_DEFAULT_COLUMN_WIDTH);
			}

			return Array.from(
				{ length: getTableColumnCount(props.element) },
				() => TABLE_DEFAULT_COLUMN_WIDTH
			);
		}, [colSizes, props.element]);
		const tableVariableStyle: TableColumnStyle = {};
		resolvedColSizes.forEach((colSize, index) => {
			tableVariableStyle[`--table-col-${index}`] = `${colSize}px`;
		});
		const tableStyle: TableLayoutStyle = {
			"--table-width": `${resolvedColSizes.reduce((total, colSize) => total + colSize, 0) + controlColumnWidth}px`,
		};

		// SAFETY: Native useBlockSelected forwards this id to isSelected, which
		// uses truthiness and Set.has on the original identity, not string APIs.
		const isSelectingTable = useBlockSelected(props.element.id as string);

		const editortableNode1Style: EditorVariableStyle = {
			"--editortableNode1-padding-left": isNativeNumber(marginLeft)
				? `${marginLeft}px`
				: marginLeft,
		};
		const editortableNode2Style: EditorVariableStyle = {
			"--editortableNode2-max-width": isNativeNumber(TABLE_CONTROL_COLUMN_WIDTH)
				? `${TABLE_CONTROL_COLUMN_WIDTH}px`
				: TABLE_CONTROL_COLUMN_WIDTH,
			"--editortableNode2-min-width": isNativeNumber(TABLE_CONTROL_COLUMN_WIDTH)
				? `${TABLE_CONTROL_COLUMN_WIDTH}px`
				: TABLE_CONTROL_COLUMN_WIDTH,
			"--editortableNode2-width": isNativeNumber(TABLE_CONTROL_COLUMN_WIDTH)
				? `${TABLE_CONTROL_COLUMN_WIDTH}px`
				: TABLE_CONTROL_COLUMN_WIDTH,
		};
		const content = (
			<PlateElement
				{...props}
				className={cn(
					cn(
						"overflow-x-auto py-5",
						hasControls && "-ms-2 *:data-[slot=block-selection]:start-2"
					),
					editorStyles.editortableNode1
				)}
				style={editortableNode1Style}
			>
				<TableResizeContext.Provider value={resizeController}>
					<div
						className="group/table relative w-fit"
						ref={(element) => {
							wrapperRef.current = element;
							if (!element) {
								return;
							}
							for (const [property, value] of Object.entries(
								tableVariableStyle
							)) {
								element.style.setProperty(property, value);
							}
							return () => {
								for (const property of Object.keys(tableVariableStyle)) {
									element.style.removeProperty(property);
								}
							};
						}}
					>
						<div
							className="pointer-events-none absolute inset-y-0 z-36 hidden w-[3px] -translate-x-[1.5px] bg-ring/70 rtl:translate-x-[1.5px]"
							contentEditable={false}
							ref={dragIndicatorRef}
						/>
						<div
							className="pointer-events-none absolute inset-y-0 z-35 hidden w-[3px] -translate-x-[1.5px] bg-ring/80 rtl:translate-x-[1.5px]"
							contentEditable={false}
							ref={hoverIndicatorRef}
						/>
						<table
							className={cn(
								"ms-px me-0 table h-px w-(--table-width) table-fixed border-collapse",
								"data-[table-selecting=true]:[&_*::selection]:!bg-transparent",
								"data-[table-selecting=true]:[&_*::selection]:!text-inherit",
								"data-[table-selecting=true]:[&_*::-moz-selection]:!bg-transparent",
								"data-[table-selecting=true]:[&_*::-moz-selection]:!text-inherit",
								"data-[table-selecting=true]:[&_*]:!caret-transparent"
							)}
							ref={tableRef}
							style={tableStyle}
							{...tableProps}
						>
							{resolvedColSizes.length > 0 && (
								<colgroup>
									{hasControls && (
										<col
											className={editorStyles.editortableNode2}
											style={editortableNode2Style}
										/>
									)}
									{resolvedColSizes.map((colSize, index) => {
										const editortableNode3Style: EditorVariableStyle = {
											"--editortableNode3-max-width": isNativeNumber(colSize)
												? `${colSize}px`
												: colSize,
											"--editortableNode3-min-width": isNativeNumber(colSize)
												? `${colSize}px`
												: colSize,
											"--editortableNode3-width": isNativeNumber(colSize)
												? `${colSize}px`
												: colSize,
										};
										return (
											<col
												className={editorStyles.editortableNode3}
												key={index}
												style={editortableNode3Style}
											/>
										);
									})}
								</colgroup>
							)}
							<tbody className="min-w-full">{children}</tbody>
						</table>

						{isSelectingTable && (
							<div
								className={blockSelectionVariants()}
								contentEditable={false}
							/>
						)}
					</div>
				</TableResizeContext.Provider>
			</PlateElement>
		);

		if (readOnly) {
			return content;
		}

		return <TableFloatingToolbar>{content}</TableFloatingToolbar>;
	}
);

function TableFloatingToolbar({
	children,
	...props
}: ComponentProps<typeof PopoverContent>) {
	const selectedCellCount = useEditorSelector(
		(editor) =>
			editor.getApi(TablePlugin).table.getSelectedCellIds()?.length ?? 0,
		[]
	);
	const selected = useSelected();
	const collapsedInside = useEditorSelector(
		(editor) => selected && editor.api.isCollapsed(),
		[selected]
	);
	const isFocusedLast = useFocusedLast();
	const [isExpandedSelectionToolbarReady, setIsExpandedSelectionToolbarReady] =
		useState(false);
	const isCollapsedToolbarOpen = isFocusedLast && collapsedInside;
	const isExpandedSelectionPending =
		isFocusedLast && !collapsedInside && selectedCellCount > 1;

	useEffect(() => {
		if (!isExpandedSelectionPending) {
			// eslint-disable-next-line react-hooks/set-state-in-effect -- Reset the delayed toolbar gate when selection is no longer expanded.
			setIsExpandedSelectionToolbarReady(false);

			return;
		}

		const timeoutId = window.setTimeout(() => {
			setIsExpandedSelectionToolbarReady(true);
		}, TABLE_MULTI_SELECTION_TOOLBAR_DELAY_MS);

		return () => {
			window.clearTimeout(timeoutId);
		};
	}, [isExpandedSelectionPending]);

	const shouldRenderExpandedSelectionToolbar =
		isExpandedSelectionToolbarReady && isExpandedSelectionPending;
	const isToolbarOpen =
		isCollapsedToolbarOpen || shouldRenderExpandedSelectionToolbar;

	return (
		<Popover modal={false} open={isToolbarOpen}>
			<PopoverAnchor>{children}</PopoverAnchor>
			{isCollapsedToolbarOpen && (
				<CollapsedTableFloatingToolbarContent {...props} />
			)}
			{shouldRenderExpandedSelectionToolbar && (
				<ExpandedSelectionTableFloatingToolbarContent {...props} />
			)}
		</Popover>
	);
}

function ExpandedSelectionTableFloatingToolbarContent(
	props: ComponentProps<typeof PopoverContent>
) {
	const { tf } = useEditorPlugin(TablePlugin);
	const { canMerge, canSplit } = useTableMergeState();

	if (!(canMerge || canSplit)) {
		return null;
	}

	return (
		<TableFloatingToolbarContent
			canMerge={canMerge}
			canSplit={canSplit}
			onMerge={() => tf.table.merge()}
			onSplit={() => tf.table.split()}
			{...props}
		/>
	);
}

function CollapsedTableFloatingToolbarContent(
	props: ComponentProps<typeof PopoverContent>
) {
	const { tf } = useEditorPlugin(TablePlugin);
	const element = useElement<TTableElement>();
	const { props: buttonProps } = useRemoveNodeButton({ element });
	const { canSplit } = useTableMergeState();

	return (
		<TableFloatingToolbarContent
			buttonProps={buttonProps}
			canSplit={canSplit}
			collapsedInside
			onDeleteColumn={() => {
				tf.remove.tableColumn();
			}}
			onDeleteRow={() => {
				tf.remove.tableRow();
			}}
			onInsertColumnAfter={() => {
				tf.insert.tableColumn();
			}}
			onInsertColumnBefore={() => {
				tf.insert.tableColumn({ before: true });
			}}
			onInsertRowAfter={() => {
				tf.insert.tableRow();
			}}
			onInsertRowBefore={() => {
				tf.insert.tableRow({ before: true });
			}}
			onSplit={() => tf.table.split()}
			{...props}
		/>
	);
}

function TableFloatingToolbarContent({
	buttonProps,
	canMerge = false,
	canSplit = false,
	collapsedInside = false,
	onDeleteColumn,
	onDeleteRow,
	onInsertColumnAfter,
	onInsertColumnBefore,
	onInsertRowAfter,
	onInsertRowBefore,
	onMerge,
	onSplit,
	...props
}: ComponentProps<typeof PopoverContent> & {
	buttonProps?: ComponentProps<typeof ToolbarButton>;
	canMerge?: boolean;
	canSplit?: boolean;
	collapsedInside?: boolean;
	onDeleteColumn?: () => void;
	onDeleteRow?: () => void;
	onInsertColumnAfter?: () => void;
	onInsertColumnBefore?: () => void;
	onInsertRowAfter?: () => void;
	onInsertRowBefore?: () => void;
	onMerge?: () => void;
	onSplit?: () => void;
}) {
	return (
		<PopoverContent
			contentEditable={false}
			onOpenAutoFocus={(e) => e.preventDefault()}
			{...props}
			render={
				<Toolbar
					className="scrollbar-hide flex w-auto max-w-[80vw] flex-row overflow-x-auto rounded-md border bg-popover p-1 shadow-md print:hidden"
					contentEditable={false}
				/>
			}
		>
			<ToolbarGroup>
				<ColorDropdownMenu tooltip="Background color">
					<PaintBucketIcon />
				</ColorDropdownMenu>
				{canMerge && onMerge && (
					<ToolbarButton
						onClick={onMerge}
						onMouseDown={(e) => e.preventDefault()}
						tooltip="Merge cells"
					>
						<CombineIcon />
					</ToolbarButton>
				)}
				{canSplit && onSplit && (
					<ToolbarButton
						onClick={onSplit}
						onMouseDown={(e) => e.preventDefault()}
						tooltip="Split cell"
					>
						<SquareSplitHorizontalIcon />
					</ToolbarButton>
				)}

				<DropdownMenu modal={false}>
					<DropdownMenuTrigger
						render={<ToolbarButton tooltip="Cell borders" />}
					>
						<Grid2X2Icon />
					</DropdownMenuTrigger>

					<DropdownMenuPortal>
						<TableBordersDropdownMenuContent />
					</DropdownMenuPortal>
				</DropdownMenu>

				{collapsedInside && (
					<ToolbarGroup>
						<ToolbarButton tooltip="Delete table" {...buttonProps}>
							<Trash2Icon />
						</ToolbarButton>
					</ToolbarGroup>
				)}
			</ToolbarGroup>
			{collapsedInside && (
				<ToolbarGroup>
					<ToolbarButton
						onClick={onInsertRowBefore}
						onMouseDown={(e) => e.preventDefault()}
						tooltip="Insert row before"
					>
						<ArrowUp />
					</ToolbarButton>
					<ToolbarButton
						onClick={onInsertRowAfter}
						onMouseDown={(e) => e.preventDefault()}
						tooltip="Insert row after"
					>
						<ArrowDown />
					</ToolbarButton>
					<ToolbarButton
						onClick={onDeleteRow}
						onMouseDown={(e) => e.preventDefault()}
						tooltip="Delete row"
					>
						<XIcon />
					</ToolbarButton>
				</ToolbarGroup>
			)}
			{collapsedInside && (
				<ToolbarGroup>
					<ToolbarButton
						onClick={onInsertColumnBefore}
						onMouseDown={(e) => e.preventDefault()}
						tooltip="Insert column before"
					>
						<ArrowLeft />
					</ToolbarButton>
					<ToolbarButton
						onClick={onInsertColumnAfter}
						onMouseDown={(e) => e.preventDefault()}
						tooltip="Insert column after"
					>
						<ArrowRight />
					</ToolbarButton>
					<ToolbarButton
						onClick={onDeleteColumn}
						onMouseDown={(e) => e.preventDefault()}
						tooltip="Delete column"
					>
						<XIcon />
					</ToolbarButton>
				</ToolbarGroup>
			)}
		</PopoverContent>
	);
}

function TableBordersDropdownMenuContent(
	props: ComponentProps<typeof DropdownMenuContent>
) {
	const editor = useEditorRef();
	const {
		getOnSelectTableBorder,
		hasBottomBorder,
		hasLeftBorder,
		hasNoBorders,
		hasOuterBorders,
		hasRightBorder,
		hasTopBorder,
	} = useTableBordersDropdownMenuContentState();

	return (
		<DropdownMenuContent
			align="start"
			className="min-w-[220px]"
			onCloseAutoFocus={(e) => {
				e.preventDefault();
				editor.tf.focus();
			}}
			side="right"
			sideOffset={0}
			{...props}
		>
			<DropdownMenuGroup>
				<DropdownMenuCheckboxItem
					checked={hasTopBorder}
					onCheckedChange={getOnSelectTableBorder("top")}
				>
					<BorderTopIcon />
					<div>Top Border</div>
				</DropdownMenuCheckboxItem>
				<DropdownMenuCheckboxItem
					checked={hasRightBorder}
					onCheckedChange={getOnSelectTableBorder("right")}
				>
					<BorderRightIcon />
					<div>Right Border</div>
				</DropdownMenuCheckboxItem>
				<DropdownMenuCheckboxItem
					checked={hasBottomBorder}
					onCheckedChange={getOnSelectTableBorder("bottom")}
				>
					<BorderBottomIcon />
					<div>Bottom Border</div>
				</DropdownMenuCheckboxItem>
				<DropdownMenuCheckboxItem
					checked={hasLeftBorder}
					onCheckedChange={getOnSelectTableBorder("left")}
				>
					<BorderLeftIcon />
					<div>Left Border</div>
				</DropdownMenuCheckboxItem>
			</DropdownMenuGroup>

			<DropdownMenuGroup>
				<DropdownMenuCheckboxItem
					checked={hasNoBorders}
					onCheckedChange={getOnSelectTableBorder("none")}
				>
					<BorderNoneIcon />
					<div>No Border</div>
				</DropdownMenuCheckboxItem>
				<DropdownMenuCheckboxItem
					checked={hasOuterBorders}
					onCheckedChange={getOnSelectTableBorder("outer")}
				>
					<BorderAllIcon />
					<div>Outside Borders</div>
				</DropdownMenuCheckboxItem>
			</DropdownMenuGroup>
		</DropdownMenuContent>
	);
}

function ColorDropdownMenu({
	children,
	tooltip,
}: {
	children: ReactNode;
	tooltip: string;
}) {
	const [open, setOpen] = useState(false);

	const editor = useEditorRef();

	const onUpdateColor = useCallback(
		(color: string) => {
			setCellBackground(editor, {
				color,
				selectedCells:
					editor.getApi(TablePlugin).table.getSelectedCells() ?? [],
			});
		},
		[editor]
	);

	const onClearColor = useCallback(() => {
		setOpen(false);
		setCellBackground(editor, {
			color: null,
			selectedCells: editor.getApi(TablePlugin).table.getSelectedCells() ?? [],
		});
	}, [editor]);

	return (
		<DropdownMenu modal={false} onOpenChange={setOpen} open={open}>
			<DropdownMenuTrigger render={<ToolbarButton tooltip={tooltip} />}>
				{children}
			</DropdownMenuTrigger>

			<DropdownMenuContent align="start">
				<ColorPicker
					defaultValue="#000000"
					inline
					onValueChange={onUpdateColor}
					swatches={["#000000", "#ffffff", "#ff3b30", "#f0f0f0"]}
				>
					<ColorPickerContent className="w-[340px] border-0 bg-transparent p-0 shadow-none">
						<ColorPickerPanel />
					</ColorPickerContent>
				</ColorPicker>
				<DropdownMenuGroup>
					<DropdownMenuItem className="p-2" onClick={onClearColor}>
						<EraserIcon />
						<span>Clear</span>
					</DropdownMenuItem>
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

export function TableRowElement({
	children,
	...props
}: PlateElementProps<TTableRowElement>) {
	const { element } = props;
	const readOnly = useReadOnly();
	const editor = useEditorRef();
	const rowIndex = useElementSelector(([, path]) => path.at(-1) ?? 0, [], {
		key: KEYS.tr,
	});
	const rowSize = useElementSelector(([node]) => node.size, [], {
		key: KEYS.tr,
	});
	const rowSizeOverrides = useTableValue("rowSizeOverrides");
	const rowMinHeight = rowSizeOverrides.get?.(rowIndex) ?? rowSize;
	const isSelectionAreaVisible = usePluginOption(
		BlockSelectionPlugin,
		"isSelectionAreaVisible"
	);
	const hasControls = !(readOnly || isSelectionAreaVisible);

	const { isDragging, nodeRef, previewRef, handleRef } = useDraggable({
		element,
		type: element.type,
		canDropNode: ({ dragEntry, dropEntry }) =>
			PathApi.equals(
				PathApi.parent(dragEntry[1]),
				PathApi.parent(dropEntry[1])
			),
		onDropHandler: (_, { dragItem }) => {
			// SAFETY: This row uses native useDraggable without a custom drag item. Its installed producer captures element from editor.api.node, and useDropNode routes file items away before this handler. The existing element guard is retained; this local producer bridge does not validate forged foreign drag payloads.
			const dragElement = (dragItem as { element: TElement }).element;

			if (dragElement) {
				editor.tf.select(dragElement);
			}
		},
	});

	const rowStyle: TableRowStyle = {
		...props.style,
		"--tableRowMinHeight": rowMinHeight ? `${rowMinHeight}px` : undefined,
	};
	return (
		<PlateElement
			{...props}
			as="tr"
			className={cn("group/row", isDragging && "opacity-50")}
			ref={useComposedRef(props.ref, previewRef, nodeRef)}
			style={rowStyle}
		>
			{hasControls && (
				<td
					className="w-2 min-w-2 max-w-2 select-none p-0"
					contentEditable={false}
				>
					<RowDragHandle dragRef={handleRef} />
					<RowDropGap rowRef={nodeRef} />
				</td>
			)}

			{children}
		</PlateElement>
	);
}

function useTableCellPresentation(element: TTableCellElement) {
	const { api } = useEditorPlugin(TablePlugin);
	const borders = useTableCellBorders({ element });
	const { col, row } = useCellIndices();

	const colSpan = api.table.getColSpan(element);
	const rowSpan = api.table.getRowSpan(element);
	const width = useMemo(() => {
		const terms = Array.from(
			{ length: colSpan },
			(_, offset) => `var(--table-col-${col + offset}, 120px)`
		);

		return terms.length === 1 ? terms[0]! : `calc(${terms.join(" + ")})`;
	}, [col, colSpan]);

	return {
		borders,
		colIndex: col + colSpan - 1,
		colSpan,
		rowIndex: row + rowSpan - 1,
		rowSpan,
		width,
	};
}

function RowDragHandle({ dragRef }: { dragRef: Ref<any> }) {
	const editor = useEditorRef();
	const element = useElement();

	return (
		<Button
			className={cn(
				"absolute start-0 top-1/2 z-51 h-6 w-4 -translate-y-1/2 p-0 focus-visible:ring-0 focus-visible:ring-offset-0",
				"cursor-grab active:cursor-grabbing",
				"opacity-0 transition-opacity duration-100 group-hover/row:opacity-100 group-data-[table-resizing=true]/row:opacity-0"
			)}
			onClick={() => {
				editor.tf.select(element);
			}}
			ref={dragRef}
			variant="outline"
		>
			<GripVertical className="text-muted-foreground" />
		</Button>
	);
}

/** Eases this row and its neighbour apart where a dragged row would drop, in
 *  place of a drawn drop line. */
function RowDropGap({ rowRef }: { rowRef: RefObject<HTMLElement | null> }) {
	const { dropLine } = useDropLine();
	useDropNudge(rowRef, dropLine);
	return null;
}

export function TableCellElement({
	isHeader,
	...props
}: PlateElementProps<TTableCellElement> & {
	isHeader?: boolean;
}) {
	const readOnly = useReadOnly();
	const element = props.element;

	// SAFETY: This selector forwards the raw table identity only to native
	// useBlockSelected/isSelected (truthiness and Set.has); it proves no string.
	const tableId = useElementSelector(([node]) => node.id as string, [], {
		key: KEYS.table,
	});
	// SAFETY: The raw row identity is consumed by the same native Set.has
	// selection path below. The narrower annotation does not validate its kind.
	const rowId = useElementSelector(([node]) => node.id as string, [], {
		key: KEYS.tr,
	});
	const isSelectingTable = useBlockSelected(tableId);
	const isSelectingRow = useBlockSelected(rowId) || isSelectingTable;
	const isSelectionAreaVisible = usePluginOption(
		BlockSelectionPlugin,
		"isSelectionAreaVisible"
	);

	const { borders, colIndex, colSpan, rowIndex, rowSpan, width } =
		useTableCellPresentation(element);

	const cellStyle: TableCellStyle = {
		"--cellBackground": element.background,
		"--cellWidth": `${width}px`,
	};
	return (
		<PlateElement
			{...props}
			as={isHeader ? "th" : "td"}
			attributes={{
				...props.attributes,
				colSpan,
				"data-table-cell-id": element.id,
				rowSpan,
			}}
			className={cn(
				"relative h-full min-w-(--cellWidth) max-w-(--cellWidth) overflow-visible border-none bg-background p-0",
				element.background ? "bg-(--cellBackground)" : "bg-background",
				isHeader && "text-start *:m-0",
				"before:size-full",
				"data-[table-cell-selected=true]:before:z-10",
				"data-[table-cell-selected=true]:before:bg-primary/5",
				"before:absolute before:box-border before:select-none before:content-['']",
				borders.bottom?.size && "before:border-b before:border-b-border",
				borders.right?.size && "before:border-e before:border-e-border",
				borders.left?.size && "before:border-s before:border-s-border",
				borders.top?.size && "before:border-t before:border-t-border"
			)}
			style={cellStyle}
		>
			<div
				className={cn(
					"relative z-20 box-border h-full px-3 py-2",
					rowSpan === 1 && "min-h-(--tableRowMinHeight,0px)"
				)}
			>
				{props.children}
			</div>

			{!(readOnly || isSelectionAreaVisible) && (
				<TableCellResizeControls colIndex={colIndex} rowIndex={rowIndex} />
			)}

			{isSelectingRow && (
				<div className={blockSelectionVariants()} contentEditable={false} />
			)}
		</PlateElement>
	);
}

export function TableCellHeaderElement(
	props: ComponentProps<typeof TableCellElement>
) {
	return <TableCellElement {...props} isHeader />;
}

const TableCellResizeControls = memo(function TableCellResizeControls({
	colIndex,
	rowIndex,
}: {
	colIndex: number;
	rowIndex: number;
}) {
	const {
		clearResizePreview,
		colSizes,
		disableMarginLeft,
		marginLeft,
		minColumnWidth,
		resizeBy,
		setResizePreview,
		startResize,
	} = useTableResizeContext();
	const rightHandleKey = `right:${rowIndex}:${colIndex}`;
	const bottomHandleKey = `bottom:${rowIndex}:${colIndex}`;
	const leftHandleKey = `left:${rowIndex}:${colIndex}`;
	const isLeftHandle = colIndex === 0 && !disableMarginLeft;
	// Every cell carries pointer handles, but only one per boundary joins the
	// tab order: column handles on the first row, row handles in the first
	// column. The rest stay pointer-only duplicates hidden from assistive tech.
	const isColumnHandleFocusable = rowIndex === 0;
	const isRowHandleFocusable = colIndex === 0;
	const columnWidth = colSizes[colIndex] ?? TABLE_DEFAULT_COLUMN_WIDTH;
	const handleResizeKeyDown = (
		event: KeyboardEvent<HTMLDivElement>,
		direction: TableResizeDirection,
		handleKey: string
	) => {
		const delta = getKeyboardResizeDelta(event, direction);

		if (delta === null) {
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		resizeBy({ colIndex, direction, handleKey, rowIndex }, delta);
	};

	return (
		<div
			className="group/resize pointer-events-none absolute inset-0 z-30 select-none"
			contentEditable={false}
			suppressContentEditableWarning={true}
		>
			<div
				aria-hidden={isColumnHandleFocusable ? undefined : true}
				aria-label={isColumnHandleFocusable ? "Resize column" : undefined}
				aria-orientation={isColumnHandleFocusable ? "vertical" : undefined}
				aria-valuemin={isColumnHandleFocusable ? minColumnWidth : undefined}
				aria-valuenow={isColumnHandleFocusable ? columnWidth : undefined}
				className="pointer-events-auto absolute -end-1 -top-2 z-40 h-[calc(100%_+_8px)] w-2 cursor-col-resize touch-none outline-none focus-visible:bg-ring"
				onKeyDown={(event) => {
					handleResizeKeyDown(event, "right", rightHandleKey);
				}}
				onPointerDown={(event) => {
					startResize(event, {
						colIndex,
						direction: "right",
						handleKey: rightHandleKey,
						rowIndex,
					});
				}}
				onPointerEnter={(event) => {
					setResizePreview(event, {
						colIndex,
						direction: "right",
						handleKey: rightHandleKey,
						rowIndex,
					});
				}}
				onPointerLeave={() => {
					clearResizePreview(rightHandleKey);
				}}
				role={isColumnHandleFocusable ? "separator" : undefined}
				tabIndex={isColumnHandleFocusable ? 0 : undefined}
			/>
			<div
				aria-hidden={isRowHandleFocusable ? undefined : true}
				aria-label={isRowHandleFocusable ? "Resize row" : undefined}
				aria-orientation={isRowHandleFocusable ? "horizontal" : undefined}
				className="pointer-events-auto absolute start-0 -bottom-1 z-40 h-2 w-full cursor-row-resize touch-none outline-none focus-visible:bg-ring"
				onKeyDown={(event) => {
					handleResizeKeyDown(event, "bottom", bottomHandleKey);
				}}
				onPointerDown={(event) => {
					startResize(event, {
						colIndex,
						direction: "bottom",
						handleKey: bottomHandleKey,
						rowIndex,
					});
				}}
				onPointerEnter={(event) => {
					setResizePreview(event, {
						colIndex,
						direction: "bottom",
						handleKey: bottomHandleKey,
						rowIndex,
					});
				}}
				onPointerLeave={() => {
					clearResizePreview(bottomHandleKey);
				}}
				role={isRowHandleFocusable ? "separator" : undefined}
				tabIndex={isRowHandleFocusable ? 0 : undefined}
			/>
			{isLeftHandle && (
				<div
					aria-hidden={isColumnHandleFocusable ? undefined : true}
					aria-label={
						isColumnHandleFocusable ? "Resize table left margin" : undefined
					}
					aria-orientation={isColumnHandleFocusable ? "vertical" : undefined}
					aria-valuemin={isColumnHandleFocusable ? 0 : undefined}
					aria-valuenow={isColumnHandleFocusable ? marginLeft : undefined}
					className="pointer-events-auto absolute -start-1 top-0 z-40 h-full w-2 cursor-col-resize touch-none outline-none focus-visible:bg-ring"
					onKeyDown={(event) => {
						handleResizeKeyDown(event, "left", leftHandleKey);
					}}
					onPointerDown={(event) => {
						startResize(event, {
							colIndex,
							direction: "left",
							handleKey: leftHandleKey,
							rowIndex,
						});
					}}
					onPointerEnter={(event) => {
						setResizePreview(event, {
							colIndex,
							direction: "left",
							handleKey: leftHandleKey,
							rowIndex,
						});
					}}
					onPointerLeave={() => {
						clearResizePreview(leftHandleKey);
					}}
					role={isColumnHandleFocusable ? "separator" : undefined}
					tabIndex={isColumnHandleFocusable ? 0 : undefined}
				/>
			)}
		</div>
	);
});

TableCellResizeControls.displayName = "TableCellResizeControls";
