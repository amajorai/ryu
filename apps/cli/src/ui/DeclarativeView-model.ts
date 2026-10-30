// Pure model helpers for the terminal declarative-view renderer
// (DeclarativeView.tsx): row projection, column geometry, action entries and hints.

import type { KeyEvent } from "@opentui/core";
import type {
	SourceItem,
	ViewAction,
	ViewActionContext,
	ViewBadge,
	ViewColumn,
	ViewField,
	ViewItem,
	ViewSourceRow,
	ViewSpec,
} from "../core/views.ts";
import { viewSourceRowSchema } from "../core/views.ts";

export const MAX_ACTION_KEYS = 9;
export const CELL_WIDTH_CAP = 20;
export const CELL_WIDTH_FLOOR = 6;

/** One selectable row. list-detail and data-table both project onto this shape so
 *  selection, windowing and the command row are written once. */
export interface RowModel {
	accessory?: string;
	actions?: ViewAction[];
	badges?: ViewBadge[];
	/** Column-ordered cell text — set for data-table rows only, so they draw as an
	 *  aligned grid under the header instead of the list's title/subtitle stack. */
	cells?: string[];
	id: string;
	/** The `{{item.<key>}}` templating base for actions fired on this row. */
	item: ViewSourceRow;
	subtitle?: string;
	title: string;
}

/** One entry of the command row: the action plus the context it fires with. */
export interface ActionEntry {
	action: ViewAction;
	ctx: ViewActionContext;
}

export function withCtx(
	actions: ViewAction[] | undefined,
	ctx: ViewActionContext
): ActionEntry[] {
	return (actions ?? []).map((action) => ({ action, ctx }));
}

/** A declared (non-source) item's own fields as the templating base, mirroring the
 *  island renderer so `{{item.id}}` resolves identically on every surface. */
export function declaredItemRecord(item: ViewItem): ViewSourceRow {
	return viewSourceRowSchema.parse(item);
}

export function rowsFromSpec(
	spec: ViewSpec,
	sourceItems: SourceItem[] | null | undefined
): RowModel[] {
	if (spec.view === "list-detail") {
		const resolved =
			sourceItems ??
			spec.items.map((item) => ({ item, raw: declaredItemRecord(item) }));
		return resolved.map(({ item, raw }) => ({
			id: item.id,
			title: item.title,
			subtitle: item.subtitle ?? item.detail,
			accessory: item.accessory,
			badges: item.badges,
			actions: item.actions,
			item: raw,
		}));
	}
	if (spec.view === "data-table") {
		const [first] = spec.columns;
		return spec.rows.map((row) => ({
			id: row.id,
			// The first column doubles as the row's title (what a narrow terminal
			// falls back to); `cells` carries the full column-ordered text.
			title: first ? String(row.cells[first.id] ?? "") : row.id,
			cells: spec.columns.map((column) => String(row.cells[column.id] ?? "")),
			badges: row.badges,
			actions: row.actions,
			item: { id: row.id, ...row.cells },
		}));
	}
	return [];
}

export function initialFormValues(fields: ViewField[]) {
	const values: Record<string, ViewField["value"]> = {};
	for (const field of fields) {
		values[field.id] = field.value ?? (field.type === "switch" ? false : "");
	}
	return values;
}

/** The digit a key press stands for (1-9), or null. OpenTUI reports a printable
 *  key on `name`, but a terminal that only fills `sequence` must work too. */
export function digitFromKey(key: KeyEvent): number | null {
	// Alt+1…9 is the shell's jump-to-tab chord; only a plain digit fires.
	if (key.ctrl || key.meta || key.option) {
		return null;
	}
	const char = key.name?.length === 1 ? key.name : (key.sequence ?? "");
	if (char.length !== 1 || char < "1" || char > "9") {
		return null;
	}
	return Number(char);
}

/** Fit `value` to `width`, truncating with an ellipsis when it overflows and
 *  padding to the column's declared alignment otherwise. `align` is the vocabulary's
 *  {@link ViewColumn.align}, which the desktop honours through a Tailwind text-align
 *  class; a monospace grid is where it matters most (a right-aligned numeric column
 *  is the whole reason the field exists), so it is honoured here too rather than
 *  silently dropped. */
export function pad(
	value: string,
	width: number,
	align: CellAlign = "left"
): string {
	if (value.length > width) {
		return `${value.slice(0, Math.max(1, width - 1))}…`;
	}
	if (align === "right") {
		return value.padStart(width);
	}
	if (align === "center") {
		const left = Math.floor((width - value.length) / 2);
		return value.padStart(value.length + left).padEnd(width);
	}
	return value.padEnd(width);
}

export type CellAlign = NonNullable<ViewColumn["align"]>;

/** One data-table column's drawn geometry, shared by the header and every row so
 *  the grid lines up. */
export interface ColumnLayout {
	align: CellAlign;
	width: number;
}

/** Layout for a data-table's columns: the width is the widest of header/cells,
 *  capped so a chatty column cannot push the rest off a narrow terminal. */
export function columnLayout(
	spec: Extract<ViewSpec, { view: "data-table" }>
): ColumnLayout[] {
	return spec.columns.map((column) => {
		let width = column.header.length;
		for (const row of spec.rows) {
			width = Math.max(width, String(row.cells[column.id] ?? "").length);
		}
		return {
			align: column.align ?? "left",
			width: Math.min(CELL_WIDTH_CAP, Math.max(CELL_WIDTH_FLOOR, width)),
		};
	});
}

/** The layout of column `i`, or a left-aligned floor width when the spec declares
 *  fewer columns than a row has cells. */
export function columnAt(
	layout: ColumnLayout[] | undefined,
	i: number
): ColumnLayout {
	return layout?.[i] ?? { align: "left", width: CELL_WIDTH_FLOOR };
}

export function boolLabel(value: ViewField["value"]): string {
	return value === true ? "on" : "off";
}

/** True for the field types the inline editor can edit (a select cycles and a
 *  switch toggles instead). */
export function isEditable(field: ViewField): boolean {
	return (
		field.type === "text" ||
		field.type === "textarea" ||
		field.type === "number"
	);
}

export function cycleOption(
	field: ViewField,
	current: ViewField["value"],
	direction: 1 | -1
): string {
	const options = field.options ?? [];
	if (options.length === 0) {
		return String(current ?? "");
	}
	const at = options.findIndex((option) => option.value === current);
	const next = (at + direction + options.length) % options.length;
	return options[next]?.value ?? String(current ?? "");
}

/** The action entries offered for the current selection, in command-row order:
 *  the row's own actions, then the spec's per-item actions, then its global ones.
 *  Each carries the context it fires with so `{{…}}` templating resolves upstream. */
export function actionEntries(
	spec: ViewSpec,
	selectedRow: RowModel | undefined,
	values: Record<string, ViewField["value"]>
): ActionEntry[] {
	const item = selectedRow?.item;
	if (spec.view === "list-detail") {
		return [
			...withCtx(selectedRow?.actions, { item }),
			...(selectedRow ? withCtx(spec.itemActions, { item }) : []),
			...withCtx(spec.actions, { item }),
		];
	}
	if (spec.view === "data-table") {
		return [
			...withCtx(selectedRow?.actions, { item }),
			...withCtx(spec.actions, { item }),
		];
	}
	if (spec.view === "form") {
		return [
			...withCtx(spec.submit ? [spec.submit] : undefined, { values }),
			...withCtx(spec.actions, { values }),
		];
	}
	if (spec.view === "action-panel") {
		return withCtx(spec.actions, {});
	}
	if (spec.view === "empty-state") {
		return withCtx(spec.action ? [spec.action] : undefined, {});
	}
	return [];
}

/** The trailing hint text, matching the verb list each kind actually binds. */
export function hintsFor(spec: ViewSpec, hasActions: boolean): string {
	const parts: string[] = [];
	if (spec.view === "list-detail" || spec.view === "data-table") {
		parts.push("↑↓ move");
	}
	if (spec.view === "form") {
		parts.push("↑↓ field", "e edit", "space toggle", "←→ option");
	}
	if (hasActions) {
		parts.push("1-9 run", "Enter primary");
	}
	parts.push("r reload");
	return `· ${parts.join(" · ")}`;
}
