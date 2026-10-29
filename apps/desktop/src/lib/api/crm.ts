import {
	jsonResponseDocumentSchema,
	jsonResponseValueSchema,
} from "@ryu/app-host/json-values";
import { z } from "zod";
import type { GatewayJsonValue } from "./gateway-json-contracts.ts";
// The desktop client for Harbor (`@ryu/crm`) — the object-first CRM sidecar.
//
// This is a `panel: "native"` dock contribution (the `@ryu/browser` /
// `@ryu/simulator` / `@ryu/ugc` precedent), NOT a sandboxed companion, so the panel
// reaches the sidecar over ordinary `fetch` against Core's proxy. A companion frame
// runs under CSP `connect-src 'none'` and could only reach the sidecar through
// per-app RPC verbs in `rpc.ts` + `kernel-contracts` — exactly the per-app Core
// coupling an apps-store satellite must not require. Nothing here touches that
// bridge, which is why adding Harbor cost Core two generic registration lines.
//
// Data path: `/api/crm/*` DIRECTLY. The manifest declares `http.public_mount`, so
// Core mounts the sidecar at that prefix. Every path below must ALSO appear in the
// manifest's `sidecars[0].http.routes[]` — Core's ext-proxy 404s an undeclared path
// before it ever reaches the sidecar, so a route added here and forgotten there
// fails at runtime with a 404 that looks like a missing handler.
//
// Casing: the sidecar serializes snake_case and these types mirror it verbatim
// rather than camel-casing at the boundary. That is deliberate and matches
// `UgcPanel`: field values are keyed by USER-DEFINED field slugs inside `values`,
// so a blanket key transform would rewrite user data — a field a user named
// `first_name` would silently become `firstName` on the way in and fail to match on
// the way back out. Rather than special-case the value bag inside a general
// transform, the whole surface stays snake_case.
//
// Money is integer cents on the wire and stays integer until the render edge
// divides once. No currency arithmetic happens in floats.

import type { ApiTarget } from "@/src/lib/api/client.ts";
import { authenticatedFetch, makeHeaders } from "@/src/lib/api/client.ts";

/** The app that owns this surface. Feature detection keys off it. */
export const CRM_PLUGIN_ID = "@ryu/crm";

/** The sidecar's public mount. Every path below is relative to this. */
const CRM_BASE = "/api/crm";

// ── Wire types ───────────────────────────────────────────────────────────────
// Optional fields are optional on purpose: the panel degrades to a placeholder
// rather than crashing when the sidecar is a version ahead of or behind this build.

/** Every field type the schema editor can create. Kept as a union rather than an
 *  enum so an unknown type from a newer sidecar narrows to `string` at the render
 *  edge instead of throwing. */
export type FieldType =
	| "checkbox"
	| "currency"
	| "date"
	| "datetime"
	| "email"
	| "long_text"
	| "multi_select"
	| "number"
	| "percent"
	| "phone"
	| "rating"
	| "relation"
	| "select"
	| "status"
	| "text"
	| "url"
	| "user";

export type ViewKind = "board" | "list" | "table";

export type ActivityKind =
	| "call"
	| "field_change"
	| "meeting"
	| "note"
	| "stage_change"
	| "task";

/** A choice on a select/status/multi_select field.
 *
 *  `is_won` / `is_lost` are only meaningful on a `status` field: they are what let
 *  the pipeline report compute a win rate without anyone hardcoding the string
 *  "Won", and what lets a board hide closed columns. */
export interface SelectOption {
	color?: string | null;
	id: string;
	is_lost?: boolean;
	is_won?: boolean;
	label: string;
	position: number;
}

export interface FieldConfig {
	currency_code?: string | null;
	default_value?: unknown;
	max_length?: number | null;
	max_rating?: number | null;
	options?: SelectOption[];
	precision?: number | null;
	relation_inverse_label?: string | null;
	relation_multiple?: boolean;
	relation_object_id?: string | null;
}

export interface Field {
	config?: FieldConfig;
	created_at: string;
	description?: string | null;
	field_type: FieldType;
	id: string;
	is_required: boolean;
	is_system: boolean;
	is_unique: boolean;
	/** Set only for a LIST-specific field — an attribute that exists inside one
	 *  curated list rather than on the object itself. Null for an object field. */
	list_id?: string | null;
	name: string;
	object_id: string;
	position: number;
	slug: string;
	updated_at: string;
}

export interface CrmObject {
	created_at: string;
	description?: string | null;
	icon?: string | null;
	id: string;
	is_standard: boolean;
	plural: string;
	position: number;
	singular: string;
	slug: string;
	/** Which field renders as the record's title. Optional because a freshly
	 *  created custom object may not have one yet. */
	title_field_id?: string | null;
	updated_at: string;
}

export type SortDirection = "asc" | "desc";

export interface ViewSort {
	direction?: SortDirection;
	field_id: string;
}

/** Externally tagged, exactly as the sidecar's `ViewFilter` serializes: a filter is
 *  a TREE, not a flat list, so `and`/`or`/`not` nest arbitrarily. */
export type ViewFilter =
	| { and: { filters: ViewFilter[] } }
	| { condition: FilterCondition }
	| { not: { filter: ViewFilter } }
	| { or: { filters: ViewFilter[] } };

export interface FilterCondition {
	field_id: string;
	op: string;
	value: unknown;
}

export interface View {
	created_at: string;
	filter?: ViewFilter | null;
	/** Which field a board groups its columns by. Required in practice for
	 *  `kind: "board"`; null on a table or list view. */
	group_by_field_id?: string | null;
	id: string;
	is_default: boolean;
	kind: ViewKind;
	name: string;
	object_id: string;
	position: number;
	sorts?: ViewSort[];
	updated_at: string;
	visible_field_ids?: string[];
}

/** A record's field values, keyed by field SLUG.
 *
 *  `unknown` rather than a union because the value's shape is decided by its
 *  field's type at runtime, and narrowing belongs at the one render/edit seam that
 *  already knows the field. */
export type ValueBag = Record<string, GatewayJsonValue>;

export interface CrmRecord {
	created_at: string;
	created_by?: string | null;
	/** Non-null means SOFT-deleted and restorable, which is a different state from
	 *  absent. The list routes exclude these unless `include_deleted` is set. */
	deleted_at?: string | null;
	id: string;
	object_id: string;
	title: string;
	updated_at: string;
	values?: ValueBag;
}

export interface CrmList {
	created_at: string;
	description?: string | null;
	icon?: string | null;
	id: string;
	name: string;
	object_id: string;
	position: number;
	updated_at: string;
}

export interface ListEntry {
	created_at: string;
	id: string;
	list_id: string;
	position: number;
	record_id: string;
	updated_at: string;
	/** The LIST-specific values — a deal's stage inside this one sales list, kept
	 *  separate from the object's own status field on purpose. */
	values?: ValueBag;
}

export interface Activity {
	assignee?: string | null;
	author?: string | null;
	body?: string | null;
	completed_at?: string | null;
	created_at: string;
	due_at?: string | null;
	/** Set on `field_change` / `stage_change` entries, which the STORE writes on
	 *  every mutation — they are an audit trail, not something a user authors. */
	field_id?: string | null;
	from_value?: unknown;
	id: string;
	kind: ActivityKind;
	object_id?: string | null;
	record_id?: string | null;
	title?: string;
	to_value?: unknown;
	updated_at: string;
}

export interface ObjectWithFields {
	fields: Field[];
	object: CrmObject;
	record_count: number;
	views: View[];
}

export interface SchemaResponse {
	lists: CrmList[];
	objects: ObjectWithFields[];
}

export interface Page<T> {
	has_more: boolean;
	items: T[];
	limit: number;
	offset: number;
	total: number;
}

export interface SearchHit {
	object_id: string;
	object_slug: string;
	rank: number;
	record_id: string;
	snippet: string;
	title: string;
}

export interface PipelineStage {
	color?: string | null;
	is_lost: boolean;
	is_won: boolean;
	label: string;
	option_id: string;
	position: number;
	record_count: number;
	share: number;
	value_cents: number;
}

export interface PipelineReport {
	currency_code: string;
	field_id: string;
	lost_count: number;
	lost_value_cents: number;
	object_id: string;
	stages: PipelineStage[];
	total_records: number;
	total_value_cents: number;
	unassigned_count: number;
	value_field_id?: string | null;
	win_rate: number;
	won_count: number;
	won_value_cents: number;
}

export interface ImportColumn {
	index: number;
	name: string;
	samples: string[];
	suggested_field_id?: string | null;
}

export interface ImportMapping {
	column_index: number;
	/** `null` means "do not import this column" — an explicit decision, distinct
	 *  from a column nobody has looked at yet. */
	field_id: string | null;
}

export interface ImportConflict {
	existing: unknown;
	field_id: string;
	field_slug: string;
	incoming: unknown;
	record_id: string;
	row_index: number;
}

export interface ImportPreview {
	conflicts?: ImportConflict[];
	create_count: number;
	error_count: number;
	skip_count: number;
	total_rows: number;
	/** True when the sample list was capped — the counts above are still exact for
	 *  the whole file, only the per-row detail is partial. */
	truncated?: boolean;
	unmapped_columns?: string[];
	update_count: number;
}

export interface ImportResult {
	created: number;
	created_record_ids?: string[];
	failed: number;
	skipped: number;
	updated: number;
	updated_record_ids?: string[];
}

export interface ImportJob {
	columns: ImportColumn[];
	created_at: string;
	dedupe?: { match_field_ids: string[]; strategy: string };
	delimiter: string;
	error?: string | null;
	filename?: string | null;
	has_header: boolean;
	id: string;
	mappings?: ImportMapping[];
	object_id: string;
	preview?: ImportPreview | null;
	result?: ImportResult | null;
	row_count: number;
	status: "applied" | "draft" | "failed" | "previewed";
	updated_at: string;
}

export interface RecordQuery {
	filter?: ViewFilter | null;
	include_deleted?: boolean;
	limit?: number;
	list_id?: string | null;
	object_id?: string;
	offset?: number;
	search?: string | null;
	sorts?: ViewSort[];
}

// Reply contracts mirror apps-store/crm/backend/src/models.rs; optional serde fields stay optional.
const fieldTypeSchema = z.enum([
	"checkbox",
	"currency",
	"date",
	"datetime",
	"email",
	"long_text",
	"multi_select",
	"number",
	"percent",
	"phone",
	"rating",
	"relation",
	"select",
	"status",
	"text",
	"url",
	"user",
]);
const viewKindSchema = z.enum(["board", "list", "table"]);
const activityKindSchema = z.enum([
	"call",
	"field_change",
	"meeting",
	"note",
	"stage_change",
	"task",
]);
const sortDirectionSchema = z.enum(["asc", "desc"]);
const filterConditionSchema = z.looseObject({
	field_id: z.string(),
	op: z.string(),
	value: jsonResponseValueSchema,
});
const viewFilterSchema: z.ZodType<ViewFilter> = z.lazy(() =>
	z.union([
		z.looseObject({
			and: z.looseObject({ filters: z.array(viewFilterSchema) }),
		}),
		z.looseObject({
			or: z.looseObject({ filters: z.array(viewFilterSchema) }),
		}),
		z.looseObject({ not: z.looseObject({ filter: viewFilterSchema }) }),
		z.looseObject({ condition: filterConditionSchema }),
		z
			.looseObject({
				type: z.literal("and"),
				filters: z.array(viewFilterSchema),
			})
			.transform((tree): ViewFilter => ({ and: { filters: tree.filters } })),
		z
			.looseObject({
				type: z.literal("or"),
				filters: z.array(viewFilterSchema),
			})
			.transform((tree): ViewFilter => ({ or: { filters: tree.filters } })),
		z
			.looseObject({ type: z.literal("not"), filter: viewFilterSchema })
			.transform((tree): ViewFilter => ({ not: { filter: tree.filter } })),
		filterConditionSchema.extend({ type: z.literal("condition") }).transform(
			(tree): ViewFilter => ({
				condition: {
					field_id: tree.field_id,
					op: tree.op,
					value: tree.value,
				},
			})
		),
	])
);
const selectOptionSchema = z.looseObject({
	color: z.union([z.string(), z.null()]).optional(),
	id: z.string(),
	is_lost: z.boolean().optional(),
	is_won: z.boolean().optional(),
	label: z.string(),
	position: z.number(),
}) satisfies z.ZodType<SelectOption>;
const fieldConfigSchema = z.looseObject({
	currency_code: z.union([z.string(), z.null()]).optional(),
	default_value: jsonResponseValueSchema.optional(),
	max_length: z.union([z.number(), z.null()]).optional(),
	max_rating: z.union([z.number(), z.null()]).optional(),
	options: z.array(selectOptionSchema).optional(),
	precision: z.union([z.number(), z.null()]).optional(),
	relation_inverse_label: z.union([z.string(), z.null()]).optional(),
	relation_multiple: z.boolean().optional(),
	relation_object_id: z.union([z.string(), z.null()]).optional(),
}) satisfies z.ZodType<FieldConfig>;
const fieldSchema = z.looseObject({
	config: fieldConfigSchema.optional(),
	created_at: z.string(),
	description: z.union([z.string(), z.null()]).optional(),
	field_type: fieldTypeSchema,
	id: z.string(),
	is_required: z.boolean(),
	is_system: z.boolean(),
	is_unique: z.boolean(),
	list_id: z.union([z.string(), z.null()]).optional(),
	name: z.string(),
	object_id: z.string(),
	position: z.number(),
	slug: z.string(),
	updated_at: z.string(),
}) satisfies z.ZodType<Field>;
const crmObjectSchema = z.looseObject({
	created_at: z.string(),
	description: z.union([z.string(), z.null()]).optional(),
	icon: z.union([z.string(), z.null()]).optional(),
	id: z.string(),
	is_standard: z.boolean(),
	plural: z.string(),
	position: z.number(),
	singular: z.string(),
	slug: z.string(),
	title_field_id: z.union([z.string(), z.null()]).optional(),
	updated_at: z.string(),
}) satisfies z.ZodType<CrmObject>;
const viewSortSchema = z.looseObject({
	direction: sortDirectionSchema.optional(),
	field_id: z.string(),
}) satisfies z.ZodType<ViewSort>;
const viewSchema = z.looseObject({
	created_at: z.string(),
	filter: z.union([viewFilterSchema, z.null()]).optional(),
	group_by_field_id: z.union([z.string(), z.null()]).optional(),
	id: z.string(),
	is_default: z.boolean(),
	kind: viewKindSchema,
	name: z.string(),
	object_id: z.string(),
	position: z.number(),
	sorts: z.array(viewSortSchema).optional(),
	updated_at: z.string(),
	visible_field_ids: z.array(z.string()).optional(),
}) satisfies z.ZodType<View>;
const crmRecordSchema = z.looseObject({
	created_at: z.string(),
	created_by: z.union([z.string(), z.null()]).optional(),
	deleted_at: z.union([z.string(), z.null()]).optional(),
	id: z.string(),
	object_id: z.string(),
	title: z.string(),
	updated_at: z.string(),
	values: jsonResponseDocumentSchema.optional(),
}) satisfies z.ZodType<CrmRecord>;
const crmListSchema = z.looseObject({
	created_at: z.string(),
	description: z.union([z.string(), z.null()]).optional(),
	icon: z.union([z.string(), z.null()]).optional(),
	id: z.string(),
	name: z.string(),
	object_id: z.string(),
	position: z.number(),
	updated_at: z.string(),
}) satisfies z.ZodType<CrmList>;
const listEntrySchema = z.looseObject({
	created_at: z.string(),
	id: z.string(),
	list_id: z.string(),
	position: z.number(),
	record_id: z.string(),
	updated_at: z.string(),
	values: jsonResponseDocumentSchema.optional(),
}) satisfies z.ZodType<ListEntry>;
const activitySchema = z.looseObject({
	assignee: z.union([z.string(), z.null()]).optional(),
	author: z.union([z.string(), z.null()]).optional(),
	body: z.union([z.string(), z.null()]).optional(),
	completed_at: z.union([z.string(), z.null()]).optional(),
	created_at: z.string(),
	due_at: z.union([z.string(), z.null()]).optional(),
	field_id: z.union([z.string(), z.null()]).optional(),
	from_value: jsonResponseValueSchema.optional(),
	id: z.string(),
	kind: activityKindSchema,
	object_id: z.union([z.string(), z.null()]).optional(),
	record_id: z.union([z.string(), z.null()]).optional(),
	title: z.string().optional(),
	to_value: jsonResponseValueSchema.optional(),
	updated_at: z.string(),
}) satisfies z.ZodType<Activity>;
const objectWithFieldsSchema = z.union([
	z.looseObject({
		object: crmObjectSchema,
		fields: z.array(fieldSchema),
		views: z.array(viewSchema),
		record_count: z.number(),
	}),
	crmObjectSchema
		.extend({
			fields: z.array(fieldSchema),
			views: z.array(viewSchema),
			record_count: z.number(),
		})
		.transform((row) => {
			const { fields, views, record_count, ...object } = row;
			return { ...row, object, fields, views, record_count };
		}),
]) satisfies z.ZodType<ObjectWithFields>;
const schemaResponseSchema = z.looseObject({
	lists: z.array(crmListSchema),
	objects: z.array(objectWithFieldsSchema),
}) satisfies z.ZodType<SchemaResponse>;
const searchHitSchema = z.looseObject({
	object_id: z.string(),
	object_slug: z.string(),
	rank: z.number(),
	record_id: z.string(),
	snippet: z.string(),
	title: z.string(),
}) satisfies z.ZodType<SearchHit>;
const pipelineStageSchema = z.looseObject({
	color: z.union([z.string(), z.null()]).optional(),
	is_lost: z.boolean(),
	is_won: z.boolean(),
	label: z.string(),
	option_id: z.string(),
	position: z.number(),
	record_count: z.number(),
	share: z.number(),
	value_cents: z.number(),
}) satisfies z.ZodType<PipelineStage>;
const pipelineReportSchema = z.looseObject({
	currency_code: z.string(),
	field_id: z.string(),
	lost_count: z.number(),
	lost_value_cents: z.number(),
	object_id: z.string(),
	stages: z.array(pipelineStageSchema),
	total_records: z.number(),
	total_value_cents: z.number(),
	unassigned_count: z.number(),
	value_field_id: z.union([z.string(), z.null()]).optional(),
	win_rate: z.number(),
	won_count: z.number(),
	won_value_cents: z.number(),
}) satisfies z.ZodType<PipelineReport>;
const importColumnSchema = z.looseObject({
	index: z.number(),
	name: z.string(),
	samples: z.array(z.string()),
	suggested_field_id: z.union([z.string(), z.null()]).optional(),
}) satisfies z.ZodType<ImportColumn>;
const importMappingSchema = z.looseObject({
	column_index: z.number(),
	field_id: z.union([z.string(), z.null()]),
}) satisfies z.ZodType<ImportMapping>;
const importConflictSchema = z.looseObject({
	existing: jsonResponseValueSchema,
	field_id: z.string(),
	field_slug: z.string(),
	incoming: jsonResponseValueSchema,
	record_id: z.string(),
	row_index: z.number(),
}) satisfies z.ZodType<ImportConflict>;
const importPreviewSchema = z.looseObject({
	conflicts: z.array(importConflictSchema).optional(),
	create_count: z.number(),
	error_count: z.number(),
	skip_count: z.number(),
	total_rows: z.number(),
	truncated: z.boolean().optional(),
	unmapped_columns: z.array(z.string()).optional(),
	update_count: z.number(),
}) satisfies z.ZodType<ImportPreview>;
const importResultSchema = z.looseObject({
	created: z.number(),
	created_record_ids: z.array(z.string()).optional(),
	failed: z.number(),
	skipped: z.number(),
	updated: z.number(),
	updated_record_ids: z.array(z.string()).optional(),
}) satisfies z.ZodType<ImportResult>;
const importJobSchema = z.looseObject({
	columns: z.array(importColumnSchema),
	created_at: z.string(),
	dedupe: z
		.looseObject({ match_field_ids: z.array(z.string()), strategy: z.string() })
		.optional(),
	delimiter: z.string(),
	error: z.union([z.string(), z.null()]).optional(),
	filename: z.union([z.string(), z.null()]).optional(),
	has_header: z.boolean(),
	id: z.string(),
	mappings: z.array(importMappingSchema).optional(),
	object_id: z.string(),
	preview: z.union([importPreviewSchema, z.null()]).optional(),
	result: z.union([importResultSchema, z.null()]).optional(),
	row_count: z.number(),
	status: z.enum(["applied", "draft", "failed", "previewed"]),
	updated_at: z.string(),
}) satisfies z.ZodType<ImportJob>;
const relatedGroupSchema = z.looseObject({
	field_id: z.string(),
	field_name: z.string(),
	object_slug: z.string(),
	records: z.array(crmRecordSchema),
}) satisfies z.ZodType<RelatedGroup>;
const duplicateGroupSchema = z.looseObject({
	field_id: z.string(),
	records: z.array(crmRecordSchema),
}) satisfies z.ZodType<DuplicateGroup>;
const crmSummarySchema = z.looseObject({
	open_tasks: z.number(),
	overdue_tasks: z.number(),
	recent_activity: z.array(activitySchema),
	total_records: z.number(),
}) satisfies z.ZodType<CrmSummary>;
function pageSchema<Schema extends z.ZodType>(item: Schema) {
	return z.looseObject({
		items: z.array(item),
		has_more: z.boolean(),
		limit: z.number(),
		offset: z.number(),
		total: z.number(),
	});
}
const recordPageSchema = pageSchema(crmRecordSchema);
const viewResultSchema = z.union([
	recordPageSchema,
	z
		.looseObject({ page: recordPageSchema })
		.transform((reply) => ({ ...reply, ...reply.page })),
]);
const recordResultSchema = z.union([
	crmRecordSchema,
	z
		.looseObject({ record: crmRecordSchema })
		.transform((reply) => ({ ...reply, ...reply.record })),
	z
		.looseObject({ survivor: crmRecordSchema })
		.transform((reply) => ({ ...reply, ...reply.survivor })),
]);
const relatedReplySchema = z.looseObject({
	groups: z.array(relatedGroupSchema),
});
const duplicatesReplySchema = z.looseObject({
	groups: z.array(duplicateGroupSchema),
});
const searchReplySchema = z.looseObject({ hits: z.array(searchHitSchema) });
/** Every CRM delete answers HTTP 200 `{"ok": true, …}` (never 204 — see
 *  `apps-store/crm/backend/src/api/{objects,records}.rs`). */
const deleteReplySchema = z.looseObject({ ok: z.boolean() });
/** `RecordUpdate` (`apps-store/crm/backend/src/models.rs`): link/unlink answer
 *  the same shape as a PATCH because a relation edit IS a field edit. */
const recordUpdateSchema = z.looseObject({
	changed: z.array(z.looseObject({})),
	record: crmRecordSchema,
	stage_change: z.looseObject({}).optional(),
});

// ── Transport ────────────────────────────────────────────────────────────────

/** Thrown for any non-2xx. Carries the status so a caller can tell "the app is
 *  disabled" (the proxy 404s an unmounted plugin) from "that record is gone" (a
 *  handler 404) by looking at what it asked for. */
export class CrmError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "CrmError";
		this.status = status;
	}
}

interface RequestInitLite {
	body?: unknown;
	method?: string;
	/** Raw text body (CSV upload). Mutually exclusive with `body`. */
	raw?: string;
	signal?: AbortSignal;
}

async function send<Schema extends z.ZodType>(
	target: ApiTarget,
	path: string,
	codec: Schema,
	init?: RequestInitLite
): Promise<z.output<Schema>> {
	const headers = makeHeaders(target.token, target.userJwt);
	if (init?.raw !== undefined) {
		headers["Content-Type"] = "text/csv";
	}
	const response = await authenticatedFetch(target, `${CRM_BASE}${path}`, {
		body:
			init?.raw ??
			(init?.body === undefined ? undefined : JSON.stringify(init.body)),
		headers,
		method: init?.method ?? "GET",
		signal: init?.signal,
	});
	if (!response.ok) {
		// The sidecar's error type serializes `{error: "..."}`; a proxy-level
		// failure may not be JSON at all, so fall back to the status text rather
		// than letting a parse error mask the real one.
		let detail = response.statusText;
		try {
			const parsed = z
				.object({ error: z.string().optional() })
				.parse(await response.json());
			if (parsed?.error) {
				detail = parsed.error;
			}
		} catch {
			// Non-JSON body — keep the status text.
		}
		throw new CrmError(response.status, detail);
	}
	return codec.parse(
		response.status === 204 ? undefined : await response.json()
	);
}

const enc = encodeURIComponent;

/**
 * Bind every endpoint to one node.
 *
 * A factory rather than free functions because the base URL and bearer come from
 * the ACTIVE NODE, which changes at runtime — Core listens on :7980 locally but the
 * selected node may be remote. Callers build this once per node with
 * `useMemo(() => createCrmClient(toTarget(node)), [node])` so a node switch
 * re-binds rather than silently querying the previous one.
 */
export function createCrmClient(target: ApiTarget) {
	return {
		// ── Schema ───────────────────────────────────────────────────────────
		/** The panel's boot call: every object with its fields, views and record
		 *  count, plus the curated lists. One round-trip, not N+1 per object. */
		getSchema: (signal?: AbortSignal) =>
			send(target, "/schema", schemaResponseSchema, { signal }),

		createObject: (body: Partial<CrmObject>) =>
			send(target, "/objects", crmObjectSchema, { body, method: "POST" }),

		updateObject: (slug: string, body: Partial<CrmObject>) =>
			send(target, `/objects/${enc(slug)}`, crmObjectSchema, {
				body,
				method: "PATCH",
			}),

		deleteObject: (slug: string) =>
			send(target, `/objects/${enc(slug)}`, deleteReplySchema, {
				method: "DELETE",
			}),

		createField: (slug: string, body: Partial<Field>) =>
			send(target, `/objects/${enc(slug)}/fields`, fieldSchema, {
				body,
				method: "POST",
			}),

		updateField: (fieldId: string, body: Partial<Field>) =>
			send(target, `/fields/${enc(fieldId)}`, fieldSchema, {
				body,
				method: "PATCH",
			}),

		deleteField: (fieldId: string) =>
			send(target, `/fields/${enc(fieldId)}`, deleteReplySchema, {
				method: "DELETE",
			}),

		reorderFields: (slug: string, fieldIds: string[]) =>
			send(
				target,
				`/objects/${enc(slug)}/fields/reorder`,
				z.array(fieldSchema),
				{
					// `ReorderRequest { ids }` in the CRM backend.
					body: { ids: fieldIds },
					method: "POST",
				}
			),

		// ── Records ──────────────────────────────────────────────────────────
		/** The one read every grid and board goes through. Takes the SAME
		 *  filter/sort shape a view stores, so "run this view" and "run an ad-hoc
		 *  query" are one code path rather than two that can drift. */
		queryRecords: (slug: string, query: RecordQuery, signal?: AbortSignal) =>
			send(target, `/objects/${enc(slug)}/records/query`, recordPageSchema, {
				body: query,
				method: "POST",
				signal,
			}),

		createRecord: (slug: string, values: ValueBag) =>
			send(target, `/objects/${enc(slug)}/records`, recordResultSchema, {
				body: { values },
				method: "POST",
			}),

		getRecord: (recordId: string, signal?: AbortSignal) =>
			send(target, `/records/${enc(recordId)}`, recordResultSchema, { signal }),

		/** Merges: fields not named are left alone, so a single-cell edit sends one
		 *  key and cannot clobber a column the grid was not showing. */
		updateRecord: (recordId: string, values: ValueBag) =>
			send(target, `/records/${enc(recordId)}`, recordResultSchema, {
				body: { mode: "merge", values },
				method: "PATCH",
			}),

		deleteRecord: (recordId: string) =>
			send(target, `/records/${enc(recordId)}`, deleteReplySchema, {
				method: "DELETE",
			}),

		restoreRecord: (recordId: string) =>
			send(target, `/records/${enc(recordId)}/restore`, recordResultSchema, {
				method: "POST",
			}),

		getRelated: (recordId: string, signal?: AbortSignal) =>
			send(target, `/records/${enc(recordId)}/related`, relatedReplySchema, {
				signal,
			}),

		link: (recordId: string, fieldId: string, targetIds: string[]) =>
			send(target, `/records/${enc(recordId)}/links`, recordUpdateSchema, {
				// `LinkRequest { field_id, target_record_ids }` in the CRM backend.
				body: { field_id: fieldId, target_record_ids: targetIds },
				method: "POST",
			}),

		unlink: (recordId: string, fieldId: string, targetIds: string[]) =>
			send(target, `/records/${enc(recordId)}/unlink`, recordUpdateSchema, {
				// `LinkRequest { field_id, target_record_ids }` in the CRM backend.
				body: { field_id: fieldId, target_record_ids: targetIds },
				method: "POST",
			}),

		findDuplicates: (slug: string, signal?: AbortSignal) =>
			send(target, `/objects/${enc(slug)}/duplicates`, duplicatesReplySchema, {
				signal,
			}),

		mergeRecords: (body: {
			loser_ids: string[];
			resolutions?: { field_id: string; source: string }[];
			survivor_id: string;
		}) => send(target, "/merge", recordResultSchema, { body, method: "POST" }),

		// ── Views & lists ────────────────────────────────────────────────────
		createView: (slug: string, body: Partial<View>) =>
			send(target, `/objects/${enc(slug)}/views`, viewSchema, {
				body,
				method: "POST",
			}),

		updateView: (viewId: string, body: Partial<View>) =>
			send(target, `/views/${enc(viewId)}`, viewSchema, {
				body,
				method: "PATCH",
			}),

		deleteView: (viewId: string) =>
			send(target, `/views/${enc(viewId)}`, deleteReplySchema, {
				method: "DELETE",
			}),

		setDefaultView: (viewId: string) =>
			send(target, `/views/${enc(viewId)}/default`, viewSchema, {
				method: "POST",
			}),

		/** Run a saved view server-side, so the board and the grid agree on what
		 *  the view MEANS without either re-deriving its filter locally. */
		runView: (
			viewId: string,
			overrides?: Partial<RecordQuery>,
			signal?: AbortSignal
		) =>
			send(target, `/views/${enc(viewId)}/run`, viewResultSchema, {
				body: overrides ?? {},
				method: "POST",
				signal,
			}),

		createList: (body: Partial<CrmList>) =>
			send(target, "/lists", crmListSchema, { body, method: "POST" }),

		queryListEntries: (
			listId: string,
			query?: RecordQuery,
			signal?: AbortSignal
		) =>
			send(
				target,
				`/lists/${enc(listId)}/entries/query`,
				pageSchema(listEntrySchema),
				{
					body: query ?? {},
					method: "POST",
					signal,
				}
			),

		addListEntry: (listId: string, recordId: string) =>
			send(target, `/lists/${enc(listId)}/entries`, listEntrySchema, {
				body: { record_id: recordId },
				method: "POST",
			}),

		updateListEntry: (entryId: string, values: ValueBag) =>
			send(target, `/list-entries/${enc(entryId)}`, listEntrySchema, {
				body: { values },
				method: "PATCH",
			}),

		// ── Timeline ─────────────────────────────────────────────────────────
		getTimeline: (recordId: string, limit?: number, signal?: AbortSignal) =>
			send(
				target,
				`/records/${enc(recordId)}/activities${limit ? `?limit=${limit}` : ""}`,
				pageSchema(activitySchema),
				{ signal }
			),

		logActivity: (body: {
			assignee?: string;
			body?: string;
			due_at?: string;
			kind: ActivityKind;
			record_id?: string;
			title: string;
		}) => send(target, "/activities", activitySchema, { body, method: "POST" }),

		completeActivity: (activityId: string, completed: boolean) =>
			send(target, `/activities/${enc(activityId)}/complete`, activitySchema, {
				body: { completed },
				method: "POST",
			}),

		deleteActivity: (activityId: string) =>
			send(target, `/activities/${enc(activityId)}`, deleteReplySchema, {
				method: "DELETE",
			}),

		/** The cross-object task inbox. The window (overdue / today / upcoming) is
		 *  bucketed by the SERVER against the offset sent here, so the panel never
		 *  does date maths of its own and two clients in different zones agree. */
		getTasks: (
			params?: {
				assignee?: string;
				limit?: number;
				window?: "overdue" | "today" | "upcoming";
			},
			signal?: AbortSignal
		) => {
			const search = new URLSearchParams();
			if (params?.window) {
				search.set("window", params.window);
			}
			if (params?.assignee) {
				search.set("assignee", params.assignee);
			}
			if (params?.limit) {
				search.set("limit", String(params.limit));
			}
			search.set("utc_offset_minutes", String(-new Date().getTimezoneOffset()));
			return send(
				target,
				`/tasks?${search.toString()}`,
				pageSchema(activitySchema),
				{
					signal,
				}
			);
		},

		// ── Import / export ──────────────────────────────────────────────────
		/** Upload raw CSV text. The sidecar persists the bytes with the job so
		 *  preview and apply are two requests over the SAME file, not two uploads. */
		createImport: (slug: string, csv: string, filename?: string) =>
			send(
				target,
				`/imports?object=${enc(slug)}${
					filename ? `&filename=${enc(filename)}` : ""
				}`,
				importJobSchema,
				{ method: "POST", raw: csv }
			),

		getImport: (importId: string) =>
			send(target, `/imports/${enc(importId)}`, importJobSchema),

		setImportMapping: (
			importId: string,
			body: {
				dedupe?: { match_field_ids: string[]; strategy?: string };
				mappings: ImportMapping[];
			}
		) =>
			send(target, `/imports/${enc(importId)}/mapping`, importJobSchema, {
				body,
				method: "PUT",
			}),

		/** The dry run. Nothing is written; the counts are exact for the whole file
		 *  even when the per-row sample list is truncated. */
		previewImport: (importId: string) =>
			send(target, `/imports/${enc(importId)}/preview`, importPreviewSchema, {
				method: "POST",
			}),

		/** Idempotent per job — applying twice does not double-create. */
		applyImport: (importId: string) =>
			send(target, `/imports/${enc(importId)}/apply`, importResultSchema, {
				method: "POST",
			}),

		deleteImport: (importId: string) =>
			send(target, `/imports/${enc(importId)}`, deleteReplySchema, {
				method: "DELETE",
			}),

		/** CSV of a view's current result set. Raw text, not JSON. */
		exportView: async (viewId: string): Promise<string> => {
			const response = await authenticatedFetch(
				target,
				`${CRM_BASE}/exports/views/${enc(viewId)}`
			);
			if (!response.ok) {
				throw new CrmError(response.status, response.statusText);
			}
			return await response.text();
		},

		// ── Search & reports ─────────────────────────────────────────────────
		search: (query: string, object?: string, signal?: AbortSignal) => {
			const params = new URLSearchParams({ q: query });
			if (object) {
				params.set("object", object);
			}
			return send(target, `/search?${params.toString()}`, searchReplySchema, {
				signal,
			});
		},

		getSummary: (signal?: AbortSignal) =>
			send(target, "/summary", crmSummarySchema, { signal }),

		getPipeline: (
			body?: {
				field_id?: string;
				include_closed?: boolean;
				object_id?: string;
				value_field_id?: string;
			},
			signal?: AbortSignal
		) =>
			send(target, "/reports/pipeline", pipelineReportSchema, {
				body: body ?? {},
				method: "POST",
				signal,
			}),
	};
}

export type CrmClient = ReturnType<typeof createCrmClient>;

export interface RelatedGroup {
	field_id: string;
	field_name: string;
	object_slug: string;
	records: CrmRecord[];
}

export interface DuplicateGroup {
	field_id: string;
	records: CrmRecord[];
}

export interface CrmSummary {
	open_tasks: number;
	overdue_tasks: number;
	recent_activity: Activity[];
	total_records: number;
}
