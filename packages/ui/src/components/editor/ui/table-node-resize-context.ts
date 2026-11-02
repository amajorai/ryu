// Shared state for the table's column/row resize handles: the handle option
// shapes, the controller contract the cells read through context, and the
// keyboard step mapping.

import {
	createContext,
	type KeyboardEvent,
	type PointerEvent,
	useContext,
} from "react";

export type TableResizeDirection = "bottom" | "left" | "right";

export interface TableResizeStartOptions {
	colIndex: number;
	direction: TableResizeDirection;
	handleKey: string;
	rowIndex: number;
}

export interface TableResizeDragState {
	colIndex: number;
	direction: TableResizeDirection;
	initialPosition: number;
	initialSize: number;
	marginLeft: number;
	rowIndex: number;
}

export interface TableResizeContextValue {
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

export const TABLE_CONTROL_COLUMN_WIDTH = 8;
export const TABLE_DEFAULT_COLUMN_WIDTH = 120;
export const TABLE_DEFERRED_COLUMN_RESIZE_CELL_COUNT = 1200;
export const TABLE_KEYBOARD_RESIZE_STEP = 8;
export const TABLE_KEYBOARD_RESIZE_LARGE_STEP = 40;
export const TABLE_MULTI_SELECTION_TOOLBAR_DELAY_MS = 150;

export const TableResizeContext = createContext<TableResizeContextValue | null>(
	null
);

export function useTableResizeContext() {
	const context = useContext(TableResizeContext);

	if (!context) {
		throw new Error("TableResizeContext is missing");
	}

	return context;
}

export function getKeyboardResizeDelta(
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
