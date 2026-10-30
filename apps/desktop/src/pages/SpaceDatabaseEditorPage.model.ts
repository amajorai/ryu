import type { CellOpts } from "@ryu/ui/types/data-grid.ts";
import type {
	DbColumn,
	DbRow,
	DbViewKind,
} from "@/src/lib/realtime/yjs-database.ts";

export const SAVE_DEBOUNCE_MS = 800;

export const DEFAULT_GRID_HEIGHT = 480;

export type SaveState = "idle" | "saving" | "saved" | "error";

export const SAVE_LABEL = {
	idle: "",
	saving: "Saving…",
	saved: "Saved",
	error: "Saved on this device",
} satisfies Record<SaveState, string>;

/** A sensible default name for a freshly-added view of the given kind. */
export function defaultViewName(kind: DbViewKind): string {
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
export type ColumnEditorState =
	| { mode: "create" }
	| {
			mode: "edit";
			columnId: string;
			initial: { label: string; cell: CellOpts };
	  }
	| null;

/**
 * The grid edits rows that carry computed formula values; put back what is
 * stored for formula columns (matched by row id) so results are never saved.
 */
export function withStoredFormulaValues(
	next: DbRow[],
	stored: DbRow[],
	columns: DbColumn[]
): DbRow[] {
	const formulaIds = columns
		.filter((column) => column.cell.variant === "formula")
		.map((column) => column.id);
	if (formulaIds.length === 0) {
		return next;
	}
	const storedById = new Map(stored.map((row) => [row.__id, row]));
	return next.map((row) => {
		const original = storedById.get(row.__id);
		const restored: DbRow = { ...row };
		for (const id of formulaIds) {
			restored[id] = original?.[id] ?? "";
		}
		return restored;
	});
}

/** Drop the reserved collaborative `__id` from rows before serializing to JSON. */
export function stripRowIds(rows: DbRow[]): DbRow[] {
	return rows.map(({ __id, ...rest }) => rest);
}
