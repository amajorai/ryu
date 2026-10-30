import { getEmptyCellValue } from "@ryu/ui/lib/data-grid.ts";
import { renameColumnInFormulas } from "@ryu/ui/lib/data-grid-formula.ts";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import type { CellOpts } from "@ryu/ui/types/data-grid.ts";
import { useCallback } from "react";
import {
	addColumn as addColumnY,
	addRow as addRowY,
	applyCellEdits,
	type DbColumn,
	type DbRow,
	diffCellEdits,
	insertRows as insertRowsY,
	makeEmptyRow,
	newColumnId,
	newRowId,
	removeRows as removeRowsY,
	updateColumn as updateColumnY,
} from "@/src/lib/realtime/yjs-database.ts";
import type { useSpaceDatabaseDocument } from "./SpaceDatabaseEditorPage.document.ts";
import { withStoredFormulaValues } from "./SpaceDatabaseEditorPage.model.ts";

type SpaceDatabaseRowsAndColumnsInput = Pick<
	ReturnType<typeof useSpaceDatabaseDocument>,
	| "collaborative"
	| "columnsRef"
	| "flush"
	| "getCollabDoc"
	| "openTab"
	| "readOnly"
	| "rowsRef"
	| "scheduleSave"
	| "setColumnEditor"
	| "setColumns"
	| "setRows"
> & { databaseId: string; spaceId: string };

/** Row and column edits from the grid, the column editor, and row opening. */
export function useSpaceDatabaseRowsAndColumns({
	collaborative,
	columnsRef,
	databaseId,
	flush,
	getCollabDoc,
	openTab,
	readOnly,
	rowsRef,
	scheduleSave,
	setColumnEditor,
	setColumns,
	setRows,
	spaceId,
}: SpaceDatabaseRowsAndColumnsInput) {
	// A grid data edit. Collaborative: write only the changed cells to the CRDT
	// (addressed by stable __id). Otherwise: local state + debounced PUT.
	// Formula values are computed for display only, so they are never written.
	const onDataChange = useCallback(
		(next: DbRow[]) => {
			const storedColumns = columnsRef.current.filter(
				(column) => column.cell.variant !== "formula"
			);
			const doc = getCollabDoc();
			if (doc) {
				applyCellEdits(
					doc,
					diffCellEdits(next, rowsRef.current, storedColumns)
				);
				return;
			}
			rowsRef.current = withStoredFormulaValues(
				next,
				rowsRef.current,
				columnsRef.current
			);
			setRows(next);
			scheduleSave();
		},
		[scheduleSave, getCollabDoc]
	);
	const onRowAdd = useCallback(() => {
		const previousLength = rowsRef.current.length;
		const doc = getCollabDoc();
		if (doc) {
			addRowY(doc, columnsRef.current);
			return { rowIndex: previousLength };
		}
		const next = [...rowsRef.current, makeEmptyRow(columnsRef.current)];
		rowsRef.current = next;
		setRows(next);
		scheduleSave();
		return { rowIndex: previousLength };
	}, [scheduleSave, getCollabDoc]);
	const onRowsDelete = useCallback(
		(_deleted: DbRow[], rowIndices: number[]) => {
			const doc = getCollabDoc();
			if (doc) {
				const ids = rowIndices
					.map((index) => rowsRef.current[index]?.__id)
					.filter((id): id is string => isNativeText(id));
				removeRowsY(doc, ids);
				return;
			}
			const drop = new Set(rowIndices);
			const next = rowsRef.current.filter((_, index) => !drop.has(index));
			rowsRef.current = next;
			setRows(next);
			scheduleSave();
		},
		[scheduleSave, getCollabDoc]
	);
	// Insert rows at a data index: empty, duplicated (fresh ids, no body page),
	// or restored by undo (same id and body page, so later undo steps still
	// find the row). Returns the inserted row ids for the grid's undo history.
	const onRowsInsert = useCallback(
		({
			index,
			count,
			source,
			restore,
		}: {
			index: number;
			count: number;
			source?: DbRow[];
			restore?: boolean;
		}) => {
			const columns = columnsRef.current;
			const templates: DbRow[] = source
				? source.map((row) => {
						if (restore) {
							const restored: DbRow = { ...row };
							for (const column of columns) {
								if (column.cell.variant === "formula") {
									restored[column.id] = getEmptyCellValue(column.cell.variant);
								}
							}
							return restored;
						}
						const copy: DbRow = {};
						for (const column of columns) {
							if (column.cell.variant !== "formula") {
								copy[column.id] = structuredClone(row[column.id]);
							}
						}
						return copy;
					})
				: Array.from({ length: count }, () => ({}));
			const doc = getCollabDoc();
			if (doc) {
				return insertRowsY(doc, columns, index, templates);
			}
			const prepared = templates.map((row) => ({
				...makeEmptyRow(columns),
				...row,
				__id: isNativeText(row.__id) && row.__id ? row.__id : newRowId(),
			}));
			const at = Math.max(0, Math.min(index, rowsRef.current.length));
			const next = [
				...rowsRef.current.slice(0, at),
				...prepared,
				...rowsRef.current.slice(at),
			];
			rowsRef.current = next;
			setRows(next);
			scheduleSave();
			return prepared.map((row) => row.__id);
		},
		[scheduleSave, getCollabDoc]
	);
	// Paste that runs past the last row appends the missing rows in one step.
	const onRowsAdd = useCallback(
		(count: number) => {
			onRowsInsert({ index: rowsRef.current.length, count });
		},
		[onRowsInsert]
	);
	const addColumn = useCallback(
		(label: string, cell: CellOpts) => {
			if (readOnly) {
				return;
			}
			const column: DbColumn = { id: newColumnId(), label, cell };
			const doc = getCollabDoc();
			if (doc) {
				addColumnY(doc, column);
			} else {
				const nextColumns = [...columnsRef.current, column];
				const nextRows = rowsRef.current.map((row) => ({
					...row,
					[column.id]: getEmptyCellValue(cell.variant),
				}));
				columnsRef.current = nextColumns;
				rowsRef.current = nextRows;
				setColumns(nextColumns);
				setRows(nextRows);
				scheduleSave();
			}
			setColumnEditor(null);
		},
		[scheduleSave, getCollabDoc, readOnly]
	);
	// Rename / change type / edit options of an existing column.
	const updateColumn = useCallback(
		(columnId: string, label: string, cell: CellOpts) => {
			if (readOnly) {
				return;
			}
			const doc = getCollabDoc();
			if (doc) {
				updateColumnY(doc, columnId, { label, cell });
			} else {
				const prev = columnsRef.current.find((c) => c.id === columnId);
				const variantChanged = prev && prev.cell.variant !== cell.variant;
				const updatedColumns = columnsRef.current.map((c) =>
					c.id === columnId ? { ...c, label, cell } : c
				);
				// Formulas name columns by label; carry a rename into them.
				const nextColumns = prev
					? renameColumnInFormulas(updatedColumns, prev.label, label)
					: updatedColumns;
				const nextRows = variantChanged
					? rowsRef.current.map((row) => ({
							...row,
							[columnId]: getEmptyCellValue(cell.variant),
						}))
					: rowsRef.current;
				columnsRef.current = nextColumns;
				rowsRef.current = nextRows;
				setColumns(nextColumns);
				setRows(nextRows);
				scheduleSave();
			}
			setColumnEditor(null);
		},
		[scheduleSave, getCollabDoc, readOnly]
	);
	// Open the property editor for a column (from the header's "Edit property").
	const onColumnEdit = useCallback(
		(columnId: string) => {
			if (readOnly) {
				return;
			}
			const column = columnsRef.current.find((c) => c.id === columnId);
			if (column) {
				setColumnEditor({
					mode: "edit",
					columnId,
					initial: { label: column.label, cell: column.cell },
				});
			}
		},
		[readOnly]
	);
	// Open a row as its own page (properties + markdown body) in a new tab.
	const openRow = useCallback(
		async (row: DbRow) => {
			const rowId = row.__id;
			if (!rowId) {
				return;
			}
			if (!(collaborative || readOnly || (await flush()))) {
				return;
			}
			const nameColumnId = columnsRef.current[0]?.id;
			const name = nameColumnId ? String(row[nameColumnId] ?? "") : "";
			openTab(`/spaces/${spaceId}/db/${databaseId}/row/${rowId}`, {
				title: name || "Untitled",
			});
		},
		[collaborative, readOnly, flush, openTab, spaceId, databaseId]
	);
	return {
		addColumn,
		onColumnEdit,
		onDataChange,
		onRowAdd,
		onRowsAdd,
		onRowsDelete,
		onRowsInsert,
		openRow,
		updateColumn,
	};
}
