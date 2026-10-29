// The declarative-view VOCABULARY, projected for the terminal.
//
// A plugin never ships UI code to a host shell. It declares `contributes.views[]`
// in its manifest: a typed envelope (id/title/view) around an OPAQUE `spec` that is
// pure DATA — items, columns, actions, fields — tagged by one of seven kinds
// (list-detail, data-table, form, action-panel, filter-bar, empty-state,
// stat-card-row). Each host renders that SAME spec with its own idiom: real
// @ryu/ui components on the desktop, a compact Raycast-style panel on the island,
// a keyboard-driven list in this terminal. One spec, N renderers.
//
// `packages/app-host/src/views.ts` is the single source of truth for the
// vocabulary. It is MIRRORED here rather than imported because the TUI is a
// bun-run CLI whose only workspace dependency is `@ryuhq/core-client`
// (see package.json) — the same reason every other Core payload it consumes is
// projected locally from the wire shape (see the `*Wire` interfaces in
// src/tabs/apps.tsx). The mirror is not allowed to drift: the drift-guard block of
// src/__tests__/contributions.test.ts imports the source-of-truth helpers directly
// and asserts this module agrees with them field for field, so a change upstream
// fails the TUI test suite rather than silently rendering the wrong thing.
//
// Everything here is pure and dependency-free; the renderer lives in
// src/ui/DeclarativeView.tsx and the Core-backed shell in src/ui/ContributedView.tsx.

import { z } from "zod";

const viewPayloadSchema = z.json();
type ViewPayload = z.infer<typeof viewPayloadSchema>;
const viewTextSchema = z.string();
const viewArraySchema = z.array(viewPayloadSchema);

/** JSON source-row contract mirrors the app-host vocabulary. */
export const viewSourceRowSchema = z.record(
	z.string(),
	z.json().optional().catch(undefined)
);
export type ViewSourceRow = z.infer<typeof viewSourceRowSchema>;

/** The seven standardized view kinds — the discriminant a renderer switches on. */
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
const viewKindSchema = z.enum(VIEW_KINDS);

/** Visual tone shared by badges and stats, mapped by each renderer to its own
 *  palette (a `@ryu/ui` Badge variant on desktop, a themed termcn Badge here). */
export type ViewTone = "neutral" | "success" | "warning" | "danger" | "info";

/** How prominent an action is. `primary` is the default/confirm affordance (the
 *  one Enter fires here); `danger` is destructive; `default` is secondary. */
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

export const VIEW_SOURCE_HTTP_METHODS = ["GET"] as const;
export type ViewSourceHttpMethod = (typeof VIEW_SOURCE_HTTP_METHODS)[number];

/** A declarative HTTP handler for a {@link ViewAction} — the CRUD tier that makes
 *  actions work with NO per-app sidecar code. The host executes the request through
 *  its own authenticated Core seam (the spec never sees a token); `path` and string
 *  leaves of `body` template from the collected form values and the selected item. */
export interface ViewActionHttp {
	body?: ViewPayload;
	method: ViewActionHttpMethod;
	path: string;
}

/** A user action, rendered as a numbered entry in the terminal's command row.
 *  `intent` is an opaque token the shell echoes back to the owning app. */
export interface ViewAction {
	/** Confirmation prompt shown before firing (destructive actions). */
	confirm?: string;
	/** When present the host executes this directly (the CRUD tier); otherwise the
	 *  action is relayed to the owning app as a `view.action` intent. */
	http?: ViewActionHttp;
	/** Icon hint (a name the surface resolves; unknown = no icon). */
	icon?: string;
	id: string;
	intent?: string;
	label: string;
	payload?: ViewPayload;
	style?: ViewActionStyle;
}

/** The context the host passes with every fired action: the collected form
 *  `values`, the selected/owning row (`item` — the RAW source row when the view is
 *  source-fetched), and the owning contribution id. */
export interface ViewActionContext {
	item?: ViewSourceRow;
	values?: ViewSourceRow;
	viewId?: string;
}

/** A small status pill. */
export interface ViewBadge {
	label: string;
	tone?: ViewTone;
}

/** One row of a `list-detail` list. */
export interface ViewItem {
	accessory?: string;
	actions?: ViewAction[];
	badges?: ViewBadge[];
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

/** A `data-table` row: cell values keyed by column id. */
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

/** A `stat-card-row` tile. */
export interface StatCard {
	delta?: string;
	id: string;
	label: string;
	tone?: ViewTone;
	value: string | number;
}

/** A declarative data source for a `list-detail` view. Specs are static manifest
 *  constants, so live data comes from the RENDERER's host fetching this at mount
 *  through its authenticated Core seam and mapping rows via {@link ViewSourceMap}. */
export interface ViewSource {
	http: {
		/** Defaults to `GET`. */
		method?: ViewSourceHttpMethod;
		/** Core-relative path; must satisfy {@link isCoreApiPath}. */
		path: string;
	};
	/** Key of the row array in the response object. Absent = the response itself is
	 *  the array, else the first array-valued property is used. */
	items?: string;
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
	raw: ViewSourceRow;
}

// ── The discriminated union on `view` ────────────────────────────────────────

export interface ListDetailView {
	actions?: ViewAction[];
	emptyText?: string;
	/** Actions attached to EVERY item, fired with that item as `ctx.item`. */
	itemActions?: ViewAction[];
	items: ViewItem[];
	/** Host-fetched data source; when set, fetched rows replace `items`. */
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

// ── Templating + source mapping (pure) ───────────────────────────────────────

/** `{{token}}` — `token` is a form-field id or `item.<key>`. */
const TEMPLATE_TOKEN = /\{\{\s*([\w.-]+)\s*\}\}/g;

/** Matches a string that is EXACTLY one template token (raw substitution). */
const SOLE_TEMPLATE_TOKEN = /^\{\{\s*([\w.-]+)\s*\}\}$/;

function resolveToken(
	token: string,
	ctx: ViewActionContext
): ViewPayload | undefined {
	return token.startsWith("item.")
		? ctx.item?.[token.slice("item.".length)]
		: ctx.values?.[token];
}
function stringifyToken(value: ViewPayload | undefined): string {
	if (value === null || value === undefined) {
		return "";
	}
	const scalar = z
		.union([z.string(), z.number(), z.boolean()])
		.safeParse(value);
	return scalar.success ? String(scalar.data) : JSON.stringify(value);
}
export interface ViewTemplateOptions {
	uriEncode?: boolean;
}

/** Interpolate `{{field}}` (form values) and `{{item.<key>}}` (selected item)
 *  tokens into `template`. `uriEncode` encodes each substituted value as a URI
 *  component — required for paths, where a row id must never break the route. */
export function renderTemplate(
	template: string,
	ctx: ViewActionContext,
	opts?: ViewTemplateOptions
): string {
	return template.replace(TEMPLATE_TOKEN, (_match, token: string) => {
		const text = stringifyToken(resolveToken(token, ctx));
		return opts?.uriEncode ? encodeURIComponent(text) : text;
	});
}

/** Recursively template a JSON body: a string leaf that is exactly one token
 *  substitutes the RAW value (type-preserving); mixed strings interpolate. */
export type RenderedViewBody =
	| ViewPayload
	| undefined
	| RenderedViewBody[]
	| RenderedViewObject;
interface RenderedViewObject {
	[key: string]: RenderedViewBody;
}
function renderBody(
	body: ViewPayload,
	ctx: ViewActionContext
): RenderedViewBody {
	const text = viewTextSchema.safeParse(body);
	if (text.success) {
		const sole = SOLE_TEMPLATE_TOKEN.exec(text.data);
		return sole?.[1]
			? resolveToken(sole[1], ctx)
			: renderTemplate(text.data, ctx);
	}
	if (Array.isArray(body)) {
		return body.map((entry) => renderBody(entry, ctx));
	}
	const record = viewSourceRowSchema.safeParse(body);
	if (record.success) {
		const output: RenderedViewObject = {};
		for (const [key, value] of Object.entries(record.data)) {
			output[key] = value === undefined ? undefined : renderBody(value, ctx);
		}
		return output;
	}
	return body;
}

/** True when `path` is a safe Core-relative API path a declarative action or
 *  source may target: it must start with `/api/` and contain no `..` segment, so a
 *  spec can never point the node's credentials somewhere else. */
export function isCoreApiPath(path: string): boolean {
	return (
		path.startsWith("/api/") &&
		!path.split("/").some((segment) => segment === "..")
	);
}

/** A fully-rendered declarative HTTP action, ready for the host's fetch seam. */
export interface RenderedActionHttp {
	body?: RenderedViewBody;
	method: ViewActionHttpMethod;
	path: string;
}

/** Render a {@link ViewActionHttp} against the fired action's context: the path
 *  templates with URI-encoding, the body templates type-preservingly. Throws when
 *  the rendered path is not a Core-relative `/api/` path. */
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
	row: ViewSourceRow,
	key: string | undefined
): string | undefined {
	if (!key) {
		return undefined;
	}
	const value = row[key];
	if (value === null || value === undefined) {
		return undefined;
	}
	return stringifyToken(value);
}

/** Map a source-fetch response payload to renderable {@link SourceItem}s per the
 *  source's `items` key + field-map. Deliberately forgiving: rows without a usable
 *  id/title are skipped and a non-array payload yields `[]`, so a bad backend
 *  response degrades to the empty state rather than crashing the shell. */
export function sourceItemsFromResponse(
	source: ViewSource,
	payload: Parameters<typeof viewPayloadSchema.safeParse>[0]
): SourceItem[] {
	const parsed = viewPayloadSchema.safeParse(payload);
	if (!parsed.success) {
		return [];
	}
	const array = viewArraySchema.safeParse(parsed.data);
	const record = viewSourceRowSchema.safeParse(parsed.data);
	const rows = array.success
		? array.data
		: record.success
			? source.items
				? record.data[source.items]
				: Object.values(record.data).find((value) => Array.isArray(value))
			: undefined;
	if (!Array.isArray(rows)) {
		return [];
	}
	const map = source.map ?? {};
	const output: SourceItem[] = [];
	for (const row of rows) {
		const parsedRow = viewSourceRowSchema.safeParse(row);
		if (!parsedRow.success) {
			continue;
		}
		const raw = parsedRow.data;
		const id = rowText(raw, map.id ?? "id");
		const title = rowText(raw, map.title ?? "title");
		if (!(id && title)) {
			continue;
		}
		output.push({
			raw,
			item: {
				id,
				title,
				subtitle: rowText(raw, map.subtitle),
				detail: rowText(raw, map.detail),
				accessory: rowText(raw, map.accessory),
			},
		});
	}
	return output;
}

/** True when `kind` is one of the seven known {@link VIEW_KINDS}. An unknown kind
 *  is NOT an error: Core passes new kinds through verbatim, so an older shell
 *  renders a readable "unsupported view" fallback instead of failing. */
export function isKnownViewKind(
	kind: Parameters<typeof viewKindSchema.safeParse>[0]
): kind is ViewKind {
	return viewKindSchema.safeParse(kind).success;
}

// ── Validation (pure) ────────────────────────────────────────────────────────

/** Result of {@link validateView}: `ok` plus a flat list of human-readable errors. */
export interface ViewValidation {
	errors: string[];
	ok: boolean;
}

/**
 * Structurally validate a value as a {@link ViewSpec} — the gate every renderer runs
 * before dispatch. `spec` is OPAQUE to Core (the Rust `ViewContribution` forwards it
 * verbatim), so a manifest can declare `{"view": "list-detail"}` with no `items`, and
 * a renderer that trusts the discriminant alone dereferences `undefined` and takes the
 * whole shell down with it — in a terminal that means the app's root error boundary,
 * not one broken pane. Checking the required collection here turns that into a
 * readable line.
 *
 * Deliberately shallow (shape, not deep field types): the renderers tolerate missing
 * OPTIONAL fields, so a newer app targeting an older shell degrades to a known-kind
 * empty view rather than an error.
 */
export function validateView(
	value: Parameters<typeof viewSourceRowSchema.safeParse>[0]
): ViewValidation {
	const errors: string[] = [];
	const parsed = viewSourceRowSchema.safeParse(value);
	if (!parsed.success) {
		return { ok: false, errors: ["view spec must be an object"] };
	}
	const record = parsed.data;
	const kind = record.view;
	if (!isKnownViewKind(kind)) {
		return {
			ok: false,
			errors: [`unknown view kind: ${JSON.stringify(kind)}`],
		};
	}
	const requireArray = (key: string) => {
		if (!Array.isArray(record[key])) {
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
			if (!viewTextSchema.min(1).safeParse(record.title).success) {
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

// Parsing schemas mirror the canonical app-host vocabulary; parity is verified in contract tests.
const viewToneSchema = z.enum([
	"neutral",
	"success",
	"warning",
	"danger",
	"info",
]);
const viewActionSchema = z.looseObject({
	id: z.string(),
	label: z.string(),
	confirm: z.string().optional(),
	icon: z.string().optional(),
	intent: z.string().optional(),
	payload: viewPayloadSchema.optional(),
	style: z.enum(["primary", "default", "danger"]).optional(),
	http: z
		.looseObject({
			method: z.enum(VIEW_ACTION_HTTP_METHODS),
			path: z.string(),
			body: viewPayloadSchema.optional(),
		})
		.optional(),
});
const viewBadgeSchema = z.looseObject({
	label: z.string(),
	tone: viewToneSchema.optional(),
});
const viewOptionSchema = z.looseObject({
	label: z.string(),
	value: z.string(),
});
const viewItemSchema = z.looseObject({
	id: z.string(),
	title: z.string(),
	accessory: z.string().optional(),
	actions: z.array(viewActionSchema).optional(),
	avatar: z.string().optional(),
	badges: z.array(viewBadgeSchema).optional(),
	detail: z.string().optional(),
	icon: z.string().optional(),
	subtitle: z.string().optional(),
});
const viewSourceSchema = z.looseObject({
	filter: z
		.array(
			z.looseObject({
				key: z.string(),
				equals: z.string().optional(),
				in: z.array(z.string()).optional(),
				notIn: z.array(z.string()).optional(),
			})
		)
		.optional(),
	http: z.looseObject({
		method: z.literal("GET").optional(),
		path: z.string(),
	}),
	items: z.string().optional(),
	limit: z.number().optional(),
	refreshMs: z.number().optional(),
	total: z.string().optional(),
	map: z
		.looseObject({
			accessory: z.string().optional(),
			avatar: z.string().optional(),
			detail: z.string().optional(),
			icon: z.string().optional(),
			id: z.string().optional(),
			subtitle: z.string().optional(),
			subtitleTransform: z.enum(["basename", "humanize"]).optional(),
			title: z.string().optional(),
			titleFallback: z.string().optional(),
		})
		.optional(),
});

/** Validate renderer-owned fields while retaining forward-compatible public metadata. */
export const viewSpecSchema = z.discriminatedUnion("view", [
	z.looseObject({
		view: z.literal("list-detail"),
		items: z.array(viewItemSchema),
		actions: z.array(viewActionSchema).optional(),
		emptyText: z.string().optional(),
		itemActions: z.array(viewActionSchema).optional(),
		source: viewSourceSchema.optional(),
	}),
	z.looseObject({
		view: z.literal("data-table"),
		actions: z.array(viewActionSchema).optional(),
		emptyText: z.string().optional(),
		columns: z.array(
			z.looseObject({
				id: z.string(),
				header: z.string(),
				align: z.enum(["left", "center", "right"]).optional(),
			})
		),
		rows: z.array(
			z.looseObject({
				id: z.string(),
				cells: z.record(z.string(), z.union([z.string(), z.number()])),
				actions: z.array(viewActionSchema).optional(),
				badges: z.array(viewBadgeSchema).optional(),
			})
		),
	}),
	z.looseObject({
		view: z.literal("form"),
		actions: z.array(viewActionSchema).optional(),
		submit: viewActionSchema.optional(),
		fields: z.array(
			z.looseObject({
				id: z.string(),
				label: z.string(),
				type: z.enum(["text", "textarea", "number", "select", "switch"]),
				options: z.array(viewOptionSchema).optional(),
				placeholder: z.string().optional(),
				required: z.boolean().optional(),
				value: z.union([z.string(), z.number(), z.boolean()]).optional(),
			})
		),
	}),
	z.looseObject({
		view: z.literal("action-panel"),
		actions: z.array(viewActionSchema),
		title: z.string().optional(),
	}),
	z.looseObject({
		view: z.literal("filter-bar"),
		filters: z.array(
			z.looseObject({
				id: z.string(),
				label: z.string(),
				options: z.array(viewOptionSchema),
				value: z.string().optional(),
			})
		),
	}),
	z.looseObject({
		view: z.literal("empty-state"),
		title: z.string(),
		action: viewActionSchema.optional(),
		description: z.string().optional(),
		icon: z.string().optional(),
	}),
	z.looseObject({
		view: z.literal("stat-card-row"),
		stats: z.array(
			z.looseObject({
				id: z.string(),
				label: z.string(),
				value: z.union([z.string(), z.number()]),
				delta: z.string().optional(),
				tone: viewToneSchema.optional(),
			})
		),
	}),
]) satisfies z.ZodType<ViewSpec>;

/** The transport retains malformed or future-kind JSON specs until renderer refinement. */
export const rawViewSpecSchema = z
	.record(z.string(), z.json())
	.and(z.object({ view: z.string() }));
export type RawViewSpec = z.infer<typeof rawViewSpecSchema>;
