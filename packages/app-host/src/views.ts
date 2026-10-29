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

import { z } from "zod";

/** JSON source rows keep optional fields absent when the wire value is unusable. */
export const viewSourceRowSchema = z.record(
	z.string(),
	z.json().optional().catch(undefined)
);
export type ViewSourceRow = z.infer<typeof viewSourceRowSchema>;
/** Body substitution preserves absent values until the host serializes JSON. */
export type ViewTemplateValue =
	| string
	| number
	| boolean
	| null
	| undefined
	| ViewTemplateValue[]
	| { [key: string]: ViewTemplateValue };
const templateValueSchema: z.ZodType<ViewTemplateValue> = z.lazy(() =>
	z.union([
		z.string(),
		z.number(),
		z.boolean(),
		z.null(),
		z.undefined(),
		z.array(templateValueSchema),
		z.record(z.string(), templateValueSchema),
	])
);
const templateValueBoundarySchema = z
	.unknown()
	.transform((value) => templateValueSchema.parse(value));
// Only the envelope shape is checked here. Rows are decoded after applying the
// scan bound, so a large response cannot trigger an eager array clone.
const responseArraySchema = z.custom<unknown[]>(Array.isArray);
const responseObjectSchema = z.record(z.string(), z.unknown());
const objectEnvelopeSchema = z.custom<z.infer<typeof responseObjectSchema>>(
	(value) => z.object({}).safeParse(value).success
);
const responseEnvelopeSchema = z.union([
	responseArraySchema,
	objectEnvelopeSchema,
]);
const responseBoundarySchema = z.unknown().transform((value) => {
	const parsed = responseEnvelopeSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
});
const rowBoundarySchema = z.unknown().transform((value) => {
	const parsed = viewSourceRowSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
});
const rowTextSchema = z.union([
	z.union([z.string(), z.number(), z.boolean()]).transform(String),
	z
		.union([
			z.array(templateValueSchema),
			z.record(z.string(), templateValueSchema),
		])
		.transform((value) => JSON.stringify(value)),
]);
const positiveNumberSchema = z.number().finite().positive();
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

const viewKindSchema = z.enum(VIEW_KINDS);

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

export const VIEW_SOURCE_HTTP_METHODS = ["GET"] as const;
export type ViewSourceHttpMethod = (typeof VIEW_SOURCE_HTTP_METHODS)[number];
export const DECLARATIVE_HTTP_GRANT = "ui:declarative-http";
export const VIEW_SOURCE_LIMITS = Object.freeze({
	defaultRows: 100,
	maxRows: 200,
	maxScanRows: 2000,
	maxRefreshMs: 2_147_483_647,
	minRefreshMs: 1000,
});

const refreshBoundarySchema = z.unknown().transform((value): number | null => {
	const parsed = positiveNumberSchema.safeParse(value);
	if (!parsed.success) {
		return null;
	}
	return Math.min(
		Math.max(Math.floor(parsed.data), VIEW_SOURCE_LIMITS.minRefreshMs),
		VIEW_SOURCE_LIMITS.maxRefreshMs
	);
});
export const normalizeViewRefreshMs = refreshBoundarySchema.parse;

/**
 * A **declarative HTTP handler** for a {@link ViewAction} — the CRUD tier that
 * makes actions work with NO per-app sidecar code. The shell executes the request
 * against the node's Core API through its own authenticated fetch seam (the spec
 * never sees a token). `path` and string leaves of `body` support `{{field}}`
 * templating from collected form values and `{{item.<key>}}` from the selected
 * list/table item (see {@link renderActionHttp}). Paths are Core-relative and
 * must start with `/api/` or an explicitly allowlisted built-in route
 * ({@link isCoreApiPath}) — a spec can never point the host's credentials at an
 * arbitrary URL.
 */
export interface ViewActionHttp {
	/** Optional JSON body template. A string leaf that is exactly one `{{token}}`
	 *  substitutes the RAW value (type-preserving); mixed strings interpolate. */
	body?: unknown;
	method: ViewActionHttpMethod;
	path: string;
}

/** Server-stamped authority for declarative HTTP. Missing/unknown fails closed to
 * the owning app's generic ext-proxy mount; only Core may stamp `"core"`. */
export type ContributionHttpPolicy = "core" | "owner";

/** The provenance fields Core adds to every HTTP-capable contribution. */
export interface ContributionHttpAuthority {
	/** Core-stamped policy. Unknown/missing values are treated as `"owner"`. */
	http_policy?: unknown;
	/** Owning plugin id, stamped by Core rather than accepted from the manifest. */
	plugin?: string;
}

/** A source request that passed the renderer's defensive policy gate. */
export interface ContributionSourceRequest {
	method: "GET";
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
	item?: ViewSourceRow;
	/** Collected form values, keyed by field id. */
	values?: ViewSourceRow;
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
	/** An image URL (`http(s)` or `data:`) drawn as the row's subject — see
	 *  {@link ViewSourceMap.avatar}. */
	avatar?: string;
	badges?: ViewBadge[];
	/** Longer text shown in the detail pane (desktop) / expanded row (island). */
	detail?: string;
	/** A glyph id resolved by the host's Icon primitive — see
	 *  {@link ViewSourceMap.icon}. */
	icon?: string;
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
	/**
	 * Row predicates, ANDed. A spec's `path` is a fixed endpoint, so this is how
	 * ONE endpoint backs several sections that each show a slice of it — Core's
	 * `/api/runs`, for instance, takes no query parameters, yet "Working" and
	 * "Done" are both slices of it by `run_status`. Applied to the RAW response
	 * row before mapping, so it filters on keys the map never surfaces.
	 * Undeclared = every row passes.
	 */
	filter?: ViewSourceFilter[];
	http: {
		/** Defaults to `GET`. */
		method?: ViewSourceHttpMethod;
		/** Authenticated node-relative read path ({@link isCoreReadPath}). */
		path: string;
	};
	/** Key of the row array in the response object. Absent = the response itself
	 *  is the array, else the first array-valued property is used. */
	items?: string;
	/** Keep at most this many rows (after {@link ViewSource.filter}), in response
	 *  order. For an append-only feed like completed runs, the alternative is a
	 *  section that grows without bound. Absent/≤0 = every row. */
	limit?: number;
	/** Field-map from {@link ViewItem} fields to response-row keys. */
	map?: ViewSourceMap;
	/**
	 * Re-fetch interval in milliseconds. A source-backed surface is otherwise a
	 * mount-time snapshot, which is wrong for anything live (a run's status
	 * changes while the sidebar is open). The renderer clamps this to a sane
	 * floor and pauses it when the surface is not visible; absent = fetch once.
	 */
	refreshMs?: number;
	/**
	 * Optional response key containing the authoritative total for the source.
	 * This is used by shared Library/sidebar surfaces when the rows are paged or
	 * capped; it must not be inferred from the rendered page. When absent, the
	 * renderer recognises the conventional `total`, `total_count`, `count`, and
	 * cursor fields without requiring an app-specific declaration.
	 */
	total?: string;
}

/**
 * One row predicate for {@link ViewSource.filter}. Exactly one comparison is
 * honoured, checked in the order below; a filter naming a key the row lacks
 * never matches (so a backend that stops sending a field empties the section
 * rather than silently showing everything).
 *
 * Comparison is against the row value's string form, matching how
 * {@link ViewSourceMap} reads every other field — a spec is JSON and cannot
 * express types.
 */
export interface ViewSourceFilter {
	/** Keep the row when its value equals this. */
	equals?: string;
	/** Keep the row when its value is one of these. */
	in?: string[];
	/** The RAW response-row key to test. */
	key: string;
	/** Keep the row when its value is NOT one of these. */
	notIn?: string[];
}

/**
 * A pure text transform a mapped field may declare. Deliberately a closed enum
 * rather than a pipe syntax in {@link renderTemplate}: that function also renders
 * every existing manifest's action paths and bodies, and widening its token
 * grammar would change how they parse.
 *
 * - `basename` — the last `/` or `\` segment. What turns a run's absolute
 *   `folder_path` into the project name a row can actually show.
 * - `humanize` — a `-`/`_` separated wire token title-cased into display copy
 *   (`evaluator-optimizer` → `Evaluator Optimizer`). What lets a catalog badge
 *   read as a label without the app shipping a second, display-only field.
 */
export type ViewTextTransform = "basename" | "humanize";

/** Maps each {@link ViewItem} field to the response-row key it reads. Defaults:
 *  `id` → `"id"`, `title` → `"title"`, `icon` → `"icon"`; the rest are omitted
 *  unless mapped. */
export interface ViewSourceMap {
	accessory?: string;
	/**
	 * Row key holding a PICTURE for the row — an `http(s)` or `data:` image URL.
	 *
	 * Separate from {@link ViewSourceMap.icon} because they are different render
	 * decisions, not two spellings of one: a glyph is chrome that sits at the row's
	 * text size, while an avatar is the row's subject and makes the row taller and
	 * avatar-led (the shape a roster of named agents/people/bots wants — see
	 * {@link SidebarSectionSpec.rowStyle}). A row that resolves an avatar uses it; a
	 * row that resolves neither falls back to the section's own glyph, so a feed
	 * where only some rows have a picture stays a single coherent list.
	 *
	 * This is the field whose absence used to mean a contributed section could not
	 * draw the avatar-led row the shell's own Agents section draws — the one thing
	 * that made "an app owns its sidebar section" less than true.
	 */
	avatar?: string;
	detail?: string;
	/**
	 * Row key holding a per-row glyph id, resolved by the shell's Icon primitive.
	 *
	 * Defaults to `"icon"`, which is not a style choice: the sidebar renderer read
	 * `row.icon` off the raw row before this field existed, so any other default
	 * would silently drop the glyph from every section already shipping. Declare it
	 * when the feed's own name for the glyph is something else (`glyph`, `symbol`).
	 */
	icon?: string;
	id?: string;
	subtitle?: string;
	/** Transform applied to the mapped `subtitle` value. */
	subtitleTransform?: ViewTextTransform;
	title?: string;
	/** Literal text used when the mapped `title` key is empty/absent. Without it
	 *  such a row is DROPPED (a title is required), which for a live feed means a
	 *  just-started, not-yet-titled run would be missing from the list. */
	titleFallback?: string;
}

/** One source-fetched row: the mapped {@link ViewItem} plus the RAW response row
 *  (the `{{item.<key>}}` templating base for actions fired on it). */
export interface SourceItem {
	item: ViewItem;
	raw: ViewSourceRow;
}

/**
 * Library layouts are a deliberately closed host vocabulary. The wire field is
 * still a string so a newer app can pass through a future kind without breaking
 * an older shell; the desktop resolves only the entries registered here.
 */
export const LIBRARY_VIEW_KINDS = [
	"board",
	"kanban",
	"data-table",
	"database",
	"calendar",
	"map",
	"feed",
	"timeline",
	"list",
	"gallery",
	"table",
	"card",
	"custom",
] as const;

export type LibraryViewKind = (typeof LIBRARY_VIEW_KINDS)[number];

export type LibraryViewRenderer =
	| "board"
	| "calendar"
	| "card"
	| "custom"
	| "feed"
	| "gallery"
	| "list"
	| "map"
	| "table"
	| "timeline";

interface LibraryViewDefinition {
	kind: LibraryViewKind;
	renderer: LibraryViewRenderer;
}

/** Pure registry: aliases are explicit, and unknown values remain unsupported. */
export const LIBRARY_VIEW_REGISTRY: readonly LibraryViewDefinition[] = [
	{ kind: "board", renderer: "board" },
	{ kind: "kanban", renderer: "board" },
	{ kind: "data-table", renderer: "table" },
	{ kind: "database", renderer: "table" },
	{ kind: "calendar", renderer: "calendar" },
	{ kind: "map", renderer: "map" },
	{ kind: "feed", renderer: "feed" },
	{ kind: "timeline", renderer: "timeline" },
	{ kind: "list", renderer: "list" },
	{ kind: "gallery", renderer: "gallery" },
	{ kind: "table", renderer: "table" },
	{ kind: "card", renderer: "card" },
	{ kind: "custom", renderer: "custom" },
] as const;

const libraryViewKindSchema = z.enum(LIBRARY_VIEW_KINDS);
export function isKnownLibraryViewKind<T>(
	kind: T
): kind is T & LibraryViewKind {
	return libraryViewKindSchema.safeParse(kind).success;
}
const libraryViewDefinitionSchema = z.unknown().transform((kind) => {
	const parsed = libraryViewKindSchema.safeParse(kind);
	return parsed.success
		? LIBRARY_VIEW_REGISTRY.find((entry) => entry.kind === parsed.data)
		: undefined;
});
export const libraryViewDefinition = libraryViewDefinitionSchema.parse;

/**
 * The opaque `spec` of a manifest `sidebar_sections` contribution (the Rust
 * `SidebarSectionContribution`). The desktop's compact sidebar renderer reads it so
 * an app owns its sidebar section instead of the shell hardcoding it:
 * - `source` supplies the live rows, fetched through the host's authenticated Core
 *   seam and mapped via {@link sourceItemsFromResponse} — the same primitive a
 *   `list-detail` view uses. A row whose mapped `subtitle` resolves non-empty
 *   renders as a TALLER two-line row (title over subtitle); one without keeps the
 *   default single-line height, so a section mixing both stays scannable.
 * - `itemTarget` is a route template opened via `openTab`, filled with the clicked
 *   row using {@link renderTemplate} (e.g. `"/spaces/{{item.spaceId}}/canvas/{{item.id}}"`).
 *   Client navigation is not expressible as a {@link ViewAction}, so it lives here.
 * - `itemActions` are per-row context-menu actions (reusing {@link ViewAction}).
 * - `create` is the "+" action; its response id (`targetFrom`) feeds `itemTarget`
 *   to open the new row (create-and-open), else the section re-fetches its source.
 */
/** The "+" affordance of a contributed sidebar section. A list can either create
 * through the authenticated Core HTTP seam, or navigate to the owning app's
 * create surface. Keeping these as a union prevents a manifest from accidentally
 * firing a request and navigating at the same time. */
export type SidebarSectionCreate =
	| {
			http: ViewActionHttp;
			icon?: string;
			label?: string;
			/** Response key holding the created row's id; feeds `itemTarget` to open it.
			 *  Absent = create then re-fetch (no auto-open). */
			target?: never;
			targetFrom?: string;
	  }
	| {
			/** App-owned route opened through the shell's normal tab seam. */
			target: string;
			icon?: string;
			label?: string;
			http?: never;
			targetFrom?: never;
	  };

export interface SidebarSectionSpec {
	/**
	 * Mount-context fields to pass to the owning Companion when a row opens it.
	 * Keys are the app's context names and values are keys in the raw source row.
	 * The host only applies this map to the contribution's own Companion surface;
	 * it never spreads arbitrary row data into another route.
	 */
	context?: Record<string, string>;
	create?: SidebarSectionCreate;
	/**
	 * Response-row key holding each row's timestamp, so the section can honour the
	 * user's "Group lists by date" preference (Today / Yesterday / Last week / …)
	 * exactly like the shell's own lists do. Epoch milliseconds or an ISO string.
	 *
	 * OPTIONAL, and absent does not mean opted out: the renderer probes the common
	 * stamp names Core already serves (`updatedAt`, `created_at`, `lastMessageAt`, …)
	 * so a section written before this field existed still groups. Declare it when
	 * the feed's own name for time is not one of those, or when the row carries
	 * several stamps and only one is the right axis to group by (a run's
	 * `startedAt` rather than the record's `updatedAt`). A declared key is taken at
	 * its word — the renderer will not fall back to a different one behind your
	 * back — and a row that resolves no stamp lands in an explicit "Undated" bucket
	 * rather than being back-dated into "Older".
	 *
	 * Ignored entirely while the preference is off, which is the default.
	 */
	dateKey?: string;
	/**
	 * What the section shows when its source returns no rows. Absent = the whole
	 * section is hidden, which is right for a passive list (an app with no
	 * documents should not leave a phantom header) but wrong for a section whose
	 * emptiness is the ANSWER — "nothing is running" is information, and a user
	 * who opted an app in expects the sections it promised to exist.
	 */
	emptyState?: {
		/** Muted line under the title. */
		description?: string;
		title: string;
		/**
		 * Shown INSTEAD of `title` when the source could not be read at all — a
		 * route gated behind an app the user has not enabled, or a node that is
		 * down. Both cases return zero rows, and "nothing is waiting on you" is a
		 * false statement about an endpoint nobody answered. Absent = the ordinary
		 * empty copy, which is right for a source that cannot fail this way.
		 */
		unavailable?: string;
	};
	/** Entity identity for each mapped row. Matching `context_menu_items` are
	 * rendered in the row menu and receive the mapped row id under `idKey`. */
	entity?: {
		anchor: string;
		idKey: string;
	};
	/** Per-row context-menu actions (delete, rename, …). */
	itemActions?: ViewAction[];
	/**
	 * Optional hover preview for each row. Templates use the same `{{item.*}}`
	 * vocabulary as `itemTarget`. When set, the shell shows a right-side
	 * HoverCard with the full title (wrapping) plus optional description/meta
	 * instead of an overflow-only tooltip.
	 */
	itemPreview?: {
		/** Longer body under the title (e.g. `{{item.summary}}`). */
		description?: string;
		/** Key/value rows under the description (branch, path, …). */
		meta?: Array<{ label: string; value: string }>;
		/** Override the preview title template; defaults to the row's display title. */
		title?: string;
	};
	/** Route template opened when a row is clicked. */
	itemTarget?: string;
	/**
	 * How each row draws — the same two shapes the shell's own Agents section
	 * offers, so an app's roster can look like the shell's instead of approximating
	 * it with a subtitle:
	 *
	 * - `"compact"` (default) — one line, leading glyph, taller only when the row
	 *   resolved a `subtitle`. What every section shipped before this field.
	 * - `"messaging"` — a WhatsApp/Telegram-shaped row: a two-line-tall round
	 *   avatar on the left ({@link ViewSourceMap.avatar}), title and `accessory`
	 *   (a stamp) on the first line, `subtitle` (a last-message preview) below.
	 *
	 * Declared per SECTION, not per sidebar mode, because it is a property of this
	 * feed: a roster of named bots wants avatars whether the user is in Bot mode
	 * or reading the section stacked among fifteen others. A `"messaging"` section
	 * whose rows resolve no avatar still draws the two-line row, falling back to
	 * the section glyph — that is a feed missing a picture, not a reason to
	 * silently change layout row by row.
	 */
	rowStyle?: "compact" | "messaging";
	/** Live rows for the section (same primitive `list-detail` uses). */
	source?: ViewSource;
	/** Optional host-owned Library layout. Absent preserves the historical cards. */
	view?: LibraryViewKind | string;
}

/** The render-mode vocabulary of a manifest `dock_panels` contribution — the
 *  discriminant the desktop dock renderer switches on. Mirrors the vocabulary
 *  documented on the Rust `DockPanelContribution::panel`, which keeps the field a
 *  bare string so an unknown member survives an older Core intact. */
/** Maps a {@link StoreCatalogItem}'s fields to the response-row keys they read.
 *  Extends {@link ViewSourceMap} with the card-specific fields a marketplace row
 *  needs. Defaults: `id` → `"id"`, `title` → `"name"` then `"title"`,
 *  `description` → `"description"`. */
export interface StoreItemMap {
	/** Row key holding a short badge string (a pattern, a duration, a kind). */
	badge?: string;
	/** Transform applied to the mapped `badge` value — `"humanize"` turns a wire
	 *  token (`evaluator-optimizer`) into display copy (`Evaluator Optimizer`).
	 *  Opt-in per tab: a badge that is already prose must not be re-cased. */
	badgeTransform?: ViewTextTransform;
	/** Row key holding the card's supporting text. */
	description?: string;
	/** Row key holding a per-item glyph id, overriding the tab's icon. */
	icon?: string;
	id?: string;
	/** Row key holding a boolean "already installed" flag. */
	installed?: string;
	/** Row key holding an external "learn more" URL shown in the detail pane. */
	sourceUrl?: string;
	/** Row key holding a string[] of tags rendered as outline badges. */
	tags?: string;
	title?: string;
}

/** How a {@link StoreTabSpec} item is installed — one declarative HTTP call plus
 *  what the shell does with the response. */
export interface StoreInstallSpec {
	/** The request. `{{item.<key>}}` resolves against the RAW catalog row. */
	http: ViewActionHttp;
	/** Button label; defaults to `"Install"`. */
	label?: string;
	/** Route template opened via `openTab` after a successful install. Resolves
	 *  `{{result.<key>}}` from the response and `{{item.<key>}}` from the row. */
	openTarget?: string;
	/** Toast title on success; defaults to `"Installed"`. */
	successMessage?: string;
	/** Response key holding the created resource's id, feeding `openTarget`. */
	targetFrom?: string;
}

/**
 * A **read-only node/edge graph** drawn in the detail pane from the per-item
 * detail payload. The one thing a marketplace card could not say declaratively:
 * a workflow template is its shape, and a list of node names is not a picture of
 * it. Every key is a response-key name, so an app whose graph calls its endpoints
 * `source`/`target` declares that instead of renaming its API.
 */
export interface StoreDetailGraphSpec {
	/** Edge-row key holding the branch/condition label drawn on the edge. */
	edgeLabel?: string;
	/** Edge-row key holding the source node id (default `"from"`). */
	edgeSource?: string;
	/** Response key holding the edge array (default `"edges"`). */
	edges?: string;
	/** Edge-row key holding the target node id (default `"to"`). */
	edgeTarget?: string;
	/** Node-row key holding the node id (default `"id"`). */
	nodeId?: string;
	/** Node-row key holding the node's label (default: the id). */
	nodeLabel?: string;
	/** Response key holding the node array (default `"nodes"`). */
	nodes?: string;
	/** Heading above the graph (default `"Graph"`). */
	title?: string;
}

/**
 * What the detail pane shows BEYOND the card's own fields, fetched per selection.
 *
 * This is the seam that retired the shell's `view` allowlist: the Workflows tab
 * used to claim a first-party component purely so its preview could draw the
 * template graph, which meant the one tab that proved apps can own a Store
 * section was also the one tab hardcoded into the closed desktop source. A
 * declared `source` + `graph` gives every app the same preview, so no future app
 * needs an entry in a table it cannot edit.
 */
export interface StoreDetailSpec {
	/** Drawn from the fetched payload (or, with no `source`, from the row). */
	graph?: StoreDetailGraphSpec;
	/** Key of the detail object inside the response envelope — Core's template
	 *  route answers `{"template": {...}}`. Absent = the response IS the object.
	 *  The list side's {@link ViewSource.items} for a single object. */
	item?: string;
	/** Fetched when a row is selected. `{{item.<key>}}` resolves against the RAW
	 *  catalog row, so a per-item path like `/api/x/{{item.id}}` works. */
	source?: { http: ViewActionHttp };
}

/**
 * The opaque `spec` of a manifest `store_tabs` contribution (the Rust
 * `StoreTabContribution`). The desktop Store renders it so an app owns its
 * marketplace section instead of the shell hardcoding one — the same relationship
 * {@link SidebarSectionSpec} has to the sidebar, and it reuses the same primitives:
 * a {@link ViewSource} for the rows, `{{item.*}}` templating for actions, and
 * {@link ViewAction} for per-item extras.
 *
 * What a marketplace section needs beyond a sidebar list is grouping (cards fall
 * into labelled category rows), search over declared row keys, and an install
 * affordance with a post-install destination — hence {@link StoreTabSpec.groupBy},
 * {@link StoreTabSpec.searchFields} and {@link StoreTabSpec.install}.
 *
 * Search here is PER-TAB (the section's own search field). The store-wide
 * cross-realm search is a closed union of first-party realms and does not index
 * contributed tabs.
 */
export interface StoreTabSpec {
	/** Per-item detail fetched on selection, and how to draw it. */
	detail?: StoreDetailSpec;
	/** Copy for the empty state. */
	empty?: { description?: string; title?: string };
	/** Row key whose value splits the cards into labelled sections. */
	groupBy?: string;
	/** Display order + labels for `groupBy` values. A value not listed here still
	 *  renders, in a trailing group titled by the raw value — an app must never
	 *  lose rows for forgetting a label. */
	groups?: { label: string; value: string }[];
	/** The install affordance. Absent = a browse-only tab. */
	install?: StoreInstallSpec;
	/** Extra per-item actions (card context menu + detail pane). */
	itemActions?: ViewAction[];
	/** Field-map from the card/detail fields to response-row keys. */
	map?: StoreItemMap;
	/** Extra row keys folded into the search haystack, on top of the mapped
	 *  title/description/tags. */
	searchFields?: string[];
	searchPlaceholder?: string;
	/** Live catalog rows (same primitive a `list-detail` view uses). */
	source?: ViewSource;
}

export const DOCK_PANEL_KINDS = ["companion", "view", "native"] as const;

export type DockPanelKind = (typeof DOCK_PANEL_KINDS)[number];

/**
 * The opaque `spec` of a manifest `dock_panels` contribution (the Rust
 * `DockPanelContribution`). Which key is read depends on the entry's `panel`
 * discriminant, so every field is optional:
 * - `panel: "companion"` reads {@link DockPanelSpec.companion} — the id of the
 *   companion runnable whose sandboxed surface mounts inside the dock chrome.
 * - `panel: "view"` reads {@link DockPanelSpec.view} — the id of one of the same
 *   plugin's `contributes.views` entries, rendered with the host's own components.
 * - `panel: "native"` reads nothing: the shell resolves its OWN component registered
 *   under `<plugin>/<id>`. That is the migration seam for first-party apps whose panel
 *   is hand-written React driving their sidecar through the ext-proxy (Browser,
 *   Simulator) — the component stays in the shell, but the tab's existence, label and
 *   placement become the app's declaration, so disabling the app removes the tab.
 *
 * `emptyText` is the placeholder a renderer shows before the panel has content (or
 * when a `native` panel has no registered component), and is read for every mode.
 */
export interface DockPanelSpec {
	/** Companion runnable id mounted by a `panel: "companion"` entry. */
	companion?: string;
	/** Placeholder shown while the panel has nothing to draw. */
	emptyText?: string;
	/**
	 * Optional host link bridge. A panel may claim URL schemes and name an
	 * authenticated endpoint on its own ext-proxy mount. The desktop uses this
	 * declaration to open chat links without hardcoding an app id.
	 */
	linkHandler?: {
		bodyKey?: string;
		method?: "POST" | "PUT";
		path: string;
		schemes: string[];
	};
	/** Id of a sibling `contributes.views` entry, for a `panel: "view"` entry. */
	view?: string;
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
	/** Gateway-approved grants for direct host HTTP sources/actions. */
	approved_grants?: string[];
	/** Core-stamped declarative HTTP authority. */
	http_policy?: unknown;
	id: string;
	/** Owning plugin id, added by Core's contributions endpoint. */
	plugin?: string;
	spec?: ViewSpec;
	title?: string;
	view: ViewKind | string;
}

// ── Templating + source mapping ───────────────────────

/** `{{token}}` — `token` is a form-field id or `item.<key>`. */
const TEMPLATE_TOKEN = /\{\{\s*([\w.-]+)\s*\}\}/g;

/** Matches a string that is EXACTLY one template token (raw substitution). */
const SOLE_TEMPLATE_TOKEN = /^\{\{\s*([\w.-]+)\s*\}\}$/;

function resolveToken(
	token: string,
	ctx: ViewActionContext
): ViewTemplateValue {
	if (token.startsWith("item.")) {
		return ctx.item?.[token.slice("item.".length)];
	}
	return ctx.values?.[token];
}

function stringifyToken(value: ViewTemplateValue): string {
	if (value === null || value === undefined) {
		return "";
	}
	const parsed = rowTextSchema.safeParse(value);
	return parsed.success ? parsed.data : "";
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
function renderBody(
	body: ViewTemplateValue,
	ctx: ViewActionContext
): ViewTemplateValue {
	const string = z.string().safeParse(body);
	if (string.success) {
		const body = string.data;
		const sole = SOLE_TEMPLATE_TOKEN.exec(body);
		if (sole?.[1]) {
			return resolveToken(sole[1], ctx);
		}
		return renderTemplate(body, ctx);
	}
	if (Array.isArray(body)) {
		return body.map((entry) => renderBody(entry, ctx));
	}
	const object = z.record(z.string(), templateValueSchema).safeParse(body);
	if (object.success) {
		const out: { [key: string]: ViewTemplateValue } = {};
		for (const [key, value] of Object.entries(object.data)) {
			out[key] = renderBody(value, ctx);
		}
		return out;
	}
	return body;
}

/** True when `path` is a safe Core-relative API path a declarative action or
 *  source may target: it must start with `/api/`, or be one of the explicitly
 *  allowlisted built-in Core routes, and contain no `..` segment, so a spec can
 *  never point the host's node credentials elsewhere. */
export function isCoreApiPath(path: string): boolean {
	if (!isCoreReadPath(path)) {
		return false;
	}
	const pathname = path.split(/[?#]/, 1)[0] ?? "";
	return (
		pathname.startsWith("/api/") ||
		pathname === "/workflows" ||
		pathname.startsWith("/workflows/")
	);
}

/** True when a declarative data source can safely read a path on the selected
 * node. Reads may use a node's established non-`/api` routes, but remain rooted
 * on that node and may not traverse upward. Mutating actions deliberately keep
 * the narrower {@link isCoreApiPath} contract. */
export function isCoreReadPath(path: string): boolean {
	const unpairedSurrogate =
		/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
	const hasForbiddenCharacter = (value: string): boolean =>
		[...value].some((character) => {
			const code = character.charCodeAt(0);
			return character === "\\" || code <= 0x1f || code === 0x7f;
		});
	if (
		!path.startsWith("/") ||
		path.startsWith("//") ||
		path.length > 4096 ||
		unpairedSurrogate.test(path) ||
		hasForbiddenCharacter(path)
	) {
		return false;
	}
	const pathname = path.split(/[?#]/, 1)[0] ?? "";
	let decoded = pathname;
	try {
		// Decode the path (not a decoded query delimiter) to a fixed point so nested
		// encodings cannot hide traversal from a downstream URL parser.
		for (let pass = 0; pass <= pathname.length; pass += 1) {
			const next = decodeURIComponent(decoded);
			if (next === decoded) {
				break;
			}
			decoded = next;
		}
	} catch {
		return false;
	}
	if (
		decoded.startsWith("//") ||
		hasForbiddenCharacter(decoded) ||
		decoded.includes("://")
	) {
		return false;
	}
	const segments = decoded.split("/");
	if (segments.some((segment) => segment === "." || segment === "..")) {
		return false;
	}
	// A leading `user@host` path has credential-shaped URL authority syntax. It
	// has no valid node-route use and is rejected even though apiUrl concatenates.
	return !/^\/[^/]*@[^/]*(?:\/|$)/.test(decoded);
}

const sourceMethodSchema = z.enum(VIEW_SOURCE_HTTP_METHODS);
export function isViewSourceHttpMethod<T>(
	method: T
): method is T & ViewSourceHttpMethod {
	return sourceMethodSchema.safeParse(method).success;
}

/** Whether a server-tagged contribution may address `path` with the node bearer.
 * Community/old-Core payloads are confined to their own generic ext mount. */
export function isContributionHttpPathAllowed(
	authority: ContributionHttpAuthority,
	path: string
): boolean {
	if (!(authority.plugin && isCoreApiPath(path))) {
		return false;
	}
	if (authority.http_policy === "core") {
		return true;
	}
	const ownerMount = `/api/ext/${authority.plugin}`;
	if (!isCoreApiPath(ownerMount)) {
		return false;
	}
	const pathname = new URL(path, "http://ryu.invalid").pathname;
	return pathname === ownerMount || pathname.startsWith(`${ownerMount}/`);
}

/** Refine an automatic declarative source to the only legal wire form: a GET
 * under the contribution's Core-approved path authority. */
export function contributionSourceRequest(
	authority: ContributionHttpAuthority,
	source: ViewSource | undefined
): ContributionSourceRequest | null {
	if (!source) {
		return null;
	}
	const method = source.http.method ?? "GET";
	if (
		method !== "GET" ||
		!isContributionHttpPathAllowed(authority, source.http.path)
	) {
		return null;
	}
	return { method, path: source.http.path };
}

/** A fully-rendered declarative HTTP action, ready for the host's fetch seam. */
export interface RenderedActionHttp {
	body?: ViewTemplateValue;
	method: ViewActionHttpMethod;
	path: string;
}

/**
 * Render a {@link ViewActionHttp} against the fired action's context: the path
 * templates with URI-encoding, the body templates type-preservingly. Throws when
 * the rendered path is not a safe Core-relative path ({@link isCoreApiPath}).
 */
export function renderActionHttp(
	http: ViewActionHttp,
	ctx: ViewActionContext
): RenderedActionHttp {
	const path = renderTemplate(http.path, ctx, { uriEncode: true });
	if (!isCoreApiPath(path)) {
		throw new Error(`declarative action path is not allowlisted: ${path}`);
	}
	return {
		method: http.method,
		path,
		body:
			http.body === undefined
				? undefined
				: renderBody(templateValueBoundarySchema.parse(http.body), ctx),
	};
}

/** Render an action and then apply the owning contribution's path authority.
 * This is the defensive client twin of Core's authoritative manifest gate. */
export function renderContributionActionHttp(
	authority: ContributionHttpAuthority,
	http: ViewActionHttp,
	ctx: ViewActionContext
): RenderedActionHttp {
	if (!z.enum(VIEW_ACTION_HTTP_METHODS).safeParse(http.method).success) {
		throw new Error(
			`declarative action method is not allowlisted: ${http.method}`
		);
	}
	const rendered = renderActionHttp(http, ctx);
	if (!isContributionHttpPathAllowed(authority, rendered.path)) {
		throw new Error(
			`declarative action path is outside the owning app authority: ${rendered.path}`
		);
	}
	return rendered;
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
	const parsed = rowTextSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

/** Split on either separator so a Windows path yields its basename too. */
const PATH_SEPARATOR_RE = /[\\/]/;

/** Word boundaries in a wire token, for the `humanize` transform. */
const TOKEN_SEPARATOR_RE = /[-_\s]+/;

/** Apply a {@link ViewTextTransform} to an already-stringified field value. */
function transformText(
	value: string | undefined,
	transform: ViewTextTransform | undefined
): string | undefined {
	if (value === undefined) {
		return value;
	}
	if (transform === "humanize") {
		const words = value
			.split(TOKEN_SEPARATOR_RE)
			.filter(Boolean)
			.map((word) => word.charAt(0).toUpperCase() + word.slice(1));
		return words.length === 0 ? undefined : words.join(" ");
	}
	if (transform !== "basename") {
		return value;
	}
	// Trailing separators would otherwise yield an empty basename.
	const trimmed = value.replace(/[\\/]+$/, "");
	const base = trimmed.split(PATH_SEPARATOR_RE).pop();
	return base === undefined || base === "" ? undefined : base;
}

/** True when `row` satisfies every declared predicate. A filter whose key is
 *  absent from the row never matches — see {@link ViewSourceFilter}. */
const sourceFilterSchema = z.object({
	key: z.string(),
	equals: z.unknown().optional(),
	in: z.unknown().optional(),
	notIn: z.unknown().optional(),
});
const sourceFiltersSchema = z.array(sourceFilterSchema);
function rowMatchesFilters(
	row: ViewSourceRow,
	filters: ViewSourceFilter[] | undefined
): boolean {
	if (filters === undefined) {
		return true;
	}
	const parsed = sourceFiltersSchema.safeParse(filters);
	if (!parsed.success) {
		return false;
	}
	return parsed.data.every((filter) => {
		const value = rowText(row, filter.key);
		if (value === undefined) {
			return false;
		}
		const equals = z.string().safeParse(filter.equals);
		if (equals.success) {
			return value === equals.data;
		}
		const included = z.array(z.string()).safeParse(filter.in);
		if (included.success) {
			return included.data.includes(value);
		}
		const excluded = z.array(z.string()).safeParse(filter.notIn);
		if (excluded.success) {
			return !excluded.data.includes(value);
		}
		return (
			filter.equals === undefined &&
			filter.in === undefined &&
			filter.notIn === undefined
		);
	});
}
/** Select the array before validating rows, so one malformed optional value cannot discard its siblings. */
function responseRows(
	payload: z.input<typeof responseBoundarySchema>,
	key?: string
): unknown[] | null {
	const envelope = responseBoundarySchema.parse(payload);
	if (envelope === null) {
		return null;
	}
	if (Array.isArray(envelope)) {
		return envelope;
	}
	const candidate = key
		? envelope[key]
		: Object.values(envelope).find(Array.isArray);
	const parsed = responseArraySchema.safeParse(candidate);
	return parsed.success ? parsed.data : null;
}

/**
 * Map a source-fetch response payload to renderable {@link SourceItem}s per the
 * source's `items` key + field-map, honouring its `filter` and `limit`.
 * Deliberately forgiving: rows without a usable id/title are skipped, a
 * non-array payload yields `[]` — a bad backend response degrades to the empty
 * state, never a crash.
 */
export function sourceItemsFromResponse(
	source: ViewSource,
	payload: z.input<typeof responseBoundarySchema>
): SourceItem[] {
	const rows = responseRows(payload, source.items);
	if (!rows) {
		return [];
	}
	const map = source.map ?? {};
	const parsedLimit = positiveNumberSchema.safeParse(source.limit);
	const limit = parsedLimit.success
		? Math.min(Math.floor(parsedLimit.data), VIEW_SOURCE_LIMITS.maxRows)
		: VIEW_SOURCE_LIMITS.defaultRows;
	const out: SourceItem[] = [];
	for (const wireRow of rows.slice(0, VIEW_SOURCE_LIMITS.maxScanRows)) {
		const row = rowBoundarySchema.parse(wireRow);
		if (!(row && rowMatchesFilters(row, source.filter))) {
			continue;
		}
		const id = rowText(row, map.id ?? "id");
		const title = rowText(row, map.title ?? "title") || map.titleFallback;
		if (!(id && title)) {
			continue;
		}
		out.push({
			raw: row,
			item: {
				id,
				title,
				subtitle: transformText(
					rowText(row, map.subtitle),
					map.subtitleTransform
				),
				detail: rowText(row, map.detail),
				accessory: rowText(row, map.accessory),
				// `icon` defaults to the "icon" key the sidebar renderer read off the
				// raw row before this was mappable — see ViewSourceMap.icon.
				avatar: rowText(row, map.avatar),
				icon: rowText(row, map.icon ?? "icon"),
			},
		});
		if (out.length >= limit) {
			break;
		}
	}
	return out;
}

/**
 * Read the total row count for a source response without confusing a rendered
 * page with the collection total. A cursor or an explicit row limit means the
 * response is not safe to count from its array; callers get `null` until the
 * producer supplies `source.total` (or a conventional total field).
 */
export function sourceTotalFromResponse(
	source: ViewSource,
	payload: z.input<typeof responseBoundarySchema>
): number | null {
	const envelope = responseBoundarySchema.parse(payload);
	if (envelope === null) {
		return null;
	}
	if (Array.isArray(envelope)) {
		if (
			source.limit !== undefined &&
			source.limit > 0 &&
			envelope.length >= source.limit
		) {
			return null;
		}
		return envelope.length;
	}

	const keys = [
		source.total,
		"total",
		"total_count",
		"totalCount",
		"count",
	].filter((key): key is string => Boolean(key));
	for (const key of keys) {
		const value = envelope[key];
		const parsed = z.number().finite().nonnegative().safeParse(value);
		if (parsed.success) {
			return Math.floor(parsed.data);
		}
	}

	const cursor = envelope.next_cursor ?? envelope.nextCursor ?? envelope.cursor;
	if (cursor !== null && cursor !== undefined && cursor !== "") {
		return null;
	}

	const rows = responseRows(envelope, source.items);
	if (!rows) {
		return null;
	}
	if (
		source.limit !== undefined &&
		source.limit > 0 &&
		rows.length >= source.limit
	) {
		return null;
	}
	return rows.length;
}

/** One catalog row a {@link StoreTabSpec} renders as a card, plus the RAW response
 *  row that `{{item.<key>}}` templating resolves against. */
export interface StoreCatalogItem {
	badge?: string;
	description?: string;
	/** The `groupBy` value this row fell into ("" when the tab is ungrouped). */
	group: string;
	icon?: string;
	id: string;
	/** True when the row itself reports the item is already installed. */
	installed: boolean;
	raw: ViewSourceRow;
	sourceUrl?: string;
	tags: string[];
	title: string;
}

function rowStrings(row: ViewSourceRow, key?: string): string[] {
	if (!key) {
		return [];
	}
	const value = row[key];
	if (!Array.isArray(value)) {
		return [];
	}
	return value.flatMap((candidate) => {
		const parsed = z.string().safeParse(candidate);
		return parsed.success ? [parsed.data] : [];
	});
}

/**
 * Map a catalog response to renderable {@link StoreCatalogItem}s per the tab's
 * `source.items` key and `map`. Forgiving in the same way
 * {@link sourceItemsFromResponse} is — a row without a usable id/title is skipped
 * and a non-array payload yields `[]`, so a backend the shell cannot parse degrades
 * to the empty state rather than a crash.
 *
 * `title` falls back through `name` → `title` because catalog payloads across the
 * first-party apps use both spellings, and an app should not have to declare a `map`
 * for the common case.
 */
export function storeItemsFromResponse(
	spec: StoreTabSpec,
	payload: z.input<typeof responseBoundarySchema>
): StoreCatalogItem[] {
	const source = spec.source;
	const rows = responseRows(payload, source?.items);
	if (!rows) {
		return [];
	}
	const map = spec.map ?? {};
	const out: StoreCatalogItem[] = [];
	for (const wireRow of rows) {
		const row = rowBoundarySchema.parse(wireRow);
		if (!row) {
			continue;
		}
		const id = rowText(row, map.id ?? "id");
		const title =
			rowText(row, map.title ?? "name") ?? rowText(row, map.title ?? "title");
		if (!(id && title)) {
			continue;
		}
		out.push({
			badge: transformText(rowText(row, map.badge), map.badgeTransform),
			description: rowText(row, map.description ?? "description"),
			group: spec.groupBy ? (rowText(row, spec.groupBy) ?? "") : "",
			icon: rowText(row, map.icon),
			id,
			installed: map.installed ? row[map.installed] === true : false,
			raw: row,
			sourceUrl: rowText(row, map.sourceUrl),
			tags: rowStrings(row, map.tags),
			title,
		});
	}
	return out;
}

/** Read a contributed Store tab's authoritative total without counting its page. */
export function storeTotalFromResponse(
	spec: StoreTabSpec,
	payload: z.input<typeof responseBoundarySchema>
): number | null {
	return spec.source ? sourceTotalFromResponse(spec.source, payload) : null;
}

/** One node of a {@link StoreDetailGraphSpec} graph, already mapped. */
export interface StoreGraphNode {
	id: string;
	label: string;
}

/** One edge of a {@link StoreDetailGraphSpec} graph, already mapped. */
export interface StoreGraphEdge {
	/** Branch/condition drawn on the edge; absent when unmapped or empty. */
	label?: string;
	source: string;
	target: string;
}

/** A mapped graph shared by every Store detail renderer. */
export interface StoreGraph {
	edges: StoreGraphEdge[];
	nodes: StoreGraphNode[];
}

/** Unwrap a detail response to the object the {@link StoreDetailSpec} describes:
 *  `spec.item` names the envelope key, absent means the payload itself. */
export function storeDetailObject(
	spec: StoreDetailSpec,
	payload: z.input<typeof responseBoundarySchema>
): ViewTemplateValue {
	if (!spec.item) {
		const parsed = templateValueSchema.safeParse(payload);
		return parsed.success ? parsed.data : undefined;
	}
	return rowBoundarySchema.parse(payload)?.[spec.item];
}
function graphRows(
	payload: z.input<typeof responseBoundarySchema>,
	key: string
): ViewSourceRow[] {
	const envelope = responseBoundarySchema.parse(payload);
	if (envelope === null || Array.isArray(envelope)) {
		return [];
	}
	const rows = responseRows(envelope, key);
	return (
		rows?.flatMap((row) => {
			const parsed = rowBoundarySchema.parse(row);
			return parsed === null ? [] : [parsed];
		}) ?? []
	);
}

/**
 * Map a detail payload to the graph a renderer draws. Forgiving like every other
 * mapper here: a payload whose arrays are missing or whose rows carry no usable
 * ids yields an empty graph, so the detail pane simply omits the picture rather
 * than throwing on a backend the shell cannot parse. Edges pointing at nodes that
 * are not in the payload are dropped — a dangling edge would otherwise render as
 * an arrow from nowhere.
 */
export function storeGraphFromResponse(
	spec: StoreDetailGraphSpec,
	payload: z.input<typeof responseBoundarySchema>
): StoreGraph {
	const idKey = spec.nodeId ?? "id";
	const nodes: StoreGraphNode[] = [];
	const seen = new Set<string>();
	for (const row of graphRows(payload, spec.nodes ?? "nodes")) {
		const id = rowText(row, idKey);
		if (!id || seen.has(id)) {
			continue;
		}
		seen.add(id);
		nodes.push({ id, label: rowText(row, spec.nodeLabel ?? idKey) ?? id });
	}

	const sourceKey = spec.edgeSource ?? "from";
	const targetKey = spec.edgeTarget ?? "to";
	const edges: StoreGraphEdge[] = [];
	for (const row of graphRows(payload, spec.edges ?? "edges")) {
		const source = rowText(row, sourceKey);
		const target = rowText(row, targetKey);
		if (!(source && target && seen.has(source) && seen.has(target))) {
			continue;
		}
		const label = spec.edgeLabel ? rowText(row, spec.edgeLabel) : undefined;
		edges.push({ label: label || undefined, source, target });
	}
	return { edges, nodes };
}

/** The searchable haystack for one catalog item: its title, description, badge,
 *  tags and any extra `searchFields` row keys, lowercased and joined. */
export function storeItemHaystack(
	spec: StoreTabSpec,
	item: StoreCatalogItem
): string {
	const parts = [item.title, item.description, item.badge, ...item.tags];
	for (const key of spec.searchFields ?? []) {
		parts.push(rowText(item.raw, key));
	}
	return parts.filter(Boolean).join(" ").toLowerCase();
}

/** A labelled card section produced by {@link groupStoreItems}. */
export interface StoreCatalogGroup {
	items: StoreCatalogItem[];
	label: string;
	value: string;
}

/**
 * Split items into the tab's declared `groups`, in declared order, then append one
 * trailing group per `groupBy` value the spec did not declare (labelled by the raw
 * value). Undeclared values are NEVER dropped: an app that adds a category to its
 * backend before updating its manifest would otherwise silently lose those cards.
 * An ungrouped tab yields a single unlabelled group.
 */
export function groupStoreItems(
	spec: StoreTabSpec,
	items: StoreCatalogItem[]
): StoreCatalogGroup[] {
	if (!spec.groupBy) {
		return items.length ? [{ items, label: "", value: "" }] : [];
	}
	const declared = spec.groups ?? [];
	const seen = new Set(declared.map((g) => g.value));
	const out: StoreCatalogGroup[] = declared.map((g) => ({
		items: items.filter((i) => i.group === g.value),
		label: g.label,
		value: g.value,
	}));
	for (const item of items) {
		if (seen.has(item.group)) {
			continue;
		}
		seen.add(item.group);
		out.push({
			items: items.filter((i) => i.group === item.group),
			label: item.group || "Other",
			value: item.group,
		});
	}
	return out.filter((g) => g.items.length > 0);
}

// ── Validation ────────────────────────────────────────

/** Result of {@link validateView}: `ok` plus a flat list of human-readable errors. */
export interface ViewValidation {
	errors: string[];
	ok: boolean;
}

/** True when the untrusted discriminant belongs to the closed host vocabulary. */
export function isKnownViewKind<T>(kind: T): kind is T & ViewKind {
	return viewKindSchema.safeParse(kind).success;
}
const viewEnvelopeSchema = z
	.object({ view: z.unknown().optional() })
	.passthrough();
/** Validate the collections required by each known renderer without rejecting future fields. */
const viewValidationSchema = z.unknown().transform((value): ViewValidation => {
	const parsed = viewEnvelopeSchema.safeParse(value);
	if (!parsed.success) {
		return { ok: false, errors: ["view spec must be an object"] };
	}
	const kind = parsed.data.view;
	if (!isKnownViewKind(kind)) {
		return {
			ok: false,
			errors: [`unknown view kind: ${JSON.stringify(kind)}`],
		};
	}
	const errors: string[] = [];
	const requireArray = (key: string) => {
		if (!Array.isArray(parsed.data[key])) {
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
			if (!z.string().min(1).safeParse(parsed.data.title).success) {
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
});
export const validateView = viewValidationSchema.parse;

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
	payload: z.unknown().optional(),
	style: z.enum(["primary", "default", "danger"]).optional(),
	http: z
		.looseObject({
			method: z.enum(VIEW_ACTION_HTTP_METHODS),
			path: z.string(),
			body: z.unknown().optional(),
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
export const viewSourceSchema = z.looseObject({
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

/** A transport envelope deliberately retains unknown and malformed JSON specs for renderer fallback. */
export const rawViewContributionSchema = z.looseObject({
	id: z.string(),
	view: z.string(),
	spec: z.json().optional(),
	title: z.string().optional(),
	plugin: z.string().optional(),
	approved_grants: z.array(z.string()).optional(),
	http_policy: z.json().optional(),
});
export type RawViewContribution = z.infer<typeof rawViewContributionSchema>;

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
