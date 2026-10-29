import { type ViewSourceRow, viewSourceRowSchema } from "../core/views.ts";
/* @jsxImportSource @opentui/react */
// The TERMINAL renderer for the declarative view tier — the third renderer of the
// same `ViewSpec` the desktop draws with @ryu/ui (apps/desktop DeclarativeView) and
// the island draws as a Raycast panel (@ryu/blocks island/declarative-view). The
// app returns DATA; this module owns the pixels, in the terminal's own idiom:
//
//   - one windowed, keyboard-driven list (the shape every TUI surface already has:
//     `›` selection caret, j/k + arrows, r to reload) for BOTH list-detail and
//     data-table, because a wide table with a caret IS the terminal's list;
//   - a numbered COMMAND ROW at the foot instead of buttons — `1 Complete ·
//     2 Delete` — with 1..9 firing the nth action and Enter firing the primary one.
//     That is how the rest of the TUI does interaction (single-key verbs, a hint
//     line spelling them out), so a contributed view is indistinguishable from a
//     built-in surface;
//   - the spec's `confirm` prompt as an inline y/n line, since the terminal has no
//     modal dialog in this shell.
//
// Keyboard is OWNED here in ONE handler gated on `focused` (the surface passes
// `active && focusedPaneId === paneId`), matching the shell's ownership model — an
// unfocused pane's view never reacts. Unknown view kinds and missing fields degrade
// to a readable line; a newer app must never be able to crash an older shell.
//
// This component is PURE: it fetches nothing and knows no transport. Source rows
// arrive resolved via `sourceItems` and fired actions leave through `onAction` —
// src/ui/ContributedView.tsx is the Core-backed shell around it.

import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useEffect, useMemo, useState } from "react";
import { Badge, type BadgeVariant } from "@/components/ui/badge.tsx";
import { TextInput } from "@/components/ui/text-input.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useSetInputFocused } from "../core/InputFocusContext.tsx";
import type {
	RawViewSpec,
	SourceItem,
	ViewAction,
	ViewActionContext,
	ViewBadge,
	ViewColumn,
	ViewField,
	ViewItem,
	ViewSpec,
	ViewTone,
} from "../core/views.ts";
import { validateView, viewSpecSchema } from "../core/views.ts";
import { ListPosition, SelectableRow } from "./SelectableRow.tsx";
import { useListWindow } from "./useListWindow.ts";

/** Fires when the user activates an action. The renderer supplies the context
 *  (selected `item`, collected form `values`); the shell decides what the action
 *  MEANS (the declarative http tier, or a `view.action` intent to the owning app). */
export type TuiViewActionHandler = (
	action: ViewAction,
	ctx: ViewActionContext
) => void;

export interface DeclarativeViewProps {
	/** True while this view owns the keyboard (active tab of the focused pane). */
	focused: boolean;
	onAction?: TuiViewActionHandler;
	/** `r` reloads through the shell (re-fetches the spec's source). */
	onReload?: () => void;
	/** Host-fetched rows for a `source`-declaring list-detail spec. Null/absent =
	 *  render the spec's static `items`. */
	sourceItems?: SourceItem[] | null;
	spec: ViewSpec | RawViewSpec;
}

const MAX_ACTION_KEYS = 9;
const CELL_WIDTH_CAP = 20;
const CELL_WIDTH_FLOOR = 6;

const TONE_VARIANT = {
	neutral: "secondary",
	success: "success",
	warning: "warning",
	danger: "error",
	info: "info",
} satisfies Record<ViewTone, BadgeVariant>;

/** One selectable row. list-detail and data-table both project onto this shape so
 *  selection, windowing and the command row are written once. */
interface RowModel {
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
interface ActionEntry {
	action: ViewAction;
	ctx: ViewActionContext;
}

function withCtx(
	actions: ViewAction[] | undefined,
	ctx: ViewActionContext
): ActionEntry[] {
	return (actions ?? []).map((action) => ({ action, ctx }));
}

/** A declared (non-source) item's own fields as the templating base, mirroring the
 *  island renderer so `{{item.id}}` resolves identically on every surface. */
function declaredItemRecord(item: ViewItem): ViewSourceRow {
	return viewSourceRowSchema.parse(item);
}

function rowsFromSpec(
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

function initialFormValues(fields: ViewField[]) {
	const values: Record<string, ViewField["value"]> = {};
	for (const field of fields) {
		values[field.id] = field.value ?? (field.type === "switch" ? false : "");
	}
	return values;
}

/** The digit a key press stands for (1-9), or null. OpenTUI reports a printable
 *  key on `name`, but a terminal that only fills `sequence` must work too. */
function digitFromKey(key: KeyEvent): number | null {
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

function ToneBadges({
	badges,
	color,
}: {
	badges?: ViewBadge[];
	/** Overrides the tone colors, e.g. on the selection background where the
	 *  tone colors fall below text contrast. */
	color?: string;
}) {
	if (!badges || badges.length === 0) {
		return null;
	}
	return (
		<box flexDirection="row" gap={1}>
			{badges.map((badge, i) => (
				<Badge
					bordered={false}
					color={color}
					key={`${badge.label}-${i}`}
					variant={TONE_VARIANT[badge.tone ?? "neutral"]}
				>
					{badge.label}
				</Badge>
			))}
		</box>
	);
}

function ListRow({
	row,
	selected,
	layout,
	linesPerRow,
}: {
	/** Column geometry for a data-table row; absent for a list-detail row. */
	layout?: ColumnLayout[];
	linesPerRow: number;
	row: RowModel;
	selected: boolean;
}) {
	const theme = useTheme();
	if (row.cells && layout) {
		return (
			<SelectableRow
				linesPerRow={linesPerRow}
				selected={selected}
				titleSuffix={
					row.badges?.length ? (
						<ToneBadges
							badges={row.badges}
							color={selected ? theme.colors.selectionForeground : undefined}
						/>
					) : undefined
				}
			>
				{row.cells.map((cell, i) => {
					const { align, width } = columnAt(layout, i);
					return (
						<text
							fg={
								selected
									? theme.colors.selectionForeground
									: theme.colors.foreground
							}
							flexShrink={0}
							key={`${row.id}-${i}`}
						>
							{i === 0 && selected ? (
								<b>{pad(cell, width, align)}</b>
							) : (
								pad(cell, width, align)
							)}
						</text>
					);
				})}
			</SelectableRow>
		);
	}
	return (
		<SelectableRow
			accessory={row.accessory}
			linesPerRow={linesPerRow}
			selected={selected}
			subtitle={row.subtitle}
			title={row.title}
			titleSuffix={
				row.badges?.length ? (
					<ToneBadges
						badges={row.badges}
						color={selected ? theme.colors.selectionForeground : undefined}
					/>
				) : undefined
			}
		/>
	);
}

/** The windowed row list shared by list-detail and data-table. */
function RowList({
	rows,
	selected,
	emptyText,
	layout,
}: {
	emptyText: string;
	/** Column geometry, for a data-table's aligned grid. */
	layout?: ColumnLayout[];
	rows: RowModel[];
	selected: number;
}) {
	const theme = useTheme();
	// Window the rows to the measured space so the selection stays visible
	// without a focus-capturing scrollbox (which would fight the shell for arrow
	// keys) — the same windowing the built-in list surfaces use.
	const linesPerRow = rows.some((row) => row.subtitle && !row.cells) ? 2 : 1;
	const { start, end, onSizeChange } = useListWindow({
		count: rows.length,
		index: selected,
		linesPerRow,
	});
	if (rows.length === 0) {
		return <text fg={theme.colors.mutedForeground}>{emptyText}</text>;
	}
	const visible = rows.slice(start, end);
	return (
		<>
			<box
				flexBasis={0}
				flexDirection="column"
				flexGrow={1}
				minHeight={0}
				onSizeChange={onSizeChange}
				overflow="hidden"
			>
				{visible.map((row, i) => (
					<ListRow
						key={row.id}
						layout={layout}
						linesPerRow={linesPerRow}
						row={row}
						selected={start + i === selected}
					/>
				))}
			</box>
			<ListPosition
				count={rows.length}
				index={selected}
				visible={visible.length}
			/>
		</>
	);
}

/** Fit `value` to `width`, truncating with an ellipsis when it overflows and
 *  padding to the column's declared alignment otherwise. `align` is the vocabulary's
 *  {@link ViewColumn.align}, which the desktop honours through a Tailwind text-align
 *  class; a monospace grid is where it matters most (a right-aligned numeric column
 *  is the whole reason the field exists), so it is honoured here too rather than
 *  silently dropped. */
function pad(value: string, width: number, align: CellAlign = "left"): string {
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

type CellAlign = NonNullable<ViewColumn["align"]>;

/** One data-table column's drawn geometry, shared by the header and every row so
 *  the grid lines up. */
interface ColumnLayout {
	align: CellAlign;
	width: number;
}

/** Layout for a data-table's columns: the width is the widest of header/cells,
 *  capped so a chatty column cannot push the rest off a narrow terminal. */
function columnLayout(
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
function columnAt(layout: ColumnLayout[] | undefined, i: number): ColumnLayout {
	return layout?.[i] ?? { align: "left", width: CELL_WIDTH_FLOOR };
}

function TableHeader({
	spec,
	layout,
}: {
	layout: ColumnLayout[];
	spec: Extract<ViewSpec, { view: "data-table" }>;
}) {
	const theme = useTheme();
	return (
		<box flexDirection="row" flexShrink={0} gap={1} paddingLeft={2}>
			{spec.columns.map((column, i) => {
				const { align, width } = columnAt(layout, i);
				return (
					<text fg={theme.colors.mutedForeground} key={column.id}>
						{pad(column.header, width, align)}
					</text>
				);
			})}
		</box>
	);
}

/** One compact form field row. Text/number fields swap to an inline TextInput
 *  while being edited (the vendored input owns character keys for that window). */
function FormRow({
	editing,
	field,
	onChange,
	onCommit,
	selected,
	value,
}: {
	editing: boolean;
	field: ViewField;
	onChange: (next: string) => void;
	onCommit: (next: string) => void;
	selected: boolean;
	value: ViewField["value"];
}) {
	const theme = useTheme();
	const display =
		field.type === "switch" ? boolLabel(value) : String(value ?? "");
	return (
		<box flexDirection="row" gap={1}>
			<text fg={selected ? theme.colors.primary : theme.colors.mutedForeground}>
				{selected ? "›" : " "}
			</text>
			<text fg={theme.colors.mutedForeground}>{pad(field.label, 18)}</text>
			{editing ? (
				<TextInput
					bordered={false}
					onChange={onChange}
					onSubmit={onCommit}
					placeholder={field.placeholder}
					value={display}
					width={32}
				/>
			) : (
				<text fg={theme.colors.foreground}>
					{display.length > 0 ? display : "—"}
				</text>
			)}
		</box>
	);
}

function boolLabel(value: ViewField["value"]): string {
	return value === true ? "on" : "off";
}

/** The foot command row: `1 Complete · 2 Delete`, plus the navigation hints. A
 *  pending `confirm` replaces it with an inline y/n prompt. */
function CommandRow({
	confirmText,
	entries,
	hints,
}: {
	confirmText: string | null;
	entries: ActionEntry[];
	hints: string;
}) {
	const theme = useTheme();
	if (confirmText) {
		return (
			<box flexDirection="row" flexShrink={0} gap={1} paddingTop={1}>
				<text fg={theme.colors.warning}>{confirmText}</text>
				<text fg={theme.colors.mutedForeground}>y confirm · n cancel</text>
			</box>
		);
	}
	return (
		<box flexDirection="row" flexShrink={0} gap={1} paddingTop={1}>
			{entries.slice(0, MAX_ACTION_KEYS).map((entry, i) => (
				<text
					fg={
						entry.action.style === "danger"
							? theme.colors.error
							: theme.colors.foreground
					}
					key={entry.action.id}
				>
					{`${i + 1} ${entry.action.label}`}
				</text>
			))}
			<text fg={theme.colors.mutedForeground}>{hints}</text>
		</box>
	);
}

/** Body of a kind that has no rows and no fields — rendered inline so the outer
 *  component stays a single switch over the discriminant. */
function StaticBody({ spec }: { spec: ViewSpec }) {
	const theme = useTheme();
	if (spec.view === "empty-state") {
		return (
			<box flexDirection="column">
				<text fg={theme.colors.foreground}>{spec.title}</text>
				{spec.description ? (
					<text fg={theme.colors.mutedForeground}>{spec.description}</text>
				) : null}
			</box>
		);
	}
	if (spec.view === "filter-bar") {
		return (
			<box flexDirection="column">
				{spec.filters.map((filter) => (
					<box flexDirection="row" gap={1} key={filter.id}>
						<text fg={theme.colors.mutedForeground}>
							{pad(filter.label, 18)}
						</text>
						<text fg={theme.colors.foreground}>
							{filter.options
								.map((option) =>
									option.value === filter.value
										? `[${option.label}]`
										: option.label
								)
								.join(" ")}
						</text>
					</box>
				))}
			</box>
		);
	}
	if (spec.view === "stat-card-row") {
		return (
			<box flexDirection="row" gap={2}>
				{spec.stats.map((stat) => (
					<box flexDirection="column" key={stat.id}>
						<text fg={theme.colors.mutedForeground}>{stat.label}</text>
						<text fg={theme.colors.foreground}>
							<b>{String(stat.value)}</b>
						</text>
						{stat.delta ? (
							<text fg={theme.colors.mutedForeground}>{stat.delta}</text>
						) : null}
					</box>
				))}
			</box>
		);
	}
	if (spec.view === "action-panel") {
		return spec.title ? (
			<text fg={theme.colors.foreground}>{spec.title}</text>
		) : null;
	}
	return <UnsupportedBody spec={spec} />;
}

/**
 * The readable degrade for a spec this shell cannot draw. Two ways in, one line out:
 *  - an UNKNOWN `view` kind — Core forwards new kinds verbatim so a newer app can
 *    target an older shell, and saying so plainly beats rendering nothing;
 *  - a KNOWN kind missing the collection it is made of (`list-detail` with no
 *    `items`, `data-table` with no `columns`, …). The `spec` is opaque to Core, so
 *    that shape reaches the renderer from any manifest; trusting the discriminant
 *    alone would dereference `undefined` and take the whole terminal down through the
 *    root error boundary. `errors` is `validateView`'s explanation, shown so a
 *    plugin author can see WHY their view did not draw.
 */
function UnsupportedBody({
	spec,
	errors,
}: {
	spec: Pick<RawViewSpec, "view"> | undefined;
	errors?: string[];
}) {
	const theme = useTheme();
	const kind = String(spec?.view ?? "unknown");
	return (
		<box flexDirection="column">
			<text fg={theme.colors.mutedForeground}>
				{`Unsupported view kind "${kind}" — open it in the desktop app.`}
			</text>
			{errors && errors.length > 0 ? (
				<text fg={theme.colors.mutedForeground}>{errors.join("; ")}</text>
			) : null}
		</box>
	);
}

/** Render a {@link ViewSpec} in the terminal idiom. */
export function DeclarativeView({
	focused,
	onAction,
	onReload,
	sourceItems,
	spec: rawSpec,
}: DeclarativeViewProps) {
	const setInputFocused = useSetInputFocused();
	// The structural gate every renderer of this vocabulary runs (the desktop's
	// DeclarativeView does the same before its switch). `spec` is opaque to Core, so
	// a known kind can still arrive without the collection it is made of; every
	// projection below assumes those arrays exist, and a terminal has no per-pane
	// error boundary to absorb the throw. Validate ONCE, then draw nothing that
	// dereferences an unvalidated field.
	const validation = useMemo(() => validateView(rawSpec), [rawSpec]);
	const parsedSpec = useMemo(
		() => viewSpecSchema.safeParse(rawSpec),
		[rawSpec]
	);
	const spec = parsedSpec.success ? parsedSpec.data : undefined;
	const renderable = validation.ok && spec !== undefined;
	const [index, setIndex] = useState(0);
	// Guarded independently of `renderable`: a state initializer runs before the
	// early return, so it may not assume the spec validated.
	const [values, setValues] = useState<Record<string, ViewField["value"]>>(
		() =>
			spec?.view === "form" && Array.isArray(spec.fields)
				? initialFormValues(spec.fields)
				: {}
	);
	const [editingField, setEditingField] = useState<string | null>(null);
	const [pending, setPending] = useState<ActionEntry | null>(null);

	const rows = useMemo(
		() => (renderable ? rowsFromSpec(spec, sourceItems) : []),
		[renderable, spec, sourceItems]
	);
	const isForm = renderable && spec.view === "form";
	const fields = isForm ? spec.fields : [];
	const count = isForm ? fields.length : rows.length;
	const selected = count === 0 ? 0 : Math.min(index, count - 1);
	const selectedRow = rows[selected];
	const selectedField = fields[selected];

	// Claim raw input while an inline field editor is open so the shell's plain-key
	// bindings stay quiet (the chat composer precedent).
	useEffect(() => {
		setInputFocused(focused && editingField !== null);
		return () => setInputFocused(false);
	}, [focused, editingField, setInputFocused]);

	const entries = useMemo<ActionEntry[]>(
		() => (renderable ? actionEntries(spec, selectedRow, values) : []),
		[renderable, spec, selectedRow, values]
	);

	// Column geometry is shared by the header and the rows so the grid lines up.
	const layout = useMemo(
		() =>
			renderable && spec.view === "data-table" ? columnLayout(spec) : undefined,
		[renderable, spec]
	);

	const fire = (entry: ActionEntry) => {
		if (entry.action.confirm) {
			setPending(entry);
			return;
		}
		onAction?.(entry.action, entry.ctx);
	};

	// Confirm gate: the spec-declared destructive-action prompt, inline. Returns
	// true when the key was consumed by the prompt.
	const handleConfirmKey = (key: KeyEvent): boolean => {
		if (!pending) {
			return false;
		}
		if (key.name === "y") {
			onAction?.(pending.action, pending.ctx);
		}
		if (key.name === "y" || key.name === "n" || key.name === "escape") {
			setPending(null);
		}
		return true;
	};

	// Form-only edits: space toggles a switch, ←/→ cycle a select, `e` opens the
	// inline editor for a text/number field.
	const handleFieldKey = (key: KeyEvent): boolean => {
		if (!selectedField) {
			return false;
		}
		if (selectedField.type === "switch" && key.name === "space") {
			setValues((prev) => ({
				...prev,
				[selectedField.id]: prev[selectedField.id] !== true,
			}));
			return true;
		}
		if (
			selectedField.type === "select" &&
			(key.name === "left" || key.name === "right")
		) {
			setValues((prev) => ({
				...prev,
				[selectedField.id]: cycleOption(
					selectedField,
					prev[selectedField.id],
					key.name === "right" ? 1 : -1
				),
			}));
			return true;
		}
		if (key.name === "e" && isEditable(selectedField)) {
			setEditingField(selectedField.id);
			return true;
		}
		return false;
	};

	useKeyboard((key) => {
		if (!focused) {
			return;
		}
		if (editingField) {
			// The inline TextInput owns character keys for this window; Esc backs out.
			if (key.name === "escape") {
				setEditingField(null);
			}
			return;
		}
		if (handleConfirmKey(key)) {
			return;
		}
		if (key.name === "up" || key.name === "k") {
			setIndex((i) => Math.max(0, i - 1));
			return;
		}
		if (key.name === "down" || key.name === "j") {
			setIndex((i) => Math.min(Math.max(0, count - 1), i + 1));
			return;
		}
		if (key.name === "r") {
			onReload?.();
			return;
		}
		if (handleFieldKey(key)) {
			return;
		}
		const digit = digitFromKey(key);
		if (digit !== null) {
			const entry = entries[digit - 1];
			if (entry) {
				fire(entry);
			}
			return;
		}
		if (key.name === "return") {
			const primary =
				entries.find((entry) => entry.action.style === "primary") ?? entries[0];
			if (primary) {
				fire(primary);
			}
		}
	});

	// Placed AFTER every hook so the hook order is identical whether or not the spec
	// validates (a reload can hand this component a different spec).
	if (!renderable) {
		return <UnsupportedBody errors={validation.errors} spec={rawSpec} />;
	}

	return (
		<box flexDirection="column" flexGrow={1} minHeight={0}>
			{spec.view === "data-table" && layout ? (
				<TableHeader layout={layout} spec={spec} />
			) : null}
			{spec.view === "list-detail" || spec.view === "data-table" ? (
				<RowList
					emptyText={spec.emptyText ?? "Nothing here yet."}
					layout={layout}
					rows={rows}
					selected={selected}
				/>
			) : null}
			{spec.view === "form"
				? fields.map((field, i) => (
						<FormRow
							editing={editingField === field.id}
							field={field}
							key={field.id}
							onChange={(next) => {
								setValues((prev) => ({ ...prev, [field.id]: next }));
							}}
							onCommit={(next) => {
								setValues((prev) => ({
									...prev,
									[field.id]: field.type === "number" ? Number(next) : next,
								}));
								setEditingField(null);
							}}
							selected={i === selected}
							value={values[field.id]}
						/>
					))
				: null}
			{spec.view === "list-detail" ||
			spec.view === "data-table" ||
			spec.view === "form" ? null : (
				<StaticBody spec={spec} />
			)}
			<CommandRow
				confirmText={pending?.action.confirm ?? null}
				entries={entries}
				hints={hintsFor(spec, entries.length > 0)}
			/>
		</box>
	);
}

/** True for the field types the inline editor can edit (a select cycles and a
 *  switch toggles instead). */
function isEditable(field: ViewField): boolean {
	return (
		field.type === "text" ||
		field.type === "textarea" ||
		field.type === "number"
	);
}

function cycleOption(
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
function actionEntries(
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
function hintsFor(spec: ViewSpec, hasActions: boolean): string {
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
