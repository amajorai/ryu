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
// here with the owner schemas that refine raw contribution specs. Source-fetching
// lives in the island shell; this renderer
// only receives the resolved rows via the `sourceItems` prop. One spec, two renderers
// tuned to density.

import type {
	RawViewContribution,
	SourceItem,
	ViewBadge,
	ViewContribution,
	ViewSpec,
} from "@ryu/app-host/views";
import {
	validateView,
	viewSourceRowSchema,
	viewSpecSchema,
} from "@ryu/app-host/views";
import { useState } from "react";
import { CompactForm } from "./declarative-view-form.tsx";
import {
	ActionPanel,
	type IslandViewActionHandler,
	type PanelEntry,
	ToneBadges,
	withCtx,
} from "./declarative-view-parts.tsx";

export type { IslandViewActionHandler } from "./declarative-view-parts.tsx";

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
				selected ? "bg-foreground/10" : "hover:bg-foreground/5"
			}`}
			onClick={onSelect}
			type="button"
		>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span className="truncate text-foreground text-sm" title={title}>
						{title}
					</span>
					<ToneBadges badges={badges} />
				</div>
				{subtitle ? (
					<div
						className="truncate text-detail text-muted-foreground"
						title={subtitle}
					>
						{subtitle}
					</div>
				) : null}
			</div>
			{accessory ? (
				<span className="shrink-0 text-muted-foreground text-xs">
					{accessory}
				</span>
			) : null}
		</button>
	);
}

function EmptyRow({ text }: { text: string }) {
	return (
		<div className="px-2 py-4 text-center text-muted-foreground text-xs">
			{text}
		</div>
	);
}

/** A declared (non-source) item's fields as a `{{item.<key>}}` templating base. */
const itemRecord = viewSourceRowSchema.parse;

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

/**
 * Render a {@link ViewSpec} in the island's compact idiom. `sourceItems` carries the
 * shell-fetched rows of a `source`-declaring `list-detail` spec (the island shell owns
 * fetching, so this renderer never fetches itself).
 *
 * # Why the validate gate is here and not upstream
 *
 * `spec` is **opaque to Core** — the whole point of the views seam is that a new view
 * kind needs no Core change, so Core stores and serves whatever the manifest declared
 * without inspecting it. That means an unvalidated spec reaches this function verbatim,
 * and the `view` discriminant alone is not enough: a manifest declaring
 * `{"view": "list-detail"}` with no `items` has a KNOWN kind and would otherwise fall
 * straight through to `spec.items.map(...)` and throw. In the island that surfaces as a
 * crash of the whole overlay, not one dead pane.
 *
 * So dispatch is gated on the shared [`validateView`] — the same gate the desktop
 * renderer runs (`apps/desktop/src/components/views/DeclarativeView.tsx`) — which checks
 * the discriminant AND that the payload carries the collection its kind requires. It is
 * followed by the owner schema before nested rendering, so a newer app targeting
 * an older shell degrades to a readable row instead of crashing.
 */
export function IslandDeclarativeView({
	spec: rawSpec,
	onAction,
	sourceItems,
}: {
	spec: ViewSpec | RawViewContribution["spec"];
	onAction?: IslandViewActionHandler;
	sourceItems?: SourceItem[] | null;
}) {
	const check = validateView(rawSpec);
	if (!check.ok) {
		return <EmptyRow text={check.errors.join("; ")} />;
	}

	const parsed = viewSpecSchema.safeParse(rawSpec);
	if (!parsed.success) {
		return <EmptyRow text="Invalid view specification" />;
	}
	const spec = parsed.data;
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
						<div className="px-2 pt-2 font-medium text-foreground text-sm">
							{spec.title}
						</div>
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
								className={`rounded-lg px-2 py-0.5 text-xs ${
									filter.value === opt.value
										? "bg-foreground/10 text-foreground"
										: "text-muted-foreground"
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
					<div className="font-medium text-foreground text-sm">
						{spec.title}
					</div>
					{spec.description ? (
						<div className="text-detail text-muted-foreground">
							{spec.description}
						</div>
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
						<div
							className="rounded-lg bg-foreground/5 px-2 py-1.5"
							key={stat.id}
						>
							<div className="text-muted-foreground text-xs">{stat.label}</div>
							<div className="font-medium text-foreground text-sm">
								{stat.value}
							</div>
							{stat.delta ? (
								<div className="text-muted-foreground text-xs">
									{stat.delta}
								</div>
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
	view: ViewContribution | RawViewContribution;
	onAction?: IslandViewActionHandler;
	sourceItems?: SourceItem[] | null;
}) {
	if (!view.spec) {
		return <EmptyRow text="View unavailable" />;
	}
	return (
		<div className="flex flex-col">
			{view.title ? (
				<div className="px-2 pt-2 pb-1 font-medium text-foreground text-sm">
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
