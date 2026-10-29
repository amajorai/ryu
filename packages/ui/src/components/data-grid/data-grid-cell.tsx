"use client";

import {
	CheckboxCell,
	DateCell,
	FileCell,
	FormulaCell,
	LongTextCell,
	MultiSelectCell,
	NumberCell,
	SelectCell,
	ShortTextCell,
	UrlCell,
} from "@ryu/ui/components/data-grid/data-grid-cell-variants.tsx";
import { getOptionColorClass } from "@ryu/ui/lib/data-grid.ts";
import { getCellFormatColor } from "@ryu/ui/lib/data-grid-format.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { DataGridCellProps } from "@ryu/ui/types/data-grid.ts";
import get from "lodash/get.js";
import { type ComponentType, memo } from "react";

/** Memo comparison requests a fresh render for a nullish row original.
 * This does not validate row data or change the column accessor/renderers. */
export const DataGridCell =
	// SAFETY: React memo retains this exact generic implementation and forwards the complete props packet to it for JSX rendering. Its public ComponentProps extraction erases the implementation's TData parameter; this restores that same generic JSX signature, without claiming the native memo descriptor is directly callable or narrowing any row/cell value.
	memo(DataGridCellImpl, (prev, next) => {
		// Fast path: check stable primitive props first
		if (prev.isFocused !== next.isFocused) {
			return false;
		}
		if (prev.isEditing !== next.isEditing) {
			return false;
		}
		if (prev.isSelected !== next.isSelected) {
			return false;
		}
		if (prev.isSearchMatch !== next.isSearchMatch) {
			return false;
		}
		if (prev.isActiveSearchMatch !== next.isActiveSearchMatch) {
			return false;
		}
		if (prev.readOnly !== next.readOnly) {
			return false;
		}
		if (prev.rowIndex !== next.rowIndex) {
			return false;
		}
		if (prev.columnId !== next.columnId) {
			return false;
		}
		if (prev.rowHeight !== next.rowHeight) {
			return false;
		}

		// Check cell value using row.original instead of getValue() for stability
		// getValue() is unstable and recreates on every render, breaking memoization
		const prevOriginal = prev.cell.row.original;
		if (prevOriginal == null) {
			return false;
		}
		const prevValue = get(prevOriginal, [prev.columnId]);
		const nextOriginal = next.cell.row.original;
		if (nextOriginal == null) {
			return false;
		}
		const nextValue = get(nextOriginal, [next.columnId]);
		if (prevValue !== nextValue) {
			return false;
		}

		// Check cell/row identity
		if (prev.cell.row.id !== next.cell.row.id) {
			return false;
		}

		// Column config (formula, conditional formatting) changed
		if (prev.cell.column.columnDef !== next.cell.column.columnDef) {
			return false;
		}

		return true;
	}) as typeof DataGridCellImpl;

function DataGridCellImpl<TData>({
	cell,
	tableMeta,
	rowIndex,
	columnId,
	isFocused,
	isEditing,
	isSelected,
	isSearchMatch,
	isActiveSearchMatch,
	readOnly,
	rowHeight,
}: DataGridCellProps<TData>) {
	const cellOpts = cell.column.columnDef.meta?.cell;
	const variant = cellOpts?.variant ?? "text";

	let Comp: ComponentType<DataGridCellProps<TData>>;

	switch (variant) {
		case "short-text":
			Comp = ShortTextCell;
			break;
		case "long-text":
			Comp = LongTextCell;
			break;
		case "number":
			Comp = NumberCell;
			break;
		case "url":
			Comp = UrlCell;
			break;
		case "checkbox":
			Comp = CheckboxCell;
			break;
		case "select":
			Comp = SelectCell;
			break;
		case "multi-select":
			Comp = MultiSelectCell;
			break;
		case "date":
			Comp = DateCell;
			break;
		case "file":
			Comp = FileCell;
			break;
		case "formula":
			Comp = FormulaCell;
			break;

		default:
			Comp = ShortTextCell;
			break;
	}

	const formatColor = cellOpts?.formatRules?.length
		? getCellFormatColor(cell.getValue(), cellOpts)
		: undefined;

	const content = (
		<Comp
			cell={cell}
			columnId={columnId}
			isActiveSearchMatch={isActiveSearchMatch}
			isEditing={isEditing}
			isFocused={isFocused}
			isSearchMatch={isSearchMatch}
			isSelected={isSelected}
			readOnly={readOnly}
			rowHeight={rowHeight}
			rowIndex={rowIndex}
			tableMeta={tableMeta}
		/>
	);

	if (!formatColor) {
		return content;
	}
	// Conditional formatting tints the whole cell behind the editor/value.
	return (
		<div
			className={cn("size-full", getOptionColorClass(formatColor))}
			data-format-color={formatColor}
			data-slot="grid-cell-format"
		>
			{content}
		</div>
	);
}
