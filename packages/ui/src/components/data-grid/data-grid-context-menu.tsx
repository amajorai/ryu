"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { useAsRef } from "@ryu/ui/hooks/use-as-ref.ts";
import { getEmptyCellValue, parseCellKey } from "@ryu/ui/lib/data-grid.ts";
import type { CellUpdate, ContextMenuState } from "@ryu/ui/types/data-grid.ts";
import type { ColumnDef, TableMeta } from "@tanstack/react-table";
import {
	ArrowDownToLineIcon,
	ArrowRightToLineIcon,
	BetweenHorizontalEndIcon,
	BetweenHorizontalStartIcon,
	ClipboardPasteIcon,
	CopyIcon,
	CopyPlusIcon,
	EraserIcon,
	ScissorsIcon,
	Trash2Icon,
} from "lucide-react";
import { type CSSProperties, memo, useCallback } from "react";
import { toast } from "sonner";

interface ContextTriggerStyle extends CSSProperties {
	"--context-x": string;
	"--context-y": string;
}

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

// SAFETY: React.memo retains this complete native generic props forwarding and comparator. This restores the generic JSX component signature erased by React's memo overload; the runtime memo descriptor is used only by JSX, never invoked as an ordinary function.
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
	const tl = useLiteralMessages();
	const propsRef = useAsRef({
		dataGridRef,
		selectionState,
		onDataUpdate,
		onRowsDelete,
		onCellsCopy,
		onCellsCut,
		columns,
	});

	const triggerStyle: ContextTriggerStyle = {
		"--context-x": `${contextMenu.x}px`,
		"--context-y": `${contextMenu.y}px`,
	};

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
			tl(
				"{count, plural, one {{countText} cell cleared} other {{countText} cells cleared}}",
				{ count: updates.length, countText: String(updates.length) }
			)
		);
	}, [propsRef, tl]);

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

		toast.success(
			tl(
				"{count, plural, one {{countText} row deleted} other {{countText} rows deleted}}",
				{ count: rowCount, countText: String(rowCount) }
			)
		);
	}, [propsRef, tl]);

	return (
		<DropdownMenu onOpenChange={onOpenChange} open={contextMenu.open}>
			<DropdownMenuTrigger
				className="pointer-events-none fixed top-(--context-y) left-(--context-x) m-0 size-px border-none bg-transparent p-0 opacity-0"
				style={triggerStyle}
			/>
			<DropdownMenuContent align="start" className="w-56" data-grid-popover="">
				<DropdownMenuItem onClick={onCopy}>
					<CopyIcon />
					Copy
				</DropdownMenuItem>
				<DropdownMenuItem disabled={tableMeta?.readOnly} onClick={onCut}>
					<ScissorsIcon />
					Cut
				</DropdownMenuItem>
				{tableMeta?.onCellsPaste && (
					<DropdownMenuItem
						disabled={tableMeta.readOnly}
						onClick={() => tableMeta.onCellsPaste?.()}
					>
						<ClipboardPasteIcon />
						Paste
					</DropdownMenuItem>
				)}
				{tableMeta?.onCellsPasteTransposed && (
					<DropdownMenuItem
						disabled={tableMeta.readOnly}
						onClick={() => tableMeta.onCellsPasteTransposed?.()}
					>
						<ClipboardPasteIcon />
						Paste transposed
					</DropdownMenuItem>
				)}
				<DropdownMenuItem disabled={tableMeta?.readOnly} onClick={onClear}>
					<EraserIcon />
					Clear
				</DropdownMenuItem>
				{tableMeta?.onFillSelection && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							disabled={tableMeta.readOnly}
							onClick={() => tableMeta.onFillSelection?.("down")}
						>
							<ArrowDownToLineIcon />
							Fill down
							<DropdownMenuShortcut>Ctrl+D</DropdownMenuShortcut>
						</DropdownMenuItem>
						<DropdownMenuItem
							disabled={tableMeta.readOnly}
							onClick={() => tableMeta.onFillSelection?.("right")}
						>
							<ArrowRightToLineIcon />
							Fill right
							<DropdownMenuShortcut>Ctrl+R</DropdownMenuShortcut>
						</DropdownMenuItem>
					</>
				)}
				{tableMeta?.onRowsInsert && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							disabled={tableMeta.readOnly}
							onClick={() => tableMeta.onRowsInsert?.("above")}
						>
							<BetweenHorizontalStartIcon />
							Insert row above
						</DropdownMenuItem>
						<DropdownMenuItem
							disabled={tableMeta.readOnly}
							onClick={() => tableMeta.onRowsInsert?.("below")}
						>
							<BetweenHorizontalEndIcon />
							Insert row below
						</DropdownMenuItem>
						<DropdownMenuItem
							disabled={tableMeta.readOnly}
							onClick={() => tableMeta.onRowsInsert?.("duplicate")}
						>
							<CopyPlusIcon />
							Duplicate rows
						</DropdownMenuItem>
					</>
				)}
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
