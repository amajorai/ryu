import { LibraryIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import { DataGrid } from "@ryu/ui/components/data-grid/data-grid";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { Input } from "@ryu/ui/components/input";
import { toast } from "@ryu/ui/components/sileo";
import { Spinner } from "@ryu/ui/components/spinner";
import { useDataGrid } from "@ryu/ui/hooks/use-data-grid";
import { getEmptyCellValue } from "@ryu/ui/lib/data-grid";
import type { CellOpts } from "@ryu/ui/types/data-grid";
import type { ColumnDef } from "@tanstack/react-table";
import { Maximize2, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ColumnEditor } from "@/src/components/spaces/ColumnEditor.tsx";
import { BoardView } from "@/src/components/spaces/views/BoardView.tsx";
import { GalleryView } from "@/src/components/spaces/views/GalleryView.tsx";
import { ListView } from "@/src/components/spaces/views/ListView.tsx";
import { ViewBar } from "@/src/components/spaces/views/ViewBar.tsx";
import { useSpacesContext } from "@/src/contexts/SpacesContext.tsx";
import {
	useCurrentTabId,
	useTabsContext,
} from "@/src/contexts/TabsContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import {
	type DatabaseSnapshot,
	useDatabaseCollab,
} from "@/src/lib/realtime/use-database-collab.ts";
import {
	addColumn as addColumnY,
	addRow as addRowY,
	addView as addViewY,
	applyCellEdits,
	type DatabaseDoc,
	type DbColumn,
	type DbRow,
	type DbView,
	type DbViewKind,
	defaultView,
	diffCellEdits,
	makeEmptyRow,
	newColumnId,
	newRowId,
	newViewId,
	parseDatabaseDoc,
	removeRows as removeRowsY,
	removeView as removeViewY,
	updateColumn as updateColumnY,
	updateView as updateViewY,
} from "@/src/lib/realtime/yjs-database.ts";

const SAVE_DEBOUNCE_MS = 800;
const DEFAULT_GRID_HEIGHT = 480;

type SaveState = "idle" | "saving" | "saved" | "error";

const SAVE_LABEL: Record<SaveState, string> = {
	idle: "",
	saving: "Saving…",
	saved: "Saved",
	error: "Saved on this device",
};

/** A sensible default name for a freshly-added view of the given kind. */
function defaultViewName(kind: DbViewKind): string {
	switch (kind) {
		case "board":
			return "Board";
		case "gallery":
			return "Gallery";
		case "list":
			return "List";
		default:
			return "Table";
	}
}

/** Editor state for the create / edit column dialog. */
type ColumnEditorState =
	| { mode: "create" }
	| {
			mode: "edit";
			columnId: string;
			initial: { label: string; cell: CellOpts };
	  }
	| null;

/** Drop the reserved collaborative `__id` from rows before serializing to JSON. */
function stripRowIds(rows: DbRow[]): DbRow[] {
	return rows.map(({ __id, ...rest }) => rest);
}

/**
 * A Notion-style database editor backed by a CRDT. The grid is modelled as Yjs
 * shared types over a {@link useDatabaseCollab} room (a `kind:"document"` realtime
 * room keyed by the database id), so two clients editing the same database
 * converge: edits to different cells merge, same-cell is last-writer-wins, and
 * concurrent row appends order deterministically (see `yjs-database.ts`).
 *
 * Persistence split:
 *  - NON-collaborative (no/unreachable node): the grid keeps its original
 *    behaviour — local state + a debounced full-JSON `PUT` that re-embeds in Core.
 *  - COLLABORATIVE (room synced): cell/row/column edits route to the Yjs doc (Core
 *    persists the CRDT and rebroadcasts). The per-edit full-JSON PUT is DISABLED —
 *    Core owns materializing the source back for the embed/RAG readers. Only a
 *    title change still flushes (with a source snapshot derived from the live Yjs
 *    doc, so it never fights the CRDT).
 */
export default function SpaceDatabaseEditorPage({
	spaceId,
	databaseId,
}: {
	spaceId: string;
	databaseId: string;
}) {
	const { getDocument, saveDocument } = useSpacesContext();
	const { updateTabTitle, openTab } = useTabsContext();
	const tabId = useCurrentTabId();
	const node = useActiveNode();

	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [title, setTitle] = useState("");
	const [columns, setColumns] = useState<DbColumn[]>([]);
	const [rows, setRows] = useState<DbRow[]>([]);
	const [views, setViews] = useState<DbView[]>([]);
	const [activeViewId, setActiveViewId] = useState<string>("");
	const [saveState, setSaveState] = useState<SaveState>("idle");
	const [columnEditor, setColumnEditor] = useState<ColumnEditorState>(null);
	// Bumped by the load-error Retry button to re-run the initial fetch.
	const [_reloadNonce, setReloadNonce] = useState(0);

	// Latest unsaved values, read inside the debounced flush / grid callbacks
	// without re-arming effects or rebuilding callbacks.
	const titleRef = useRef("");
	const columnsRef = useRef<DbColumn[]>([]);
	const rowsRef = useRef<DbRow[]>([]);
	const viewsRef = useRef<DbView[]>([]);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		let cancelled = false;
		getDocument(spaceId, databaseId)
			.then((doc) => {
				if (cancelled) {
					return;
				}
				const parsed = parseDatabaseDoc(doc.source);
				// Give every row a stable in-memory `__id` (stripped again on save) so
				// the card views and `setCell` can address a row by id in BOTH the
				// collaborative and local paths, not just the collaborative snapshot.
				const seededRows = parsed.rows.map((row) => ({
					...row,
					__id: typeof row.__id === "string" ? row.__id : newRowId(),
				}));
				const seededViews =
					parsed.views && parsed.views.length > 0
						? parsed.views
						: [defaultView()];
				setTitle(doc.title);
				setColumns(parsed.columns);
				setRows(seededRows);
				setViews(seededViews);
				setActiveViewId(seededViews[0]?.id ?? "");
				titleRef.current = doc.title;
				columnsRef.current = parsed.columns;
				rowsRef.current = seededRows;
				viewsRef.current = seededViews;
				setLoaded(true);
			})
			.catch(() => {
				if (!cancelled) {
					setError(
						"We couldn't open this database. Check your connection and try again."
					);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [getDocument, spaceId, databaseId]);

	// Adopt a snapshot (first sync + every CRDT change) into refs + render state.
	const onSnapshot = useCallback((snapshot: DatabaseSnapshot) => {
		columnsRef.current = snapshot.columns;
		rowsRef.current = snapshot.rows;
		viewsRef.current = snapshot.views;
		setColumns(snapshot.columns);
		setRows(snapshot.rows);
		setViews(snapshot.views);
		// Keep the selection valid if the active view was deleted remotely.
		setActiveViewId((current) =>
			snapshot.views.some((view) => view.id === current)
				? current
				: (snapshot.views[0]?.id ?? "")
		);
	}, []);

	// Seed for a first-into-an-empty-room client: the loaded JSON (refs hold the
	// latest, capturing any edits made before the room synced).
	const getSeed = useCallback(
		(): DatabaseDoc => ({
			columns: columnsRef.current,
			rows: stripRowIds(rowsRef.current),
			views: viewsRef.current,
		}),
		[]
	);

	const { access, collaborative, getCollabDoc } = useDatabaseCollab({
		roomId: databaseId,
		ready: loaded,
		url: node.url,
		token: node.token ?? null,
		getSeed,
		onSnapshot,
	});

	// A read-only collaborator's edits are dropped server-side (Core's write-ACL),
	// so the grid must refuse them locally too — otherwise an edit would appear to
	// apply, broadcast, get dropped, and vanish on reload (silent data loss).
	const readOnly = access === "read";

	const flush = useCallback(async () => {
		setSaveState("saving");
		// The source is derived from the current refs; in collaborative mode those
		// hold the live CRDT snapshot, so the PUT is a consistent checkpoint rather
		// than a partial/racey write.
		const source = JSON.stringify({
			columns: columnsRef.current,
			rows: stripRowIds(rowsRef.current),
			views: viewsRef.current,
		} satisfies DatabaseDoc);
		try {
			await saveDocument(spaceId, databaseId, titleRef.current, source);
			setSaveState("saved");
		} catch {
			setSaveState("error");
			toast.error(
				"Saved on this device. Some search features may be unavailable right now."
			);
		}
	}, [saveDocument, spaceId, databaseId]);

	const scheduleSave = useCallback(() => {
		if (timerRef.current) {
			clearTimeout(timerRef.current);
		}
		setSaveState("saving");
		timerRef.current = setTimeout(() => {
			flush().catch(() => {
				// `flush` already surfaces failures via a toast; nothing to add here.
			});
		}, SAVE_DEBOUNCE_MS);
	}, [flush]);

	// Flush a pending save when the tab unmounts so in-flight edits are not lost.
	useEffect(
		() => () => {
			if (timerRef.current) {
				clearTimeout(timerRef.current);
				flush().catch(() => {
					// Same as above — surfaced inside `flush`.
				});
			}
		},
		[flush]
	);

	// A grid data edit. Collaborative: write only the changed cells to the CRDT
	// (addressed by stable __id). Otherwise: local state + debounced PUT.
	const onDataChange = useCallback(
		(next: DbRow[]) => {
			const doc = getCollabDoc();
			if (doc) {
				applyCellEdits(
					doc,
					diffCellEdits(next, rowsRef.current, columnsRef.current)
				);
				return;
			}
			rowsRef.current = next;
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
					.filter((id): id is string => typeof id === "string");
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
				const nextColumns = columnsRef.current.map((c) =>
					c.id === columnId ? { ...c, label, cell } : c
				);
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
	const onColumnEdit = useCallback((columnId: string) => {
		const column = columnsRef.current.find((c) => c.id === columnId);
		if (column) {
			setColumnEditor({
				mode: "edit",
				columnId,
				initial: { label: column.label, cell: column.cell },
			});
		}
	}, []);

	// Open a row as its own page (properties + markdown body) in a new tab.
	const openRow = useCallback(
		(row: DbRow) => {
			const rowId = row.__id;
			if (!rowId) {
				return;
			}
			const nameColumnId = columnsRef.current[0]?.id;
			const name = nameColumnId ? String(row[nameColumnId] ?? "") : "";
			openTab(`/spaces/${spaceId}/db/${databaseId}/row/${rowId}`, {
				title: name || "Untitled",
			});
		},
		[openTab, spaceId, databaseId]
	);

	// Set a single cell by stable row + column id, in either persistence mode. Used
	// by the board when a card is dragged to a new group lane.
	const setCell = useCallback(
		(rowId: string, columnId: string, value: unknown) => {
			if (readOnly) {
				return;
			}
			const doc = getCollabDoc();
			if (doc) {
				applyCellEdits(doc, [{ rowId, columnId, value }]);
				return;
			}
			const next = rowsRef.current.map((row) =>
				row.__id === rowId ? { ...row, [columnId]: value } : row
			);
			rowsRef.current = next;
			setRows(next);
			scheduleSave();
		},
		[readOnly, getCollabDoc, scheduleSave]
	);

	// Append a row, optionally pre-filling some cells (a board lane's group value).
	const createRow = useCallback(
		(values?: Record<string, unknown>) => {
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
				<div className="flex size-full items-center justify-center">
					<Button
						aria-label="Open row"
						className="size-6 text-muted-foreground opacity-0 focus:opacity-100 group-hover:opacity-100"
						onClick={() => openRow(row.original)}
						size="icon"
						variant="ghost"
					>
						<Maximize2 className="size-3.5" />
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

	const grid = useDataGrid<DbRow>({
		data: rows,
		columns: gridColumns,
		onDataChange,
		onRowAdd,
		onRowsDelete,
		readOnly,
		meta: { onColumnEdit },
	});

	if (error) {
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={LibraryIcon} />
					</EmptyMedia>
					<EmptyTitle>Could not open database</EmptyTitle>
					<EmptyDescription>{error}</EmptyDescription>
				</EmptyHeader>
				<Button
					onClick={() => {
						setError(null);
						setReloadNonce((n) => n + 1);
					}}
					size="sm"
					variant="outline"
				>
					Try again
				</Button>
			</Empty>
		);
	}

	if (!loaded) {
		return (
			<div className="flex h-full items-center justify-center">
				<Spinner />
			</div>
		);
	}

	let statusLabel = SAVE_LABEL[saveState];
	if (collaborative) {
		statusLabel = readOnly ? "Live · read-only" : "Live";
	}

	const activeView = views.find((view) => view.id === activeViewId) ?? views[0];
	const activeKind = activeView?.kind ?? "table";

	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="flex shrink-0 items-center gap-3 border-b px-4 py-2">
				<Input
					aria-label="Database title"
					className="h-8 border-none bg-transparent px-0 font-medium text-base shadow-none focus-visible:ring-0"
					disabled={readOnly}
					onChange={(e) => handleTitleChange(e.target.value)}
					placeholder="Untitled"
					value={title}
				/>
				<span className="shrink-0 text-muted-foreground text-xs">
					{statusLabel}
				</span>
				{activeKind === "table" && (
					<Button
						disabled={readOnly}
						onClick={() => setColumnEditor({ mode: "create" })}
						size="sm"
						variant="outline"
					>
						<Plus className="size-3.5" />
						Add column
					</Button>
				)}
			</div>
			<ViewBar
				activeViewId={activeView?.id ?? ""}
				columns={columns}
				onAddView={addView}
				onRemoveView={removeView}
				onSelect={setActiveViewId}
				onUpdateView={updateView}
				readOnly={readOnly}
				views={views}
			/>
			<div className="min-h-0 flex-1 overflow-hidden">
				{activeKind === "table" && (
					<div className="h-full overflow-auto p-4">
						<DataGrid {...grid} height={DEFAULT_GRID_HEIGHT} />
					</div>
				)}
				{activeKind === "board" && (
					<BoardView
						columns={columns}
						createRow={createRow}
						groupByColumnId={activeView?.groupByColumnId}
						onOpenRow={openRow}
						readOnly={readOnly}
						rows={rows}
						setCell={setCell}
					/>
				)}
				{activeKind === "gallery" && (
					<GalleryView
						columns={columns}
						createRow={createRow}
						onOpenRow={openRow}
						readOnly={readOnly}
						rows={rows}
					/>
				)}
				{activeKind === "list" && (
					<ListView
						columns={columns}
						createRow={createRow}
						onOpenRow={openRow}
						readOnly={readOnly}
						rows={rows}
					/>
				)}
			</div>
			<Dialog
				onOpenChange={(open) => {
					if (!open) {
						setColumnEditor(null);
					}
				}}
				open={columnEditor !== null}
			>
				<DialogContent className="max-w-sm">
					<DialogHeader>
						<DialogTitle>
							{columnEditor?.mode === "edit" ? "Edit property" : "New property"}
						</DialogTitle>
					</DialogHeader>
					{columnEditor !== null && (
						<ColumnEditor
							initial={
								columnEditor.mode === "edit" ? columnEditor.initial : undefined
							}
							onCancel={() => setColumnEditor(null)}
							onSubmit={(label, cell) => {
								if (columnEditor.mode === "edit") {
									updateColumn(columnEditor.columnId, label, cell);
								} else {
									addColumn(label, cell);
								}
							}}
							submitLabel={
								columnEditor.mode === "edit" ? "Save" : "Add property"
							}
						/>
					)}
				</DialogContent>
			</Dialog>
		</div>
	);
}
