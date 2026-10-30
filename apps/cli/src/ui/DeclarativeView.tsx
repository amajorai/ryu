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
import { useSetInputFocused } from "../core/InputFocusContext.tsx";
import type {
	RawViewSpec,
	SourceItem,
	ViewAction,
	ViewActionContext,
	ViewField,
	ViewSpec,
} from "../core/views.ts";
import { validateView, viewSpecSchema } from "../core/views.ts";
import {
	type ActionEntry,
	actionEntries,
	columnLayout,
	cycleOption,
	digitFromKey,
	hintsFor,
	initialFormValues,
	isEditable,
	rowsFromSpec,
} from "./DeclarativeView-model.ts";
import {
	CommandRow,
	FormRow,
	RowList,
	StaticBody,
	TableHeader,
	UnsupportedBody,
} from "./DeclarativeView-rows.tsx";

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
