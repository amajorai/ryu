// The **island renderer** for the declarative view tier — the REFERENCE surface for
// the Raycast model. The island is a tiny, hotkey-driven Electron command-bar overlay,
// so a sandboxed iframe companion looks worst here (fights the chrome, wastes cramped
// space). A host-rendered declarative view blends perfectly: the SAME `ViewSpec` the
// desktop renders full-size (`apps/desktop/.../DeclarativeView.tsx`) is rendered here
// in the compact command-bar idiom — a dense list plus a Raycast-style ActionPanel.
//
// Actions are LIVE, Raycast-style: the list keeps a selection (first row by default)
// and the foot ActionPanel fires on it — the selected row's own actions plus the
// spec's `itemActions` and global `actions`, each with a ctx carrying the selected
// `item` (the raw source row when source-fetched) and collected form `values`. The
// island shell (apps/island `CompanionPanel`) owns what an action MEANS: the
// declarative `http` tier over the main-process Core client, or a `view.action`
// intent over the plugin-host IPC seam.
//
// The spec vocabulary is the single source of truth in `@ryu/app-host/views`, consumed
// here as an `import type` only (zero runtime coupling — the island bundles no app-host
// runtime). Source-FETCHING therefore lives in the island shell too; this renderer
// only receives the resolved rows via the `sourceItems` prop. One spec, two renderers
// tuned to density.

import type {
	SourceItem,
	ViewAction,
	ViewActionContext,
	ViewBadge,
	ViewContribution,
	ViewField,
	ViewSpec,
	ViewTone,
} from "@ryu/app-host/views";
import { useState } from "react";

/** Fires when a user activates an action row. The renderer supplies the ctx
 *  (selected `item`, collected form `values`); the island shell forwards the
 *  action to the declarative http tier or the owning app. */
export type IslandViewActionHandler = (
	action: ViewAction,
	ctx: ViewActionContext
) => void;

const TONE_DOT: Record<ViewTone, string> = {
	neutral: "bg-white/40",
	success: "bg-emerald-400",
	warning: "bg-amber-400",
	danger: "bg-red-400",
	info: "bg-sky-400",
};

function ToneBadges({ badges }: { badges?: ViewBadge[] }) {
	if (!badges || badges.length === 0) {
		return null;
	}
	return (
		<span className="flex items-center gap-1">
			{badges.map((b, i) => (
				<span
					className="flex items-center gap-1 text-[10px] text-white/50"
					key={`${b.label}-${i}`}
				>
					<span
						className={`size-1.5 rounded-full ${TONE_DOT[b.tone ?? "neutral"]}`}
					/>
					{b.label}
				</span>
			))}
		</span>
	);
}

/** One entry of the foot ActionPanel: the action plus the ctx it fires with. */
interface PanelEntry {
	action: ViewAction;
	ctx: ViewActionContext;
}

/** The Raycast-style ActionPanel: a compact row of pill buttons at the foot of the
 *  overlay. Primary reads brighter; danger reads red. Each entry carries its own
 *  ctx (the selected item / form values) so `{{…}}` templating resolves upstream. */
function ActionPanel({
	entries,
	onAction,
}: {
	entries: PanelEntry[];
	onAction?: IslandViewActionHandler;
}) {
	if (entries.length === 0) {
		return null;
	}
	return (
		<div className="flex flex-wrap items-center gap-1.5 border-white/10 border-t px-2 pt-2">
			{entries.map(({ action, ctx }) => (
				<button
					className={`rounded-md px-2 py-1 text-xs transition-colors ${
						action.style === "primary"
							? "bg-white/15 text-white hover:bg-white/25"
							: action.style === "danger"
								? "text-red-300 hover:bg-red-500/15"
								: "text-white/70 hover:bg-white/10"
					}`}
					key={action.id}
					onClick={() => onAction?.(action, ctx)}
					type="button"
				>
					{action.label}
				</button>
			))}
		</div>
	);
}

/** Actions with a shared ctx → panel entries. */
function withCtx(
	actions: ViewAction[] | undefined,
	ctx: ViewActionContext
): PanelEntry[] {
	return (actions ?? []).map((action) => ({ action, ctx }));
}

/** A single dense list row (list-detail / data-table share this shape). Selectable:
 *  the foot ActionPanel fires on the selected row, Raycast-style. */
function Row({
	title,
	subtitle,
	accessory,
	badges,
	selected,
	onSelect,
}: {
	title: string;
	subtitle?: string;
	accessory?: string;
	badges?: ViewBadge[];
	selected?: boolean;
	onSelect?: () => void;
}) {
	return (
		<button
			aria-pressed={selected}
			className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left ${
				selected ? "bg-white/10" : "hover:bg-white/5"
			}`}
			onClick={onSelect}
			type="button"
		>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span className="truncate text-sm text-white/90">{title}</span>
					<ToneBadges badges={badges} />
				</div>
				{subtitle ? (
					<div className="truncate text-white/45 text-xs">{subtitle}</div>
				) : null}
			</div>
			{accessory ? (
				<span className="shrink-0 text-[10px] text-white/40">{accessory}</span>
			) : null}
		</button>
	);
}

function EmptyRow({ text }: { text: string }) {
	return (
		<div className="px-2 py-4 text-center text-white/40 text-xs">{text}</div>
	);
}

/** A declared (non-source) item's fields as a `{{item.<key>}}` templating base. */
function itemRecord(item: Record<string, unknown>): Record<string, unknown> {
	return { ...item };
}

function ListDetail({
	spec,
	onAction,
	sourceItems,
}: {
	spec: Extract<ViewSpec, { view: "list-detail" }>;
	onAction?: IslandViewActionHandler;
	sourceItems?: SourceItem[] | null;
}) {
	const rows: SourceItem[] =
		sourceItems ??
		spec.items.map((item) => ({ item, raw: itemRecord({ ...item }) }));
	// Raycast semantics: first row selected by default; the foot panel fires on it.
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const selected =
		rows.find((r) => r.item.id === selectedId) ?? rows[0] ?? null;
	const entries: PanelEntry[] = [
		...withCtx(selected?.item.actions, { item: selected?.raw }),
		...(selected ? withCtx(spec.itemActions, { item: selected.raw }) : []),
		...withCtx(spec.actions, { item: selected?.raw }),
	];
	return (
		<div className="flex flex-col">
			<div className="flex flex-col gap-0.5 p-1">
				{rows.length === 0 ? (
					<EmptyRow text={spec.emptyText ?? "Nothing here yet."} />
				) : (
					rows.map(({ item }) => (
						<Row
							accessory={item.accessory}
							badges={item.badges}
							key={item.id}
							onSelect={() => setSelectedId(item.id)}
							selected={selected?.item.id === item.id}
							subtitle={item.subtitle ?? item.detail}
							title={item.title}
						/>
					))
				)}
			</div>
			<ActionPanel entries={entries} onAction={onAction} />
		</div>
	);
}

function DataTable({
	spec,
	onAction,
}: {
	spec: Extract<ViewSpec, { view: "data-table" }>;
	onAction?: IslandViewActionHandler;
}) {
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const selected =
		spec.rows.find((r) => r.id === selectedId) ?? spec.rows[0] ?? null;
	const selectedItem = selected
		? { id: selected.id, ...selected.cells }
		: undefined;
	const entries: PanelEntry[] = [
		...withCtx(selected?.actions, { item: selectedItem }),
		...withCtx(spec.actions, { item: selectedItem }),
	];
	return (
		<div className="flex flex-col">
			<div className="flex flex-col gap-0.5 p-1">
				{spec.rows.length === 0 ? (
					<EmptyRow text={spec.emptyText ?? "No rows."} />
				) : (
					spec.rows.map((row) => {
						const [first, ...rest] = spec.columns;
						return (
							<Row
								accessory={
									rest.length > 0
										? String(row.cells[rest[0]?.id ?? ""] ?? "")
										: undefined
								}
								badges={row.badges}
								key={row.id}
								onSelect={() => setSelectedId(row.id)}
								selected={selected?.id === row.id}
								subtitle={rest
									.slice(1)
									.map((c) => String(row.cells[c.id] ?? ""))
									.filter(Boolean)
									.join(" · ")}
								title={first ? String(row.cells[first.id] ?? "") : row.id}
							/>
						);
					})
				)}
			</div>
			<ActionPanel entries={entries} onAction={onAction} />
		</div>
	);
}

/** One compact, controlled form field in the island idiom. */
function CompactField({
	field,
	value,
	onChange,
}: {
	field: ViewField;
	value: unknown;
	onChange: (next: unknown) => void;
}) {
	if (field.type === "switch") {
		const on = value === true;
		return (
			<button
				aria-pressed={on}
				className={`rounded-md px-2 py-0.5 text-xs ${
					on ? "bg-white/15 text-white" : "text-white/50 hover:bg-white/10"
				}`}
				onClick={() => onChange(!on)}
				type="button"
			>
				{on ? "On" : "Off"}
			</button>
		);
	}
	if (field.type === "select") {
		return (
			<select
				className="max-w-[10rem] rounded-md bg-white/10 px-1.5 py-0.5 text-white/80 text-xs outline-none"
				onChange={(e) => onChange(e.target.value)}
				value={String(value ?? "")}
			>
				{(field.options ?? []).map((opt) => (
					<option key={opt.value} value={opt.value}>
						{opt.label}
					</option>
				))}
			</select>
		);
	}
	return (
		<input
			className="max-w-[10rem] rounded-md bg-white/10 px-1.5 py-0.5 text-white/80 text-xs outline-none placeholder:text-white/30"
			onChange={(e) =>
				onChange(
					field.type === "number" && e.target.value !== ""
						? Number(e.target.value)
						: e.target.value
				)
			}
			placeholder={field.placeholder}
			type={field.type === "number" ? "number" : "text"}
			value={String(value ?? "")}
		/>
	);
}

function initialFormValues(fields: ViewField[]): Record<string, unknown> {
	const values: Record<string, unknown> = {};
	for (const field of fields) {
		values[field.id] = field.value ?? (field.type === "switch" ? false : "");
	}
	return values;
}

function CompactForm({
	spec,
	onAction,
}: {
	spec: Extract<ViewSpec, { view: "form" }>;
	onAction?: IslandViewActionHandler;
}) {
	// Controlled inputs: the collected values ARE the form-submit contract — the
	// `Record<string,unknown>` handed to every action fired from this form.
	const [values, setValues] = useState<Record<string, unknown>>(() =>
		initialFormValues(spec.fields)
	);
	const setField = (id: string, next: unknown) =>
		setValues((prev) => ({ ...prev, [id]: next }));
	const entries: PanelEntry[] = [
		...withCtx(spec.submit ? [spec.submit] : undefined, { values }),
		...withCtx(spec.actions, { values }),
	];
	return (
		<div className="flex flex-col">
			<div className="flex flex-col gap-1 p-2">
				{spec.fields.map((field) => (
					<div
						className="flex items-center justify-between gap-2 text-xs"
						key={field.id}
					>
						<span className="text-white/50">{field.label}</span>
						<CompactField
							field={field}
							onChange={(next) => setField(field.id, next)}
							value={values[field.id]}
						/>
					</div>
				))}
			</div>
			<ActionPanel entries={entries} onAction={onAction} />
		</div>
	);
}

/**
 * Render a {@link ViewSpec} in the island's compact idiom. Unknown kinds degrade to a
 * quiet empty row rather than crashing the overlay. `sourceItems` carries the
 * shell-fetched rows of a `source`-declaring `list-detail` spec (this renderer is
 * import-type-only on `@ryu/app-host`, so it never fetches itself).
 */
export function IslandDeclarativeView({
	spec,
	onAction,
	sourceItems,
}: {
	spec: ViewSpec;
	onAction?: IslandViewActionHandler;
	sourceItems?: SourceItem[] | null;
}) {
	switch (spec.view) {
		case "list-detail":
			return (
				<ListDetail onAction={onAction} sourceItems={sourceItems} spec={spec} />
			);

		case "data-table":
			return <DataTable onAction={onAction} spec={spec} />;

		case "form":
			return <CompactForm onAction={onAction} spec={spec} />;

		case "action-panel":
			return (
				<div className="flex flex-col">
					{spec.title ? (
						<div className="px-2 pt-2 text-white/50 text-xs">{spec.title}</div>
					) : null}
					<ActionPanel
						entries={withCtx(spec.actions, {})}
						onAction={onAction}
					/>
				</div>
			);

		case "filter-bar":
			return (
				<div className="flex flex-wrap items-center gap-1.5 p-2">
					{spec.filters.flatMap((filter) =>
						filter.options.map((opt) => (
							<span
								className={`rounded-md px-2 py-0.5 text-xs ${
									filter.value === opt.value
										? "bg-white/15 text-white"
										: "text-white/50"
								}`}
								key={`${filter.id}-${opt.value}`}
							>
								{opt.label}
							</span>
						))
					)}
				</div>
			);

		case "empty-state":
			return (
				<div className="flex flex-col items-center gap-1 p-4 text-center">
					<div className="text-sm text-white/80">{spec.title}</div>
					{spec.description ? (
						<div className="text-white/45 text-xs">{spec.description}</div>
					) : null}
					{spec.action ? (
						<ActionPanel
							entries={withCtx([spec.action], {})}
							onAction={onAction}
						/>
					) : null}
				</div>
			);

		case "stat-card-row":
			return (
				<div className="grid grid-cols-2 gap-1.5 p-2">
					{spec.stats.map((stat) => (
						<div className="rounded-lg bg-white/5 px-2 py-1.5" key={stat.id}>
							<div className="text-[10px] text-white/45">{stat.label}</div>
							<div className="font-semibold text-sm text-white/90">
								{stat.value}
							</div>
							{stat.delta ? (
								<div className="text-[10px] text-white/40">{stat.delta}</div>
							) : null}
						</div>
					))}
				</div>
			);

		default:
			return <EmptyRow text="Unsupported view" />;
	}
}

/**
 * The mapping unit the island runtime mounts: a single plugin-contributed
 * {@link ViewContribution} → its optional compact title → the host-rendered
 * {@link IslandDeclarativeView}. This is the seam the island's `CompanionPanel`
 * uses, kept as a tiny pure component so the `contribution → spec → renderer` path
 * is testable without the Electron/IPC shell around it.
 *
 * A contribution without a `spec` (a title-only manifest entry) renders a quiet
 * empty row rather than crashing the overlay, mirroring the desktop `PluginViewPage`
 * "view unavailable" degrade. `onAction` fires with the contribution's id injected
 * as `ctx.viewId`; the shell (which holds the IPC seams) executes the intent.
 * `sourceItems` carries the shell-fetched rows of a `source`-declaring spec.
 */
export function IslandViewPanel({
	view,
	onAction,
	sourceItems,
}: {
	view: ViewContribution;
	onAction?: IslandViewActionHandler;
	sourceItems?: SourceItem[] | null;
}) {
	if (!view.spec) {
		return <EmptyRow text="View unavailable" />;
	}
	return (
		<div className="flex flex-col">
			{view.title ? (
				<div className="px-2 pt-2 pb-1 font-medium text-white/70 text-xs">
					{view.title}
				</div>
			) : null}
			<IslandDeclarativeView
				onAction={
					onAction
						? (action, ctx) => onAction(action, { ...ctx, viewId: view.id })
						: undefined
				}
				sourceItems={sourceItems}
				spec={view.spec}
			/>
		</div>
	);
}
