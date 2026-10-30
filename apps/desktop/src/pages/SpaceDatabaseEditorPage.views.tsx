import { FullScreenIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { jsonResponseValueSchema } from "@ryu/app-host/json-values";
import { Button } from "@ryu/ui/components/button.tsx";
import { useDataGrid } from "@ryu/ui/hooks/use-data-grid.ts";
import { computeFormulaColumns } from "@ryu/ui/lib/data-grid-formula.ts";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import type { ColumnDef } from "@tanstack/react-table";
import { useCallback, useMemo } from "react";
import {
	addRow as addRowY,
	addView as addViewY,
	applyCellEdits,
	type DbRow,
	type DbView,
	type DbViewKind,
	makeEmptyRow,
	newRowId,
	newViewId,
	removeView as removeViewY,
	updateView as updateViewY,
} from "@/src/lib/realtime/yjs-database.ts";
import type { useSpaceDatabaseDocument } from "./SpaceDatabaseEditorPage.document.ts";
import { defaultViewName } from "./SpaceDatabaseEditorPage.model.ts";
import type { useSpaceDatabaseRowsAndColumns } from "./SpaceDatabaseEditorPage.rows.ts";

type SpaceDatabaseViewsInput = Pick<
	ReturnType<typeof useSpaceDatabaseDocument>,
	| "columns"
	| "columnsRef"
	| "getCollabDoc"
	| "readOnly"
	| "rows"
	| "rowsRef"
	| "scheduleSave"
	| "setActiveViewId"
	| "setRows"
	| "setTitle"
	| "setViews"
	| "tabId"
	| "titleRef"
	| "updateTabTitle"
	| "viewsRef"
> &
	Pick<
		ReturnType<typeof useSpaceDatabaseRowsAndColumns>,
		| "onColumnEdit"
		| "onDataChange"
		| "onRowAdd"
		| "onRowsAdd"
		| "onRowsDelete"
		| "onRowsInsert"
		| "openRow"
	>;

/** Cell writes, row creation, saved views, the title, and the data grid model. */
export function useSpaceDatabaseViews({
	columns,
	columnsRef,
	getCollabDoc,
	onColumnEdit,
	onDataChange,
	onRowAdd,
	onRowsAdd,
	onRowsDelete,
	onRowsInsert,
	openRow,
	readOnly,
	rows,
	rowsRef,
	scheduleSave,
	setActiveViewId,
	setRows,
	setTitle,
	setViews,
	tabId,
	titleRef,
	updateTabTitle,
	viewsRef,
}: SpaceDatabaseViewsInput) {
	// Set a single cell by stable row + column id, in either persistence mode. Used
	// by the board when a card is dragged to a new group lane.
	const setCell = useCallback(
		(
			rowId: string,
			columnId: string,
			value: Parameters<typeof applyCellEdits>[1][number]["value"]
		) => {
			if (readOnly) {
				return;
			}
			const doc = getCollabDoc();
			if (doc) {
				applyCellEdits(doc, [{ rowId, columnId, value }]);
				return;
			}
			const parsedValue = jsonResponseValueSchema.parse(value);
			const next = rowsRef.current.map((row) =>
				row.__id === rowId ? { ...row, [columnId]: parsedValue } : row
			);
			rowsRef.current = next;
			setRows(next);
			scheduleSave();
		},
		[readOnly, getCollabDoc, scheduleSave]
	);
	// Append a row, optionally pre-filling some cells (a board lane's group value).
	const createRow = useCallback(
		(values?: DbRow) => {
			if (readOnly) {
				return;
			}
			const doc = getCollabDoc();
			if (doc) {
				const id = addRowY(doc, columnsRef.current);
				if (values) {
					applyCellEdits(
						doc,
						Object.entries(values).map(([columnId, value]) => ({
							rowId: id,
							columnId,
							value,
						}))
					);
				}
				return;
			}
			const next = [
				...rowsRef.current,
				{ ...makeEmptyRow(columnsRef.current), ...values, __id: newRowId() },
			];
			rowsRef.current = next;
			setRows(next);
			scheduleSave();
		},
		[readOnly, getCollabDoc, scheduleSave]
	);
	const addView = useCallback(
		(kind: DbViewKind) => {
			if (readOnly) {
				return;
			}
			const view: DbView = {
				id: newViewId(),
				name: defaultViewName(kind),
				kind,
			};
			const doc = getCollabDoc();
			if (doc) {
				addViewY(doc, view);
			} else {
				const next = [...viewsRef.current, view];
				viewsRef.current = next;
				setViews(next);
				scheduleSave();
			}
			setActiveViewId(view.id);
		},
		[readOnly, getCollabDoc, scheduleSave]
	);
	const updateView = useCallback(
		(
			viewId: string,
			patch: {
				name?: string;
				kind?: DbViewKind;
				groupByColumnId?: string | null;
			}
		) => {
			if (readOnly) {
				return;
			}
			const doc = getCollabDoc();
			if (doc) {
				updateViewY(doc, viewId, patch);
				return;
			}
			const next = viewsRef.current.map((view) => {
				if (view.id !== viewId) {
					return view;
				}
				const merged: DbView = { ...view };
				if (patch.name !== undefined) {
					merged.name = patch.name;
				}
				if (patch.kind !== undefined) {
					merged.kind = patch.kind;
				}
				if (patch.groupByColumnId !== undefined) {
					if (patch.groupByColumnId) {
						merged.groupByColumnId = patch.groupByColumnId;
					} else {
						merged.groupByColumnId = undefined;
					}
				}
				return merged;
			});
			viewsRef.current = next;
			setViews(next);
			scheduleSave();
		},
		[readOnly, getCollabDoc, scheduleSave]
	);
	const removeView = useCallback(
		(viewId: string) => {
			if (readOnly || viewsRef.current.length <= 1) {
				return;
			}
			const remaining = viewsRef.current.filter((view) => view.id !== viewId);
			const doc = getCollabDoc();
			if (doc) {
				removeViewY(doc, viewId);
			} else {
				viewsRef.current = remaining;
				setViews(remaining);
				scheduleSave();
			}
			setActiveViewId((current) =>
				current === viewId ? (remaining[0]?.id ?? "") : current
			);
		},
		[readOnly, getCollabDoc, scheduleSave]
	);
	const handleTitleChange = useCallback(
		(next: string) => {
			if (readOnly) {
				return;
			}
			setTitle(next);
			titleRef.current = next;
			if (tabId) {
				updateTabTitle(tabId, next || "Untitled");
			}
			// Title lives outside the CRDT; persist it (with a CRDT-consistent source
			// snapshot) in both modes.
			scheduleSave();
		},
		[scheduleSave, tabId, updateTabTitle, readOnly]
	);
	const gridColumns = useMemo<ColumnDef<DbRow>[]>(() => {
		// Leading, non-navigable "open row as page" affordance. Using the reserved
		// "actions" id (in the grid's NON_NAVIGABLE_COLUMN_IDS) + a function header
		// makes the row render it via flexRender (not as an editable data cell).
		const openColumn: ColumnDef<DbRow> = {
			id: "actions",
			enableSorting: false,
			enableResizing: false,
			enableHiding: false,
			size: 40,
			header: () => null,
			cell: ({ row }) => (
				<div className="flex size-full items-center justify-center opacity-0 focus-within:opacity-100 group-hover:opacity-100">
					<Button
						aria-label="Open row"
						className="size-6"
						onClick={() => openRow(row.original)}
						size="icon"
						variant="ghost-muted"
					>
						<HugeiconsIcon className="size-3.5" icon={FullScreenIcon} />
					</Button>
				</div>
			),
		};
		return [
			openColumn,
			...columns.map((column) => ({
				id: column.id,
				accessorKey: column.id,
				header: column.label,
				meta: { label: column.label, cell: column.cell },
			})),
		];
	}, [columns, openRow]);
	// Formula columns are computed here for every view; storage keeps inputs only.
	const displayRows = useMemo(
		() => computeFormulaColumns(rows, columns),
		[rows, columns]
	);
	const grid = useDataGrid<DbRow>({
		data: displayRows,
		columns: gridColumns,
		// Stable row identity keeps undo/redo pointed at the right row after
		// sorting, deletes, or collaborative edits.
		getRowId: (row, index) =>
			isNativeText(row.__id) ? row.__id : String(index),
		enableSelectionSummary: true,
		enablePaste: !readOnly,
		onDataChange,
		onRowsAdd,
		onRowsInsert,
		onRowAdd,
		onRowsDelete,
		readOnly,
		meta: { onColumnEdit: readOnly ? undefined : onColumnEdit },
	});
	return {
		addView,
		createRow,
		displayRows,
		grid,
		handleTitleChange,
		removeView,
		setCell,
		updateView,
	};
}
