"use client";

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { useAsRef } from "@ryu/ui/hooks/use-as-ref.ts";
import { getEmptyCellValue, parseCellKey } from "@ryu/ui/lib/data-grid.ts";
import type { CellUpdate, ContextMenuState } from "@ryu/ui/types/data-grid.ts";
import type { ColumnDef, TableMeta } from "@tanstack/react-table";
import { CopyIcon, EraserIcon, ScissorsIcon, Trash2Icon } from "lucide-react";
import { type CSSProperties, memo, useCallback, useMemo } from "react";
import { toast } from "sonner";

interface DataGridContextMenuProps<TData> {
	columns: ColumnDef<TData>[];
	contextMenu: ContextMenuState;
	tableMeta: TableMeta<TData>;
}

export function DataGridContextMenu<TData>({
	tableMeta,
	columns,
	contextMenu,
}: DataGridContextMenuProps<TData>) {
	const onContextMenuOpenChange = tableMeta?.onContextMenuOpenChange;
	const selectionState = tableMeta?.selectionState;
	const dataGridRef = tableMeta?.dataGridRef;
	const onDataUpdate = tableMeta?.onDataUpdate;
	const onRowsDelete = tableMeta?.onRowsDelete;
	const onCellsCopy = tableMeta?.onCellsCopy;
	const onCellsCut = tableMeta?.onCellsCut;

	if (!contextMenu.open) {
		return null;
	}

	return (
		<ContextMenu
			columns={columns}
			contextMenu={contextMenu}
			dataGridRef={dataGridRef}
			onCellsCopy={onCellsCopy}
			onCellsCut={onCellsCut}
			onContextMenuOpenChange={onContextMenuOpenChange}
			onDataUpdate={onDataUpdate}
			onRowsDelete={onRowsDelete}
			selectionState={selectionState}
			tableMeta={tableMeta}
		/>
	);
}

interface ContextMenuProps<TData>
	extends Pick<
			TableMeta<TData>,
			| "dataGridRef"
			| "onContextMenuOpenChange"
			| "selectionState"
			| "onDataUpdate"
			| "onRowsDelete"
			| "onCellsCopy"
			| "onCellsCut"
			| "readOnly"
		>,
		Required<Pick<TableMeta<TData>, "contextMenu">> {
	columns: ColumnDef<TData>[];
	tableMeta: TableMeta<TData>;
}

const ContextMenu = memo(ContextMenuImpl, (prev, next) => {
	if (prev.contextMenu.open !== next.contextMenu.open) {
		return false;
	}
	if (!next.contextMenu.open) {
		return true;
	}
	if (prev.contextMenu.x !== next.contextMenu.x) {
		return false;
	}
	if (prev.contextMenu.y !== next.contextMenu.y) {
		return false;
	}

	const prevSize = prev.selectionState?.selectedCells?.size ?? 0;
	const nextSize = next.selectionState?.selectedCells?.size ?? 0;
	if (prevSize !== nextSize) {
		return false;
	}

	return true;
}) as typeof ContextMenuImpl;

function ContextMenuImpl<TData>({
	tableMeta,
	columns,
	dataGridRef,
	contextMenu,
	onContextMenuOpenChange,
	selectionState,
	onDataUpdate,
	onRowsDelete,
	onCellsCopy,
	onCellsCut,
}: ContextMenuProps<TData>) {
	const propsRef = useAsRef({
		dataGridRef,
		selectionState,
		onDataUpdate,
		onRowsDelete,
		onCellsCopy,
		onCellsCut,
		columns,
	});

	const triggerStyle = useMemo<CSSProperties>(
		() => ({
			position: "fixed",
			left: `${contextMenu.x}px`,
			top: `${contextMenu.y}px`,
			width: "1px",
			height: "1px",
			padding: 0,
			margin: 0,
			border: "none",
			background: "transparent",
			pointerEvents: "none",
			opacity: 0,
		}),
		[contextMenu.x, contextMenu.y]
	);

	// Base UI's Menu has no `onCloseAutoFocus`; replicate the "return focus to the
	// grid after the menu closes" behaviour by refocusing on the close transition.
	const onOpenChange = useCallback(
		(open: boolean) => {
			onContextMenuOpenChange?.(open);
			if (!open) {
				propsRef.current.dataGridRef?.current?.focus();
			}
		},
		[onContextMenuOpenChange, propsRef]
	);

	const onCopy = useCallback(() => {
		propsRef.current.onCellsCopy?.();
	}, [propsRef]);

	const onCut = useCallback(() => {
		propsRef.current.onCellsCut?.();
	}, [propsRef]);

	const onClear = useCallback(() => {
		const { selectionState, columns, onDataUpdate } = propsRef.current;

		if (
			!selectionState?.selectedCells ||
			selectionState.selectedCells.size === 0
		) {
			return;
		}

		const updates: CellUpdate[] = [];

		for (const cellKey of selectionState.selectedCells) {
			const { rowIndex, columnId } = parseCellKey(cellKey);

			// Get column from columns array
			const column = columns.find((col) => {
				if (col.id) {
					return col.id === columnId;
				}
				if ("accessorKey" in col) {
					return col.accessorKey === columnId;
				}
				return false;
			});
			const cellVariant = column?.meta?.cell?.variant;

			const emptyValue = getEmptyCellValue(cellVariant);

			updates.push({ rowIndex, columnId, value: emptyValue });
		}

		onDataUpdate?.(updates);

		toast.success(
			`${updates.length} cell${updates.length === 1 ? "" : "s"} cleared`
		);
	}, [propsRef]);

	const onDelete = useCallback(async () => {
		const { selectionState, onRowsDelete } = propsRef.current;

		if (
			!selectionState?.selectedCells ||
			selectionState.selectedCells.size === 0
		) {
			return;
		}

		const rowIndices = new Set<number>();
		for (const cellKey of selectionState.selectedCells) {
			const { rowIndex } = parseCellKey(cellKey);
			rowIndices.add(rowIndex);
		}

		const rowIndicesArray = Array.from(rowIndices).sort((a, b) => a - b);
		const rowCount = rowIndicesArray.length;

		await onRowsDelete?.(rowIndicesArray);

		toast.success(`${rowCount} row${rowCount === 1 ? "" : "s"} deleted`);
	}, [propsRef]);

	return (
		<DropdownMenu onOpenChange={onOpenChange} open={contextMenu.open}>
			<DropdownMenuTrigger style={triggerStyle} />
			<DropdownMenuContent align="start" className="w-48" data-grid-popover="">
				<DropdownMenuItem onClick={onCopy}>
					<CopyIcon />
					Copy
				</DropdownMenuItem>
				<DropdownMenuItem disabled={tableMeta?.readOnly} onClick={onCut}>
					<ScissorsIcon />
					Cut
				</DropdownMenuItem>
				<DropdownMenuItem disabled={tableMeta?.readOnly} onClick={onClear}>
					<EraserIcon />
					Clear
				</DropdownMenuItem>
				{onRowsDelete && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem onClick={onDelete} variant="destructive">
							<Trash2Icon />
							Delete rows
						</DropdownMenuItem>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
