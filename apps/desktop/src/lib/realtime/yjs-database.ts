// apps/desktop/src/lib/realtime/yjs-database.ts
//
// The Yjs shared-type model for a collaborative data grid (Spaces "database"
// document). A database is two root Yjs collections on one `Y.Doc`:
//
//   - `columns`: a `Y.Array` of `Y.Map` ({ id, label, cell }). Order in the array
//     is the visual column order.
//   - `rows`:    a `Y.Array` of `Y.Map`. Each row map holds the cell values keyed
//     by *stable column id* (never by index), plus two reserved keys:
//       · `__id`    — a stable row id (uuid), used to address a row across peers
//                     even as the array shifts under concurrent inserts/deletes.
//       · `__order` — a fractional-index string; rows render sorted by
//                     `(__order, __id)`. The `__id` tiebreak makes two concurrent
//                     appends (which compute the *same* `__order`) converge to the
//                     same deterministic order on every peer.
//
// Yjs has no native "move", so reordering is modelled by rewriting `__order` to a
// key *between* two neighbours (see {@link orderKeyBetween}). The `Doc` is the
// authoritative state; the React layer derives a plain snapshot via
// {@link snapshotDatabase} on every `observeDeep` and routes edits back through
// the mutators here (each wrapped in a `doc.transact` so it ships as one update).

import { getEmptyCellValue } from "@ryu/ui/lib/data-grid.ts";
import type { CellOpts } from "@ryu/ui/types/data-grid";
import { type Doc, type Array as YArray, Map as YMap } from "yjs";

/** A column in a database document: stable id + display label + cell type. */
export interface DbColumn {
	cell: CellOpts;
	id: string;
	label: string;
}

/** The layout a {@link DbView} renders the same rows/columns with. */
export type DbViewKind = "table" | "board" | "gallery" | "list";

/**
 * A saved way of looking at the database. Views are pure display config layered
 * over the one shared set of columns/rows — switching a view never mutates data.
 * A database always has at least one view (a `table`); {@link snapshotDatabase}
 * synthesizes a default one for pre-views documents so the UI is never viewless.
 */
export interface DbView {
	/**
	 * The column to group cards by (board / gallery). Should point at a `select`
	 * column; an unset/stale id renders every card in a single "No group" lane.
	 */
	groupByColumnId?: string;
	id: string;
	kind: DbViewKind;
	name: string;
}

/**
 * A row keyed by column id. In a *collaborative* snapshot it also carries a
 * reserved `__id` (the stable Yjs row id) so a cell edit can address the exact
 * row regardless of how the array has shifted since the snapshot was taken. The
 * grid only reads explicit `accessorKey` columns, so the extra `__id` key is
 * inert for rendering, search, and copy/paste.
 */
export type DbRow = Record<string, unknown> & {
	__id?: string;
	/**
	 * Optional id of the row's body page document (a child `kind:"page"` doc). Set
	 * lazily the first time the row is opened as a page. Persisted with the row (it
	 * is NOT stripped like `__id`), so the link survives a save/reseed round-trip.
	 */
	__page?: string;
};

/** The JSON shape persisted in a database document's `source` (non-collab form). */
export interface DatabaseDoc {
	columns: DbColumn[];
	rows: DbRow[];
	/** Saved views; optional for backward compatibility (a default is synthesized). */
	views?: DbView[];
}

/** Root `Y.Array<Y.Map>` name for columns. */
const COLUMNS_KEY = "columns";
/** Root `Y.Array<Y.Map>` name for rows. */
const ROWS_KEY = "rows";
/** Root `Y.Array<Y.Map>` name for views. */
const VIEWS_KEY = "views";
/** Reserved row-map key holding the stable row id. */
const ROW_ID_KEY = "__id";
/** Reserved row-map key holding the fractional order string. */
const ROW_ORDER_KEY = "__order";
/** Reserved row-map key holding the row's body page document id (if opened). */
const ROW_PAGE_KEY = "__page";

/** Base-36 digit alphabet for {@link orderKeyBetween}, in ascending ASCII order. */
const ORDER_DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";
const ORDER_BASE = ORDER_DIGITS.length;
const ORDER_ZERO = ORDER_DIGITS[0];

/** A fresh, unique column id. */
export function newColumnId(): string {
	return `col_${crypto.randomUUID().slice(0, 8)}`;
}

/** A fresh, unique view id. */
export function newViewId(): string {
	return `view_${crypto.randomUUID().slice(0, 8)}`;
}

/** The default table view every database starts with. */
export function defaultView(): DbView {
	return { id: "view_table", name: "Table", kind: "table" };
}

/** A fresh, unique row id (the `__id` reserved key). */
export function newRowId(): string {
	return `row_${crypto.randomUUID()}`;
}

/**
 * A fractional-index key strictly between `a` and `b` (both base-36 fractions,
 * `a < b`). `a === null` means "before everything" (0); `b === null` means "after
 * everything" (1). The result never ends in the zero digit, so there is always
 * room to insert below it later. Concurrent callers passing the *same* `(a, b)`
 * get the *same* key — distinct rows then converge via the `__id` tiebreak in
 * {@link snapshotDatabase}.
 */
export function orderKeyBetween(a: string | null, b: string | null): string {
	const lower = a ?? "";
	return midpoint(lower, b);
}

/**
 * The recursive midpoint of two base-36 fractions (the canonical fractional-index
 * `midpoint`). `a` is the lower fraction (`""` = 0); `b` is the upper (`null` = 1).
 */
function midpoint(a: string, b: string | null): string {
	if (b !== null) {
		// Carry the longest common prefix forward, then recurse on the remainder so
		// the inserted digit lands in the right place value.
		let n = 0;
		while ((a[n] ?? ORDER_ZERO) === b[n] && n < b.length) {
			n += 1;
		}
		if (n > 0) {
			return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
		}
	}
	const digitA = a ? ORDER_DIGITS.indexOf(a[0] ?? ORDER_ZERO) : 0;
	const digitB =
		b === null ? ORDER_BASE : ORDER_DIGITS.indexOf(b[0] ?? ORDER_ZERO);
	if (digitB - digitA > 1) {
		// Room for a digit strictly between: take the (floored) average.
		const mid = Math.floor((digitA + digitB) / 2);
		return ORDER_DIGITS[mid] ?? ORDER_ZERO;
	}
	// Consecutive first digits: keep `a`'s first digit and recurse into its tail
	// against an open upper bound (this is what makes appends unbounded).
	return (ORDER_DIGITS[digitA] ?? ORDER_ZERO) + midpoint(a.slice(1), null);
}

/** Parse a database document's JSON `source`, tolerating empty/corrupt input. */
export function parseDatabaseDoc(source: string): DatabaseDoc {
	if (source.trim()) {
		try {
			const parsed = JSON.parse(source) as Partial<DatabaseDoc>;
			if (Array.isArray(parsed.columns) && Array.isArray(parsed.rows)) {
				return {
					columns: parsed.columns,
					rows: parsed.rows,
					views: Array.isArray(parsed.views) ? parsed.views : undefined,
				};
			}
		} catch {
			// Fall through to a fresh default — never lose the editor to bad JSON.
		}
	}
	return defaultDatabaseDoc();
}

/** A brand-new database with a single "Name" text column and no rows. */
export function defaultDatabaseDoc(): DatabaseDoc {
	return {
		columns: [
			{ id: "col_name", label: "Name", cell: { variant: "short-text" } },
		],
		rows: [],
		views: [defaultView()],
	};
}

/** An empty cell record (all columns at their type's empty value). */
export function makeEmptyRow(columns: DbColumn[]): DbRow {
	const row: DbRow = {};
	for (const column of columns) {
		row[column.id] = getEmptyCellValue(column.cell.variant);
	}
	return row;
}

/** The root columns array (created on first access). */
function getColumnsArray(doc: Doc): YArray<YMap<unknown>> {
	return doc.getArray<YMap<unknown>>(COLUMNS_KEY);
}

/** The root rows array (created on first access). */
function getRowsArray(doc: Doc): YArray<YMap<unknown>> {
	return doc.getArray<YMap<unknown>>(ROWS_KEY);
}

/** The root views array (created on first access). */
function getViewsArray(doc: Doc): YArray<YMap<unknown>> {
	return doc.getArray<YMap<unknown>>(VIEWS_KEY);
}

/** Build a `Y.Map` for one view. */
function makeViewMap(view: DbView): YMap<unknown> {
	const map = new YMap<unknown>();
	map.set("id", view.id);
	map.set("name", view.name);
	map.set("kind", view.kind);
	if (view.groupByColumnId) {
		map.set("groupByColumnId", view.groupByColumnId);
	}
	return map;
}

/** Read a view `Y.Map` back into a {@link DbView}. */
function readViewMap(map: YMap<unknown>): DbView {
	const groupByColumnId = map.get("groupByColumnId");
	return {
		id: String(map.get("id") ?? ""),
		name: String(map.get("name") ?? ""),
		kind: (String(map.get("kind") ?? "table") as DbViewKind) || "table",
		...(typeof groupByColumnId === "string" && groupByColumnId
			? { groupByColumnId }
			: {}),
	};
}

/** True when the doc has neither columns nor rows (i.e. nothing was seeded yet). */
export function isDatabaseEmpty(doc: Doc): boolean {
	return getColumnsArray(doc).length === 0 && getRowsArray(doc).length === 0;
}

/** Build a `Y.Map` for one column. */
function makeColumnMap(column: DbColumn): YMap<unknown> {
	const map = new YMap<unknown>();
	map.set("id", column.id);
	map.set("label", column.label);
	map.set("cell", column.cell);
	return map;
}

/** Read a column `Y.Map` back into a {@link DbColumn}. */
function readColumnMap(map: YMap<unknown>): DbColumn {
	return {
		id: String(map.get("id") ?? ""),
		label: String(map.get("label") ?? ""),
		cell: (map.get("cell") as CellOpts) ?? { variant: "short-text" },
	};
}

/** Build a `Y.Map` for one row: stable id + order + each column's cell value. */
function makeRowMap(
	row: DbRow,
	columns: DbColumn[],
	id: string,
	order: string
): YMap<unknown> {
	const map = new YMap<unknown>();
	map.set(ROW_ID_KEY, id);
	map.set(ROW_ORDER_KEY, order);
	// Carry the body-page link across a JSON seed (it is persisted with the row).
	if (typeof row.__page === "string" && row.__page) {
		map.set(ROW_PAGE_KEY, row.__page);
	}
	for (const column of columns) {
		map.set(
			column.id,
			row[column.id] ?? getEmptyCellValue(column.cell.variant)
		);
	}
	return map;
}

/**
 * Seed an empty doc from a plain {@link DatabaseDoc} (the JSON `source` loaded
 * from Core). Assigns each row a stable id and a strictly-increasing fractional
 * order. No-op-safe: callers must check {@link isDatabaseEmpty} first to avoid
 * double-seeding.
 */
export function seedDatabase(doc: Doc, data: DatabaseDoc): void {
	doc.transact(() => {
		const columnsArray = getColumnsArray(doc);
		// Idempotent on column id: never push a column whose stable id already exists
		// (e.g. the default "col_name"). Defense in depth so even if two seeds ever
		// raced past the server claim, react keys / tanstack column ids stay unique.
		const existingColumnIds = new Set<string>();
		for (const map of columnsArray) {
			existingColumnIds.add(String(map.get("id") ?? ""));
		}
		const freshColumns = data.columns.filter(
			(column) => !existingColumnIds.has(column.id)
		);
		columnsArray.push(freshColumns.map(makeColumnMap));

		const rowsArray = getRowsArray(doc);
		let prevOrder: string | null = null;
		const rowMaps: YMap<unknown>[] = [];
		for (const row of data.rows) {
			const order = orderKeyBetween(prevOrder, null);
			prevOrder = order;
			rowMaps.push(makeRowMap(row, data.columns, newRowId(), order));
		}
		rowsArray.push(rowMaps);

		// Seed views idempotently on id, defaulting to a single table view.
		const viewsArray = getViewsArray(doc);
		const existingViewIds = new Set<string>();
		for (const map of viewsArray) {
			existingViewIds.add(String(map.get("id") ?? ""));
		}
		const seedViews =
			data.views && data.views.length > 0 ? data.views : [defaultView()];
		viewsArray.push(
			seedViews.filter((view) => !existingViewIds.has(view.id)).map(makeViewMap)
		);
	});
}

/**
 * Derive the plain render snapshot from the authoritative doc. Rows are sorted by
 * `(__order, __id)` so every peer agrees on order even when two concurrent
 * appends share an `__order`. Each row record carries its `__id` so a later cell
 * edit can address the exact row.
 */
export function snapshotDatabase(doc: Doc): {
	columns: DbColumn[];
	rows: DbRow[];
	views: DbView[];
} {
	const columns = getColumnsArray(doc).map(readColumnMap);
	// A pre-views document has an empty views array; synthesize a table view so
	// the UI always has at least one view to render.
	const viewMaps = getViewsArray(doc);
	const views =
		viewMaps.length > 0 ? viewMaps.map(readViewMap) : [defaultView()];

	const entries: Array<{ id: string; order: string; map: YMap<unknown> }> = [];
	for (const map of getRowsArray(doc)) {
		entries.push({
			id: String(map.get(ROW_ID_KEY) ?? ""),
			order: String(map.get(ROW_ORDER_KEY) ?? ""),
			map,
		});
	}
	entries.sort((x, y) => {
		if (x.order < y.order) {
			return -1;
		}
		if (x.order > y.order) {
			return 1;
		}
		// Same fractional order (concurrent append): break the tie by stable id so
		// the result is identical on every peer.
		if (x.id < y.id) {
			return -1;
		}
		if (x.id > y.id) {
			return 1;
		}
		return 0;
	});

	const rows: DbRow[] = entries.map((entry) => {
		const row: DbRow = { __id: entry.id };
		const page = entry.map.get(ROW_PAGE_KEY);
		if (typeof page === "string" && page) {
			row.__page = page;
		}
		for (const column of columns) {
			row[column.id] = entry.map.get(column.id);
		}
		return row;
	});

	return { columns, rows, views };
}

/**
 * Subscribe to every change in the database (columns, rows, nested cell values,
 * and views) and return an unsubscribe function. Uses `observeDeep` because a cell
 * edit mutates a nested row `Y.Map` — a shallow `observe` on the rows array would
 * NOT fire for it, so remote cell edits would silently fail to re-render.
 */
export function observeDatabase(doc: Doc, callback: () => void): () => void {
	const columnsArray = getColumnsArray(doc);
	const rowsArray = getRowsArray(doc);
	const viewsArray = getViewsArray(doc);
	columnsArray.observeDeep(callback);
	rowsArray.observeDeep(callback);
	viewsArray.observeDeep(callback);
	return () => {
		columnsArray.unobserveDeep(callback);
		rowsArray.unobserveDeep(callback);
		viewsArray.unobserveDeep(callback);
	};
}

/** One cell write addressed by stable row + column id. */
export interface CellEdit {
	columnId: string;
	rowId: string;
	value: unknown;
}

/**
 * Diff a freshly-edited row array against the current snapshot and return the
 * changed cells as {@link CellEdit}s addressed by stable `__id`. The grid hands us
 * the full next array (position-preserving for cell edits); we read `__id` from
 * the row record itself so the write lands on the right row even if a concurrent
 * remote insert/delete shifted positions since the snapshot was taken.
 */
export function diffCellEdits(
	next: DbRow[],
	current: DbRow[],
	columns: DbColumn[]
): CellEdit[] {
	const edits: CellEdit[] = [];
	for (let i = 0; i < next.length; i += 1) {
		const nextRow = next[i];
		if (!nextRow) {
			continue;
		}
		const prevRow = current[i];
		const rowId = (nextRow.__id ?? prevRow?.__id) as string | undefined;
		if (!rowId) {
			continue;
		}
		for (const column of columns) {
			if (!Object.is(nextRow[column.id], prevRow?.[column.id])) {
				edits.push({ rowId, columnId: column.id, value: nextRow[column.id] });
			}
		}
	}
	return edits;
}

/**
 * Apply a batch of cell edits in a single transaction (so they ship as one
 * update). Edits whose row was concurrently deleted are silently skipped — the
 * write has nowhere to land and last-writer-wins on a live cell is handled by Yjs.
 */
export function applyCellEdits(doc: Doc, edits: CellEdit[]): void {
	if (edits.length === 0) {
		return;
	}
	doc.transact(() => {
		const byId = new Map<string, YMap<unknown>>();
		for (const map of getRowsArray(doc)) {
			byId.set(String(map.get(ROW_ID_KEY) ?? ""), map);
		}
		for (const edit of edits) {
			const map = byId.get(edit.rowId);
			if (map) {
				map.set(edit.columnId, edit.value);
			}
		}
	});
}

/** Append a new empty row after the current last row. Returns the new row id. */
export function addRow(doc: Doc, columns: DbColumn[]): string {
	const id = newRowId();
	doc.transact(() => {
		const rowsArray = getRowsArray(doc);
		const lastOrder = rowsArray.length > 0 ? lastOrderKey(rowsArray) : null;
		const order = orderKeyBetween(lastOrder, null);
		rowsArray.push([makeRowMap({}, columns, id, order)]);
	});
	return id;
}

/** The greatest `__order` currently present (rows are not stored sorted). */
function lastOrderKey(rowsArray: YArray<YMap<unknown>>): string | null {
	let max: string | null = null;
	for (const map of rowsArray) {
		const order = String(map.get(ROW_ORDER_KEY) ?? "");
		if (max === null || order > max) {
			max = order;
		}
	}
	return max;
}

/** Delete rows by stable id (in one transaction). */
export function removeRows(doc: Doc, rowIds: string[]): void {
	if (rowIds.length === 0) {
		return;
	}
	const drop = new Set(rowIds);
	doc.transact(() => {
		const rowsArray = getRowsArray(doc);
		// Walk back-to-front so deletions don't shift the indices still to visit.
		for (let i = rowsArray.length - 1; i >= 0; i -= 1) {
			const map = rowsArray.get(i);
			if (drop.has(String(map.get(ROW_ID_KEY) ?? ""))) {
				rowsArray.delete(i, 1);
			}
		}
	});
}

/** Append a column and backfill every existing row with its empty value. */
export function addColumn(doc: Doc, column: DbColumn): void {
	doc.transact(() => {
		getColumnsArray(doc).push([makeColumnMap(column)]);
		const empty = getEmptyCellValue(column.cell.variant);
		for (const map of getRowsArray(doc)) {
			map.set(column.id, empty);
		}
	});
}

/**
 * Update a column's label and/or type. Changing the type resets that column's
 * cell in every row to the new type's empty value (values rarely map across
 * types, so this is the safe choice).
 */
export function updateColumn(
	doc: Doc,
	columnId: string,
	patch: { label?: string; cell?: CellOpts }
): void {
	doc.transact(() => {
		const columnsArray = getColumnsArray(doc);
		let target: YMap<unknown> | null = null;
		let prevVariant: string | undefined;
		for (const map of columnsArray) {
			if (map.get("id") === columnId) {
				target = map;
				prevVariant = (map.get("cell") as CellOpts | undefined)?.variant;
				break;
			}
		}
		if (!target) {
			return;
		}
		if (patch.label !== undefined) {
			target.set("label", patch.label);
		}
		if (patch.cell !== undefined) {
			target.set("cell", patch.cell);
			if (patch.cell.variant !== prevVariant) {
				const empty = getEmptyCellValue(patch.cell.variant);
				for (const map of getRowsArray(doc)) {
					map.set(columnId, empty);
				}
			}
		}
	});
}

/** Append a new view. */
export function addView(doc: Doc, view: DbView): void {
	doc.transact(() => {
		getViewsArray(doc).push([makeViewMap(view)]);
	});
}

/** Update a view's name, kind, and/or group-by column. */
export function updateView(
	doc: Doc,
	viewId: string,
	patch: { name?: string; kind?: DbViewKind; groupByColumnId?: string | null }
): void {
	doc.transact(() => {
		for (const map of getViewsArray(doc)) {
			if (String(map.get("id") ?? "") === viewId) {
				if (patch.name !== undefined) {
					map.set("name", patch.name);
				}
				if (patch.kind !== undefined) {
					map.set("kind", patch.kind);
				}
				if (patch.groupByColumnId !== undefined) {
					if (patch.groupByColumnId) {
						map.set("groupByColumnId", patch.groupByColumnId);
					} else {
						map.delete("groupByColumnId");
					}
				}
				return;
			}
		}
	});
}

/** Delete a view by id. */
export function removeView(doc: Doc, viewId: string): void {
	doc.transact(() => {
		const viewsArray = getViewsArray(doc);
		for (let i = viewsArray.length - 1; i >= 0; i -= 1) {
			if (String(viewsArray.get(i).get("id") ?? "") === viewId) {
				viewsArray.delete(i, 1);
			}
		}
	});
}

/** Link a row to its body page document (sets the reserved `__page` key). */
export function setRowPageId(doc: Doc, rowId: string, pageId: string): void {
	doc.transact(() => {
		for (const map of getRowsArray(doc)) {
			if (String(map.get(ROW_ID_KEY) ?? "") === rowId) {
				map.set(ROW_PAGE_KEY, pageId);
				return;
			}
		}
	});
}

/** Remove a column and delete its cell from every row. */
export function removeColumn(doc: Doc, columnId: string): void {
	doc.transact(() => {
		const columnsArray = getColumnsArray(doc);
		for (let i = columnsArray.length - 1; i >= 0; i -= 1) {
			if (columnsArray.get(i).get("id") === columnId) {
				columnsArray.delete(i, 1);
			}
		}
		for (const map of getRowsArray(doc)) {
			map.delete(columnId);
		}
	});
}
