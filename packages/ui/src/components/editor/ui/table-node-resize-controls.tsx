"use client";

// A cell's resize handles: pointer drag on every cell, with one keyboard
// focusable separator per column/row boundary.

import { useLiteralMessages } from "@ryu/i18n/react";
import { type KeyboardEvent, memo } from "react";

import {
	getKeyboardResizeDelta,
	TABLE_DEFAULT_COLUMN_WIDTH,
	type TableResizeDirection,
	useTableResizeContext,
} from "./table-node-resize-context.ts";

export const TableCellResizeControls = memo(function TableCellResizeControls({
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
	// The handles sit inside the editable, which the DOM localizer skips.
	const tl = useLiteralMessages();
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
				aria-label={isColumnHandleFocusable ? tl("Resize column") : undefined}
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
				aria-label={isRowHandleFocusable ? tl("Resize row") : undefined}
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
						isColumnHandleFocusable ? tl("Resize table left margin") : undefined
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
