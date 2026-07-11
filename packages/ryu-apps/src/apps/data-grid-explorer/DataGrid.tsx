// Data Grid Explorer widget (spec §6 app 3). A sortable / filterable / column-
// hideable, hand-windowed (virtualized) multi-select grid.
//
// Data model (D-decisions + spec §6):
//   - `toolOutput` (structuredContent) is the MODEL-visible summary:
//     { columns, primary_key, row_count, summary } — small, no bulk rows.
//   - `toolResponseMetadata` (_meta) carries the FULL rows (widget-only) so big data
//     never enters model context. We read rows from there, falling back defensively.
//   - All client UI (sort / filter / hidden columns / selection / inline edits) lives
//     in `widgetState`, persisted host-side via `window.ryu.setWidgetState` (D4).
//
// Companion actions:
//   - "Apply" a named action to the selected rows -> `window.ryu.callTool`
//     ('table__act_on_rows', { selected_keys, action }) (Gateway-governed, D5).
//   - "Send to chat" hands the selection back to the model via
//     `window.ryu.sendFollowUpMessage`.
//   - Inline cell edits (when `editable`) persist optimistically to `widgetState`
//     and best-effort through `callTool`.

import {
	type CSSProperties,
	type KeyboardEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { WidgetRpcError } from "../../shared/bridge";
import { useRyuGlobal } from "../../shared/useRyuGlobal";

/** Wire tool id for the companion mutation tool: `<server>__<name>` (server=`table`). */
const ACT_ON_ROWS_TOOL = "table__act_on_rows";

/** Windowing constants (hand-rolled virtualization — no heavy deps). */
const ROW_HEIGHT = 36;
const HEAD_HEIGHT = 38;
const VIEWPORT_MAX = 440;
const OVERSCAN = 6;
const CHECK_COL_WIDTH = 40;
const DEFAULT_COL_WIDTH = 160;

/** Stable keys for the loading skeleton rows (avoids array-index keys). */
const SKELETON_ROWS = ["sk-a", "sk-b", "sk-c", "sk-d", "sk-e"] as const;

type ColumnType = "string" | "number" | "date" | "boolean" | string;

interface GridColumn {
	key: string;
	label: string;
	type: ColumnType;
}

type GridRow = Record<string, unknown>;

/** structuredContent shape (model-visible summary). */
interface TableOutput {
	columns?: GridColumn[];
	primary_key?: string;
	row_count?: number;
	editable?: boolean;
	summary?: unknown;
}

type SortDir = "asc" | "desc";

interface SortState {
	key: string;
	dir: SortDir;
}

/** Everything persisted in `widgetState` (D4). */
interface UiState {
	sort: SortState | null;
	filter: string;
	columnFilters: Record<string, string>;
	hiddenColumns: string[];
	selectedKeys: string[];
	filtersVisible: boolean;
	edits: Record<string, Record<string, unknown>>;
}

const DEFAULT_UI: UiState = {
	sort: null,
	filter: "",
	columnFilters: {},
	hiddenColumns: [],
	selectedKeys: [],
	filtersVisible: false,
	edits: {},
};

// ---- pure helpers (kept module-level to hold down component complexity) ----

/** Read the full rows array from `_meta`, tolerating a few plausible shapes. */
function extractRows(
	meta: unknown,
	output: TableOutput | undefined,
): GridRow[] {
	if (Array.isArray(meta)) {
		return meta as GridRow[];
	}
	if (meta && typeof meta === "object") {
		const record = meta as Record<string, unknown>;
		if (Array.isArray(record.rows)) {
			return record.rows as GridRow[];
		}
		if (record.table && typeof record.table === "object") {
			const nested = (record.table as Record<string, unknown>).rows;
			if (Array.isArray(nested)) {
				return nested as GridRow[];
			}
		}
	}
	if (output && Array.isArray((output as Record<string, unknown>).rows)) {
		return (output as Record<string, unknown>).rows as GridRow[];
	}
	return [];
}

/** Derive columns from the first row when the tool omitted them. */
function deriveColumns(rows: GridRow[]): GridColumn[] {
	const first = rows[0];
	if (!first) {
		return [];
	}
	return Object.keys(first).map((key) => ({
		key,
		label: key,
		type: typeof first[key] === "number" ? "number" : "string",
	}));
}

function cellToString(value: unknown): string {
	if (value === null || value === undefined) {
		return "";
	}
	if (typeof value === "object") {
		return JSON.stringify(value);
	}
	return String(value);
}

function compareCells(a: unknown, b: unknown, type: ColumnType): number {
	const aEmpty = a === null || a === undefined || a === "";
	const bEmpty = b === null || b === undefined || b === "";
	if (aEmpty && bEmpty) {
		return 0;
	}
	if (aEmpty) {
		return 1;
	}
	if (bEmpty) {
		return -1;
	}
	if (type === "number") {
		return Number(a) - Number(b);
	}
	if (type === "date") {
		return Date.parse(cellToString(a)) - Date.parse(cellToString(b));
	}
	if (type === "boolean") {
		return Number(Boolean(a)) - Number(Boolean(b));
	}
	return cellToString(a).localeCompare(cellToString(b), undefined, {
		numeric: true,
	});
}

/** Coerce an edited string back toward the column's declared type. */
function coerceEdit(raw: string, type: ColumnType): unknown {
	if (type === "number") {
		const n = Number(raw);
		return raw.trim() === "" || Number.isNaN(n) ? raw : n;
	}
	if (type === "boolean") {
		return raw.trim().toLowerCase() === "true";
	}
	return raw;
}

function ChevronIcon({ dir }: { dir: SortDir | null }) {
	if (dir === null) {
		return (
			<svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
				<title>unsorted</title>
				<path
					d="M8 9l4-4 4 4M8 15l4 4 4-4"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					opacity="0.4"
				/>
			</svg>
		);
	}
	return (
		<svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
			<title>{dir === "asc" ? "ascending" : "descending"}</title>
			<path
				d={dir === "asc" ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"}
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

function SearchIcon() {
	return (
		<svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
			<title>search</title>
			<circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
			<path
				d="M21 21l-4.3-4.3"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
			/>
		</svg>
	);
}

export function DataGrid() {
	const output = useRyuGlobal("toolOutput") as TableOutput | undefined;
	const meta = useRyuGlobal("toolResponseMetadata");
	const input = useRyuGlobal("toolInput") as { page_size?: number } | undefined;
	const persisted = useRyuGlobal("widgetState") as Partial<UiState> | undefined;

	const rootRef = useRef<HTMLDivElement>(null);
	const viewportRef = useRef<HTMLDivElement>(null);
	const hydrated = useRef(false);
	const columnsMenuRef = useRef<HTMLDivElement>(null);

	const [ui, setUi] = useState<UiState>(DEFAULT_UI);
	// Mirror of `ui` read synchronously by `applyUi` so the persist call lives
	// OUTSIDE the state updater (updaters must be pure; StrictMode double-invokes them).
	const uiRef = useRef<UiState>(DEFAULT_UI);
	uiRef.current = ui;
	const [scrollTop, setScrollTop] = useState(0);
	const [viewportHeight, setViewportHeight] = useState(VIEWPORT_MAX);
	const [editing, setEditing] = useState<{ key: string; col: string } | null>(
		null,
	);
	const [actionName, setActionName] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [columnsOpen, setColumnsOpen] = useState(false);

	// The requested page size (rows per viewport) caps the windowed viewport height;
	// virtualization renders only the visible slice regardless of total row count.
	const pageSize =
		typeof input?.page_size === "number" && input.page_size > 0
			? input.page_size
			: null;
	const viewportCap = pageSize ? pageSize * ROW_HEIGHT : VIEWPORT_MAX;

	// Hydrate UI state from the host-persisted snapshot exactly once.
	useEffect(() => {
		if (!hydrated.current && persisted && typeof persisted === "object") {
			hydrated.current = true;
			const next = { ...DEFAULT_UI, ...persisted };
			uiRef.current = next;
			setUi(next);
		}
	}, [persisted]);

	/** Update UI state locally and persist it host-side (optimistic, D4). The
	 *  persist call is kept out of the `setUi` updater so it never double-fires. */
	const applyUi = useCallback((updater: (prev: UiState) => UiState) => {
		const next = updater(uiRef.current);
		uiRef.current = next;
		setUi(next);
		void window.ryu?.setWidgetState(next);
	}, []);

	const rawRows = useMemo(() => extractRows(meta, output), [meta, output]);
	const editable = output?.editable === true;

	const columns = useMemo<GridColumn[]>(() => {
		const declared = output?.columns;
		if (Array.isArray(declared) && declared.length > 0) {
			return declared;
		}
		return deriveColumns(rawRows);
	}, [output, rawRows]);

	const primaryKey = useMemo<string>(() => {
		if (output?.primary_key) {
			return output.primary_key;
		}
		return columns[0]?.key ?? "__index";
	}, [output, columns]);

	const rowKey = useCallback(
		(row: GridRow, index: number): string => {
			const value = row[primaryKey];
			return value === undefined || value === null
				? `__row_${index}`
				: String(value);
		},
		[primaryKey],
	);

	/** Apply persisted inline edits over the base rows. */
	const editedRows = useMemo<GridRow[]>(() => {
		if (Object.keys(ui.edits).length === 0) {
			return rawRows;
		}
		return rawRows.map((row, index) => {
			const patch = ui.edits[rowKey(row, index)];
			return patch ? { ...row, ...patch } : row;
		});
	}, [rawRows, ui.edits, rowKey]);

	const visibleColumns = useMemo(
		() => columns.filter((col) => !ui.hiddenColumns.includes(col.key)),
		[columns, ui.hiddenColumns],
	);

	// Filter (global + per-column), then sort. Keys are computed once per row.
	const filteredRows = useMemo(() => {
		const term = ui.filter.trim().toLowerCase();
		const colFilterEntries = Object.entries(ui.columnFilters).filter(
			([, value]) => value.trim() !== "",
		);
		const withKeys = editedRows.map((row, index) => ({
			row,
			key: rowKey(row, index),
		}));
		const matched = withKeys.filter(({ row }) => {
			if (
				term &&
				!visibleColumns.some((col) =>
					cellToString(row[col.key]).toLowerCase().includes(term),
				)
			) {
				return false;
			}
			for (const [colKey, value] of colFilterEntries) {
				if (
					!cellToString(row[colKey]).toLowerCase().includes(value.toLowerCase())
				) {
					return false;
				}
			}
			return true;
		});
		if (ui.sort) {
			const sortCol = columns.find((col) => col.key === ui.sort?.key);
			if (sortCol) {
				const dir = ui.sort.dir === "asc" ? 1 : -1;
				matched.sort(
					(a, b) =>
						dir *
						compareCells(a.row[sortCol.key], b.row[sortCol.key], sortCol.type),
				);
			}
		}
		return matched;
	}, [
		editedRows,
		ui.filter,
		ui.columnFilters,
		ui.sort,
		visibleColumns,
		columns,
		rowKey,
	]);

	const selectedSet = useMemo(
		() => new Set(ui.selectedKeys),
		[ui.selectedKeys],
	);

	// Windowing math.
	const totalHeight = filteredRows.length * ROW_HEIGHT;
	const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
	const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
	const endIndex = Math.min(filteredRows.length, startIndex + visibleCount);
	const windowRows = filteredRows.slice(startIndex, endIndex);

	const gridWidth = CHECK_COL_WIDTH + visibleColumns.length * DEFAULT_COL_WIDTH;
	const clampedViewport = Math.min(
		viewportCap,
		Math.max(totalHeight, ROW_HEIGHT),
	);

	useLayoutEffect(() => {
		setViewportHeight(clampedViewport);
	}, [clampedViewport]);

	// Report intrinsic content height to the host whenever the rendered widget
	// resizes (filters toggled, columns hidden, selection bar shown, etc.). A
	// ResizeObserver on the root catches every layout change without enumerating deps.
	useLayoutEffect(() => {
		const el = rootRef.current;
		if (!el || typeof ResizeObserver === "undefined") {
			return;
		}
		const report = () =>
			window.ryu?.notifyIntrinsicHeight(Math.ceil(el.scrollHeight));
		const observer = new ResizeObserver(report);
		observer.observe(el);
		report();
		return () => observer.disconnect();
	}, []);

	// Close the columns menu on outside click.
	useEffect(() => {
		if (!columnsOpen) {
			return;
		}
		const onDown = (event: MouseEvent) => {
			if (!columnsMenuRef.current?.contains(event.target as Node)) {
				setColumnsOpen(false);
			}
		};
		window.addEventListener("mousedown", onDown);
		return () => window.removeEventListener("mousedown", onDown);
	}, [columnsOpen]);

	const toggleSort = useCallback(
		(key: string) => {
			applyUi((prev) => {
				if (prev.sort?.key !== key) {
					return { ...prev, sort: { key, dir: "asc" } };
				}
				if (prev.sort.dir === "asc") {
					return { ...prev, sort: { key, dir: "desc" } };
				}
				return { ...prev, sort: null };
			});
		},
		[applyUi],
	);

	const toggleColumn = useCallback(
		(key: string) => {
			applyUi((prev) => {
				const hidden = prev.hiddenColumns.includes(key)
					? prev.hiddenColumns.filter((k) => k !== key)
					: [...prev.hiddenColumns, key];
				return { ...prev, hiddenColumns: hidden };
			});
		},
		[applyUi],
	);

	const toggleRow = useCallback(
		(key: string) => {
			applyUi((prev) => {
				const selected = prev.selectedKeys.includes(key)
					? prev.selectedKeys.filter((k) => k !== key)
					: [...prev.selectedKeys, key];
				return { ...prev, selectedKeys: selected };
			});
		},
		[applyUi],
	);

	const filteredKeys = useMemo(
		() => filteredRows.map((entry) => entry.key),
		[filteredRows],
	);
	const allSelected =
		filteredKeys.length > 0 &&
		filteredKeys.every((key) => selectedSet.has(key));

	const toggleAll = useCallback(() => {
		applyUi((prev) => ({
			...prev,
			selectedKeys: allSelected ? [] : [...filteredKeys],
		}));
	}, [applyUi, allSelected, filteredKeys]);

	const setFilter = useCallback(
		(value: string) => applyUi((prev) => ({ ...prev, filter: value })),
		[applyUi],
	);

	const setColumnFilter = useCallback(
		(key: string, value: string) =>
			applyUi((prev) => ({
				...prev,
				columnFilters: { ...prev.columnFilters, [key]: value },
			})),
		[applyUi],
	);

	const commitEdit = useCallback(
		(key: string, col: GridColumn, raw: string) => {
			setEditing(null);
			const value = coerceEdit(raw, col.type);
			applyUi((prev) => ({
				...prev,
				edits: {
					...prev.edits,
					[key]: { ...prev.edits[key], [col.key]: value },
				},
			}));
			// Best-effort persistence through the governed companion tool.
			void window.ryu
				?.callTool(ACT_ON_ROWS_TOOL, {
					selected_keys: [key],
					action: `edit:${col.key}=${cellToString(value)}`,
				})
				.catch((err: unknown) => {
					if (err instanceof WidgetRpcError) {
						setError(`Could not save edit: ${err.message}`);
					}
				});
		},
		[applyUi],
	);

	const selectedKeys = ui.selectedKeys;

	const runAction = useCallback(async () => {
		const action = actionName.trim();
		if (selectedKeys.length === 0 || action === "") {
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await window.ryu?.callTool(ACT_ON_ROWS_TOOL, {
				selected_keys: selectedKeys,
				action,
			});
			setActionName("");
		} catch (err) {
			const message =
				err instanceof WidgetRpcError
					? err.message
					: "The action could not be completed.";
			setError(message);
		} finally {
			setBusy(false);
		}
	}, [actionName, selectedKeys]);

	const sendSelection = useCallback(async () => {
		if (selectedKeys.length === 0) {
			return;
		}
		const preview = selectedKeys.slice(0, 20).join(", ");
		const suffix = selectedKeys.length > 20 ? ", …" : "";
		setBusy(true);
		setError(null);
		try {
			await window.ryu?.sendFollowUpMessage({
				prompt: `I selected ${selectedKeys.length} row(s) from the table (key "${primaryKey}"): ${preview}${suffix}. Please act on this selection.`,
			});
		} catch (err) {
			const message =
				err instanceof WidgetRpcError
					? err.message
					: "Could not send the selection.";
			setError(message);
		} finally {
			setBusy(false);
		}
	}, [selectedKeys, primaryKey]);

	// ---- render states ----

	// Loading: globals not injected yet (host has not pushed toolOutput / _meta).
	if (output === undefined && meta === undefined) {
		return (
			<div className="dge" ref={rootRef}>
				<div className="dge__skeleton" style={{ width: "40%" }} />
				<div className="dge__grid">
					{SKELETON_ROWS.map((id) => (
						<div
							className="dge__row"
							key={id}
							style={{ position: "static", padding: "10px 12px" }}
						>
							<div className="dge__skeleton" style={{ width: "100%" }} />
						</div>
					))}
				</div>
			</div>
		);
	}

	if (columns.length === 0 || rawRows.length === 0) {
		return (
			<div className="dge" ref={rootRef}>
				{error ? <div className="dge__error">{error}</div> : null}
				<div className="dge__state">
					<strong>No rows to show</strong>
					<span>The table tool returned an empty result.</span>
				</div>
			</div>
		);
	}

	const colStyle: CSSProperties = { width: DEFAULT_COL_WIDTH };

	return (
		<div className="dge" ref={rootRef}>
			<div className="dge__toolbar">
				<label className="dge__search">
					<SearchIcon />
					<span className="dge__vis-hidden">Filter rows</span>
					<input
						className="dge__input"
						onChange={(e) => setFilter(e.target.value)}
						placeholder="Filter rows…"
						type="text"
						value={ui.filter}
					/>
				</label>

				<button
					aria-pressed={ui.filtersVisible}
					className="dge__btn"
					onClick={() =>
						applyUi((prev) => ({
							...prev,
							filtersVisible: !prev.filtersVisible,
						}))
					}
					type="button"
				>
					Column filters
				</button>

				<div className="dge__menu" ref={columnsMenuRef}>
					<button
						aria-expanded={columnsOpen}
						className="dge__btn"
						onClick={() => setColumnsOpen((open) => !open)}
						type="button"
					>
						Columns ({visibleColumns.length}/{columns.length})
					</button>
					{columnsOpen ? (
						<div className="dge__menu-pop" role="menu">
							{columns.map((col) => (
								<label className="dge__menu-item" key={col.key}>
									<input
										checked={!ui.hiddenColumns.includes(col.key)}
										onChange={() => toggleColumn(col.key)}
										type="checkbox"
									/>
									{col.label}
								</label>
							))}
						</div>
					) : null}
				</div>
			</div>

			{error ? (
				<div className="dge__error">
					<span>{error}</span>
					<button
						className="dge__btn"
						onClick={() => setError(null)}
						type="button"
					>
						Dismiss
					</button>
				</div>
			) : null}

			<div className="dge__grid">
				<div
					className="dge__viewport"
					onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
					ref={viewportRef}
					style={{ maxHeight: viewportCap }}
				>
					<div
						className="dge__head"
						style={{ height: HEAD_HEIGHT, width: gridWidth }}
					>
						<div className="dge__checkcell" style={{ width: CHECK_COL_WIDTH }}>
							<input
								aria-label="Select all filtered rows"
								checked={allSelected}
								onChange={toggleAll}
								type="checkbox"
							/>
						</div>
						{visibleColumns.map((col) => (
							<button
								className="dge__th"
								key={col.key}
								onClick={() => toggleSort(col.key)}
								style={colStyle}
								type="button"
							>
								<span>{col.label}</span>
								<ChevronIcon
									dir={ui.sort?.key === col.key ? ui.sort.dir : null}
								/>
							</button>
						))}
					</div>

					{ui.filtersVisible ? (
						<div
							className="dge__head"
							style={{
								top: HEAD_HEIGHT,
								height: HEAD_HEIGHT,
								width: gridWidth,
							}}
						>
							<div
								className="dge__checkcell"
								style={{ width: CHECK_COL_WIDTH }}
							/>
							{visibleColumns.map((col) => (
								<div className="dge__th" key={col.key} style={colStyle}>
									<input
										aria-label={`Filter ${col.label}`}
										className="dge__input"
										onChange={(e) => setColumnFilter(col.key, e.target.value)}
										placeholder="…"
										style={{ padding: "4px 8px" }}
										type="text"
										value={ui.columnFilters[col.key] ?? ""}
									/>
								</div>
							))}
						</div>
					) : null}

					<div
						style={{
							height: totalHeight,
							position: "relative",
							width: gridWidth,
						}}
					>
						{windowRows.map(({ row, key }, i) => {
							const absoluteIndex = startIndex + i;
							const selected = selectedSet.has(key);
							return (
								<div
									className="dge__row"
									data-selected={selected}
									key={key}
									style={{
										top: absoluteIndex * ROW_HEIGHT,
										height: ROW_HEIGHT,
										width: gridWidth,
									}}
								>
									<div
										className="dge__checkcell"
										style={{ width: CHECK_COL_WIDTH }}
									>
										<input
											aria-label={`Select row ${key}`}
											checked={selected}
											onChange={() => toggleRow(key)}
											type="checkbox"
										/>
									</div>
									{visibleColumns.map((col) => {
										const isEditing =
											editing?.key === key && editing.col === col.key;
										const cellClass =
											col.type === "number"
												? "dge__cell dge__cell--number"
												: "dge__cell";
										if (isEditing) {
											return (
												<div
													className="dge__cell"
													key={col.key}
													style={colStyle}
												>
													<input
														className="dge__editinput"
														defaultValue={cellToString(row[col.key])}
														// biome-ignore lint/a11y/noAutofocus: focus the just-opened editor
														autoFocus
														onBlur={(e) => commitEdit(key, col, e.target.value)}
														onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
															if (e.key === "Enter") {
																commitEdit(key, col, e.currentTarget.value);
															} else if (e.key === "Escape") {
																setEditing(null);
															}
														}}
														type="text"
													/>
												</div>
											);
										}
										if (editable) {
											return (
												<button
													className={`${cellClass} dge__editable`}
													key={col.key}
													onClick={() => setEditing({ key, col: col.key })}
													style={colStyle}
													title={cellToString(row[col.key])}
													type="button"
												>
													<span>{cellToString(row[col.key])}</span>
												</button>
											);
										}
										return (
											<div
												className={cellClass}
												key={col.key}
												style={colStyle}
												title={cellToString(row[col.key])}
											>
												<span>{cellToString(row[col.key])}</span>
											</div>
										);
									})}
								</div>
							);
						})}
					</div>
				</div>
			</div>

			{selectedKeys.length > 0 ? (
				<div className="dge__selbar">
					<span className="dge__selcount">{selectedKeys.length} selected</span>
					<button
						className="dge__btn"
						onClick={() => applyUi((prev) => ({ ...prev, selectedKeys: [] }))}
						type="button"
					>
						Clear
					</button>
					<span className="dge__spacer" />
					<label className="dge__vis-hidden" htmlFor="dge-action">
						Action name
					</label>
					<input
						className="dge__input"
						id="dge-action"
						onChange={(e) => setActionName(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								void runAction();
							}
						}}
						placeholder="action (e.g. archive)"
						style={{ flex: "0 1 160px" }}
						type="text"
						value={actionName}
					/>
					<button
						className="dge__btn"
						disabled={busy || actionName.trim() === ""}
						onClick={() => void runAction()}
						type="button"
					>
						Apply
					</button>
					<button
						className="dge__btn dge__btn--primary"
						disabled={busy}
						onClick={() => void sendSelection()}
						type="button"
					>
						Send to chat
					</button>
				</div>
			) : null}

			<div className="dge__footer">
				<span>
					{filteredRows.length.toLocaleString()} of{" "}
					{rawRows.length.toLocaleString()} rows
				</span>
				{ui.filter || Object.values(ui.columnFilters).some((v) => v.trim()) ? (
					<span>· filtered</span>
				) : null}
				{ui.sort ? (
					<span>
						· sorted by {ui.sort.key} ({ui.sort.dir})
					</span>
				) : null}
			</div>
		</div>
	);
}
