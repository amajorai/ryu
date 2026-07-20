// The **declarative view vocabulary** — the Raycast tier landed on Ryu's existing
// contribution registry.
//
// A companion app never renders. It returns a **view spec**: a plain-DATA description
// (`items`/`columns`/`actions`/`fields`) tagged by a `view` kind. The host shell maps
// that spec to its OWN native components — real `@ryu/ui` on the desktop, the compact
// command-bar idiom on the island — so one spec renders natively on every surface and
// cannot be made ugly (no bundle, no theme bridge, no "ugly-finetune" class of bug).
//
// This module is the single source of truth for the vocabulary, shared by every
// per-surface renderer. It is pure TS (types + tiny pure helpers), so the island can
// consume it as an `import type` with zero runtime coupling. The Rust envelope lives
// in `ryu-kernel-contracts` (`Contributes::views` / `ViewContribution`); the `view` +
// `spec` there are opaque, so a new kind added here needs no Core change.

/** The seven standardized view kinds — the patterns repeated across every CRUD
 *  companion page today, exposed once and host-rendered. */
export const VIEW_KINDS = [
	"list-detail",
	"data-table",
	"form",
	"action-panel",
	"filter-bar",
	"empty-state",
	"stat-card-row",
] as const;

export type ViewKind = (typeof VIEW_KINDS)[number];

/** Visual tone shared by badges and stats — mapped by each renderer to its own
 *  palette (a `@ryu/ui` Badge variant on desktop, a colored dot on the island). */
export type ViewTone = "neutral" | "success" | "warning" | "danger" | "info";

/** How prominent an action is. `primary` is the default/confirm affordance;
 *  `danger` is destructive; `default` is a plain secondary action. */
export type ViewActionStyle = "primary" | "default" | "danger";

/** HTTP methods a declarative action may use against the Core API. */
export const VIEW_ACTION_HTTP_METHODS = [
	"GET",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
] as const;

export type ViewActionHttpMethod = (typeof VIEW_ACTION_HTTP_METHODS)[number];

/**
 * A **declarative HTTP handler** for a {@link ViewAction} — the CRUD tier that
 * makes actions work with NO per-app sidecar code. The shell executes the request
 * against the node's Core API through its own authenticated fetch seam (the spec
 * never sees a token). `path` and string leaves of `body` support `{{field}}`
 * templating from collected form values and `{{item.<key>}}` from the selected
 * list/table item (see {@link renderActionHttp}). Paths are Core-relative and
 * must start with `/api/` ({@link isCoreApiPath}) — a spec can never point the
 * host's credentials at an arbitrary URL.
 */
export interface ViewActionHttp {
	/** Optional JSON body template. A string leaf that is exactly one `{{token}}`
	 *  substitutes the RAW value (type-preserving); mixed strings interpolate. */
	body?: unknown;
	method: ViewActionHttpMethod;
	path: string;
}

/** A user action the shell renders as a button (desktop) or an ActionPanel row
 *  (island). `intent` is an opaque token the shell echoes back to the app when the
 *  action fires — the app decides what it means. */
export interface ViewAction {
	/** Confirmation prompt the shell shows before firing (destructive actions). */
	confirm?: string;
	/** Declarative HTTP handler — when present, the shell executes it directly
	 *  (the CRUD tier); otherwise the action is relayed to the owning app as a
	 *  `view.action` intent over the plugin host bridge. */
	http?: ViewActionHttp;
	/** Icon hint (a name the surface resolves; unknown = no icon). */
	icon?: string;
	id: string;
	/** Opaque command token echoed to the app on activation. */
	intent?: string;
	label: string;
	/** Opaque JSON echoed back to the app alongside `intent` on activation. */
	payload?: unknown;
	style?: ViewActionStyle;
}

/**
 * The context the shell passes with every fired action. `values` is the
 * collected form state (the **form submit contract**: a `Record<string,unknown>`
 * keyed by field id); `item` is the selected/owning list or table row — the RAW
 * source row when the view is source-fetched, else the declared item's fields.
 */
export interface ViewActionContext {
	/** The selected/owning list or table item. */
	item?: Record<string, unknown>;
	/** Collected form values, keyed by field id. */
	values?: Record<string, unknown>;
	/** The owning view contribution id (set by the page/panel wrapper). */
	viewId?: string;
}

/** A small status pill. */
export interface ViewBadge {
	label: string;
	tone?: ViewTone;
}

/** One row of a `list-detail` list: a title with optional supporting text, badges,
 *  a trailing accessory string, and its own row-scoped actions. */
export interface ViewItem {
	/** Trailing metadata (e.g. a timestamp or count). */
	accessory?: string;
	actions?: ViewAction[];
	badges?: ViewBadge[];
	/** Longer text shown in the detail pane (desktop) / expanded row (island). */
	detail?: string;
	id: string;
	subtitle?: string;
	title: string;
}

/** A `data-table` column header. `align` defaults to `left`. */
export interface ViewColumn {
	align?: "left" | "center" | "right";
	header: string;
	id: string;
}

/** A `data-table` row: cell values keyed by column id, plus optional badges/actions. */
export interface ViewRow {
	actions?: ViewAction[];
	badges?: ViewBadge[];
	cells: Record<string, string | number>;
	id: string;
}

/** A `form` field. `select` uses `options`; `switch` uses a boolean `value`. */
export interface ViewField {
	id: string;
	label: string;
	options?: { label: string; value: string }[];
	placeholder?: string;
	required?: boolean;
	type: "text" | "textarea" | "number" | "select" | "switch";
	value?: string | number | boolean;
}

/** A `filter-bar` control — a labelled option set the app filters on. */
export interface ViewFilter {
	id: string;
	label: string;
	options: { label: string; value: string }[];
	value?: string;
}

/** A `stat-card-row` tile: a headline value with an optional delta and tone. */
export interface StatCard {
	/** e.g. `"+12%"` — a secondary caption under the value. */
	delta?: string;
	id: string;
	label: string;
	tone?: ViewTone;
	value: string | number;
}

// ── Data sources (renderer-fetched; specs stay static manifest constants) ─────

/**
 * A declarative **data source** for a `list-detail` view. Specs are static
 * manifest constants, so live data comes from the RENDERER fetching this source
 * at mount (desktop + island both) through the host's authenticated Core seam,
 * then mapping response rows to {@link ViewItem}s via {@link ViewSourceMap}.
 * This is what makes a CRUD view live without a spec-provider round-trip.
 */
export interface ViewSource {
	http: {
		/** Defaults to `GET`. */
		method?: ViewActionHttpMethod;
		/** Core-relative path; must start with `/api/` ({@link isCoreApiPath}). */
		path: string;
	};
	/** Key of the row array in the response object. Absent = the response itself
	 *  is the array, else the first array-valued property is used. */
	items?: string;
	/** Field-map from {@link ViewItem} fields to response-row keys. */
	map?: ViewSourceMap;
}

/** Maps each {@link ViewItem} field to the response-row key it reads. Defaults:
 *  `id` → `"id"`, `title` → `"title"`; the rest are omitted unless mapped. */
export interface ViewSourceMap {
	accessory?: string;
	detail?: string;
	id?: string;
	subtitle?: string;
	title?: string;
}

/** One source-fetched row: the mapped {@link ViewItem} plus the RAW response row
 *  (the `{{item.<key>}}` templating base for actions fired on it). */
export interface SourceItem {
	item: ViewItem;
	raw: Record<string, unknown>;
}

// ── The discriminated union on `view` ─────────────────────────────────────────

export interface ListDetailView {
	/** Global actions (apply to the selection / the whole list). */
	actions?: ViewAction[];
	/** Shown when `items` is empty. */
	emptyText?: string;
	/** Actions attached to EVERY item (declared or source-fetched). Fired with
	 *  that item as `ctx.item`, so `{{item.<key>}}` templating resolves per row. */
	itemActions?: ViewAction[];
	items: ViewItem[];
	/** Renderer-fetched data source; when set, fetched rows replace `items`. */
	source?: ViewSource;
	view: "list-detail";
}

export interface DataTableView {
	actions?: ViewAction[];
	columns: ViewColumn[];
	emptyText?: string;
	rows: ViewRow[];
	view: "data-table";
}

export interface FormView {
	actions?: ViewAction[];
	fields: ViewField[];
	submit?: ViewAction;
	view: "form";
}

export interface ActionPanelView {
	actions: ViewAction[];
	title?: string;
	view: "action-panel";
}

export interface FilterBarView {
	filters: ViewFilter[];
	view: "filter-bar";
}

export interface EmptyStateView {
	action?: ViewAction;
	description?: string;
	icon?: string;
	title: string;
	view: "empty-state";
}

export interface StatCardRowView {
	stats: StatCard[];
	view: "stat-card-row";
}

/** Any view spec. The `view` discriminant selects the renderer branch. */
export type ViewSpec =
	| ListDetailView
	| DataTableView
	| FormView
	| ActionPanelView
	| FilterBarView
	| EmptyStateView
	| StatCardRowView;

/** The wire envelope Core forwards (mirrors Rust `ViewContribution`), tagged with the
 *  owning `plugin` id server-side. `spec` carries a {@link ViewSpec} (its own `view`
 *  duplicates the envelope `view` — the renderer trusts the spec's discriminant). */
export interface ViewContribution {
	id: string;
	/** Owning plugin id, added by Core's contributions endpoint. */
	plugin?: string;
	spec?: ViewSpec;
	title?: string;
	view: ViewKind | string;
}

// ── Templating + source mapping (pure, dependency-free) ───────────────────────

/** `{{token}}` — `token` is a form-field id or `item.<key>`. */
const TEMPLATE_TOKEN = /\{\{\s*([\w.-]+)\s*\}\}/g;

/** Matches a string that is EXACTLY one template token (raw substitution). */
const SOLE_TEMPLATE_TOKEN = /^\{\{\s*([\w.-]+)\s*\}\}$/;

function resolveToken(token: string, ctx: ViewActionContext): unknown {
	if (token.startsWith("item.")) {
		return ctx.item?.[token.slice("item.".length)];
	}
	return ctx.values?.[token];
}

function stringifyToken(value: unknown): string {
	if (value === null || value === undefined) {
		return "";
	}
	return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/**
 * Interpolate `{{field}}` (form values) and `{{item.<key>}}` (selected item)
 * tokens into `template`. `uriEncode` encodes each substituted value as a URI
 * component — required for paths, where a row id must never break the route.
 */
export function renderTemplate(
	template: string,
	ctx: ViewActionContext,
	opts?: { uriEncode?: boolean }
): string {
	return template.replace(TEMPLATE_TOKEN, (_match, token: string) => {
		const text = stringifyToken(resolveToken(token, ctx));
		return opts?.uriEncode ? encodeURIComponent(text) : text;
	});
}

/** Recursively template a JSON body: a string leaf that is exactly one token
 *  substitutes the RAW value (type-preserving); mixed strings interpolate. */
function renderBody(body: unknown, ctx: ViewActionContext): unknown {
	if (typeof body === "string") {
		const sole = SOLE_TEMPLATE_TOKEN.exec(body);
		if (sole?.[1]) {
			return resolveToken(sole[1], ctx);
		}
		return renderTemplate(body, ctx);
	}
	if (Array.isArray(body)) {
		return body.map((entry) => renderBody(entry, ctx));
	}
	if (isRecord(body)) {
		const out: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(body)) {
			out[key] = renderBody(value, ctx);
		}
		return out;
	}
	return body;
}

/** True when `path` is a safe Core-relative API path a declarative action or
 *  source may target: it must start with `/api/` and contain no `..` segment,
 *  so a spec can never point the host's node credentials elsewhere. */
export function isCoreApiPath(path: string): boolean {
	return (
		path.startsWith("/api/") &&
		!path.split("/").some((segment) => segment === "..")
	);
}

/** A fully-rendered declarative HTTP action, ready for the host's fetch seam. */
export interface RenderedActionHttp {
	body?: unknown;
	method: ViewActionHttpMethod;
	path: string;
}

/**
 * Render a {@link ViewActionHttp} against the fired action's context: the path
 * templates with URI-encoding, the body templates type-preservingly. Throws when
 * the rendered path is not a Core-relative `/api/` path ({@link isCoreApiPath}).
 */
export function renderActionHttp(
	http: ViewActionHttp,
	ctx: ViewActionContext
): RenderedActionHttp {
	const path = renderTemplate(http.path, ctx, { uriEncode: true });
	if (!isCoreApiPath(path)) {
		throw new Error(`declarative action path must start with /api/: ${path}`);
	}
	return {
		method: http.method,
		path,
		body: http.body === undefined ? undefined : renderBody(http.body, ctx),
	};
}

function rowText(
	row: Record<string, unknown>,
	key: string | undefined
): string | undefined {
	if (!key) {
		return undefined;
	}
	const value = row[key];
	if (value === null || value === undefined) {
		return undefined;
	}
	return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/**
 * Map a source-fetch response payload to renderable {@link SourceItem}s per the
 * source's `items` key + field-map. Deliberately forgiving: rows without a
 * usable id/title are skipped, a non-array payload yields `[]` — a bad backend
 * response degrades to the empty state, never a crash.
 */
export function sourceItemsFromResponse(
	source: ViewSource,
	payload: unknown
): SourceItem[] {
	let rows: unknown;
	if (Array.isArray(payload)) {
		rows = payload;
	} else if (isRecord(payload)) {
		rows = source.items
			? payload[source.items]
			: Object.values(payload).find((v) => Array.isArray(v));
	}
	if (!Array.isArray(rows)) {
		return [];
	}
	const map = source.map ?? {};
	const out: SourceItem[] = [];
	for (const row of rows) {
		if (!isRecord(row)) {
			continue;
		}
		const id = rowText(row, map.id ?? "id");
		const title = rowText(row, map.title ?? "title");
		if (!(id && title)) {
			continue;
		}
		out.push({
			raw: row,
			item: {
				id,
				title,
				subtitle: rowText(row, map.subtitle),
				detail: rowText(row, map.detail),
				accessory: rowText(row, map.accessory),
			},
		});
	}
	return out;
}

// ── Validation (pure, dependency-free) ────────────────────────────────────────

/** Result of {@link validateView}: `ok` plus a flat list of human-readable errors. */
export interface ViewValidation {
	errors: string[];
	ok: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

/** True when `kind` is one of the seven known {@link VIEW_KINDS}. */
export function isKnownViewKind(kind: unknown): kind is ViewKind {
	return (
		typeof kind === "string" && (VIEW_KINDS as readonly string[]).includes(kind)
	);
}

/**
 * Structurally validate a value as a {@link ViewSpec}. This is the shared gate a
 * renderer runs before dispatch: it checks the `view` discriminant is known and that
 * the payload carries the required collection for that kind. It is deliberately shallow
 * (shape, not deep field types) — the renderers tolerate missing optional fields — so a
 * newer app targeting an older shell degrades to a known-kind empty view rather than a
 * crash.
 */
export function validateView(value: unknown): ViewValidation {
	const errors: string[] = [];
	if (!isRecord(value)) {
		return { ok: false, errors: ["view spec must be an object"] };
	}
	const kind = value.view;
	if (!isKnownViewKind(kind)) {
		return {
			ok: false,
			errors: [`unknown view kind: ${JSON.stringify(kind)}`],
		};
	}
	const requireArray = (key: string) => {
		if (!Array.isArray((value as Record<string, unknown>)[key])) {
			errors.push(`${kind}: "${key}" must be an array`);
		}
	};
	switch (kind) {
		case "list-detail":
			requireArray("items");
			break;
		case "data-table":
			requireArray("columns");
			requireArray("rows");
			break;
		case "form":
			requireArray("fields");
			break;
		case "action-panel":
			requireArray("actions");
			break;
		case "filter-bar":
			requireArray("filters");
			break;
		case "empty-state":
			if (typeof value.title !== "string" || value.title.length === 0) {
				errors.push('empty-state: "title" must be a non-empty string');
			}
			break;
		case "stat-card-row":
			requireArray("stats");
			break;
		default:
			break;
	}
	return { ok: errors.length === 0, errors };
}

// ── The reference example: a "hello list-detail" spec ─────────────────────────

/** The minimal proof spec rendered in both the desktop and island harnesses — a
 *  three-item list with a detail body and one primary action. Kept tiny on purpose:
 *  it is the load-bearing "one spec, two renderers" demonstration. */
export const helloListDetail: ListDetailView = {
	view: "list-detail",
	items: [
		{
			id: "alpha",
			title: "Alpha",
			subtitle: "The first letter",
			detail: "Alpha is where the list begins. Selecting it shows this detail.",
			badges: [{ label: "new", tone: "success" }],
			accessory: "1",
		},
		{
			id: "beta",
			title: "Beta",
			subtitle: "The second letter",
			detail: "Beta demonstrates a second row with its own detail body.",
			accessory: "2",
		},
		{
			id: "gamma",
			title: "Gamma",
			subtitle: "The third letter",
			detail: "Gamma closes out the hello example.",
			badges: [{ label: "draft", tone: "warning" }],
			accessory: "3",
		},
	],
	actions: [
		{ id: "refresh", label: "Refresh", style: "primary", icon: "refresh" },
	],
	emptyText: "Nothing here yet.",
};

/** The example wrapped as a {@link ViewContribution} — what a plugin's manifest
 *  `contributes.views[]` entry looks like on the wire. */
export const helloListDetailContribution: ViewContribution = {
	id: "hello",
	title: "Hello",
	view: "list-detail",
	spec: helloListDetail,
};
