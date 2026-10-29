import { z } from "zod";
import {
	canvasLayoutSchema,
	gridLayoutSchema,
	widgetKindSchema,
	widgetSourceSchema,
} from "@/src/components/dashboard/widgets/schema.ts";
import { gatewayJsonValueSchema } from "./gateway-json-contracts.ts";
// apps/desktop/src/lib/api/dashboard.ts
//
// Typed client for the Core Home-dashboards API (`/api/dashboards/*`): the
// customizable live widget grid. Field names are snake_case to match Core's serde
// shapes exactly. The event SSE stream uses fetch + ReadableStream (not
// EventSource) so the bearer token can be attached, mirroring the quests stream.

import type {
	CanvasLayoutRect,
	GridLayoutRect,
	WidgetInput,
	WidgetKind,
	WidgetSource,
} from "@/src/components/dashboard/widgets/schema.ts";
import { type ApiTarget, authenticatedFetch, request } from "./client.ts";

// The widget contract (kinds, sources, layout, mutable input) is defined once as
// Zod schemas in the widgets catalog; the wire types are inferred from there so
// this client can't drift from what it validates and renders. Re-exported here so
// existing `from "…/dashboard.ts"` imports keep resolving.
export type {
	CanvasLayoutRect,
	GridLayoutRect,
	WidgetInput,
	WidgetKind,
	WidgetSource,
} from "@/src/components/dashboard/widgets/schema.ts";

/** A dashboard's desktop render mode: v1 grid (default) or v2 infinite canvas. */
export type DashboardViewMode = "grid" | "canvas";

export interface Widget {
	/** v2 canvas position/size; absent until the widget is placed on the canvas. */
	canvas?: CanvasLayoutRect | null;
	config: unknown;
	dashboard_id: string;
	id: string;
	kind: WidgetKind;
	last_error?: string | null;
	last_refresh_at?: string | null;
	last_value?: unknown;
	layout: GridLayoutRect;
	refresh_interval?: string | null;
	source: WidgetSource;
	title: string;
}

export interface Dashboard {
	created_at: string;
	id: string;
	name: string;
	updated_at: string;
	/** Render mode; omitted by pre-v2 rows and treated as `"grid"`. */
	view_mode?: DashboardViewMode | null;
}

export interface DashboardCatalog {
	core_endpoints: string[];
	source_types: string[];
	widget_kinds: WidgetKind[];
}

// Internally-tagged union mirroring Core's `DashboardEvent`.
export type DashboardEvent =
	| {
			type: "widget_data";
			dashboard_id: string;
			widget_id: string;
			value: unknown;
			at: string;
	  }
	| {
			type: "widget_error";
			dashboard_id: string;
			widget_id: string;
			error: string;
			at: string;
	  }
	| { type: "widget_updated"; dashboard_id: string; widget: Widget }
	| { type: "widget_deleted"; dashboard_id: string; widget_id: string }
	| { type: "dashboard_updated"; dashboard_id: string };

const widgetSchema = z.object({
	canvas: canvasLayoutSchema.nullish(),
	config: z.json(),
	dashboard_id: z.string(),
	id: z.string(),
	kind: widgetKindSchema,
	last_error: z.string().nullish(),
	last_refresh_at: z.string().nullish(),
	last_value: z.json().optional(),
	layout: gridLayoutSchema,
	refresh_interval: z.string().nullish(),
	source: widgetSourceSchema,
	title: z.string(),
});
const dashboardEventSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("widget_data"),
		dashboard_id: z.string(),
		widget_id: z.string(),
		value: z.json(),
		at: z.string(),
	}),
	z.object({
		type: z.literal("widget_error"),
		dashboard_id: z.string(),
		widget_id: z.string(),
		error: z.string(),
		at: z.string(),
	}),
	z.object({
		type: z.literal("widget_updated"),
		dashboard_id: z.string(),
		widget: widgetSchema,
	}),
	z.object({
		type: z.literal("widget_deleted"),
		dashboard_id: z.string(),
		widget_id: z.string(),
	}),
	z.object({ type: z.literal("dashboard_updated"), dashboard_id: z.string() }),
]) satisfies z.ZodType<DashboardEvent>;

// ── Dashboards ────────────────────────────────────────────────────────────────

const dashboardResponseCodec: z.ZodType<Dashboard> = z
	.object({
		created_at: z.string(),
		id: z.string(),
		name: z.string(),
		updated_at: z.string(),
		view_mode: z
			.union([z.union([z.literal("grid"), z.literal("canvas")]), z.null()])
			.optional(),
	})
	.passthrough();
const widgetResponseCodec: z.ZodType<Widget> = widgetSchema.passthrough();
const dashboardCatalogResponseCodec: z.ZodType<DashboardCatalog> = z
	.object({
		core_endpoints: z.array(z.string()),
		source_types: z.array(z.string()),
		widget_kinds: z.array(widgetKindSchema),
	})
	.passthrough();
export async function listDashboards(target: ApiTarget): Promise<Dashboard[]> {
	const json = await request<{ dashboards?: Dashboard[] }>(
		target,
		"/api/dashboards",
		{},
		z
			.object({ dashboards: z.array(dashboardResponseCodec).optional() })
			.passthrough()
	);
	return json.dashboards ?? [];
}

export async function createDashboard(
	target: ApiTarget,
	name: string
): Promise<Dashboard> {
	const json = await request<{ dashboard?: Dashboard; error?: string }>(
		target,
		"/api/dashboards",
		{ method: "POST", body: { name } },
		z
			.object({
				dashboard: dashboardResponseCodec.optional(),
				error: z.string().optional(),
			})
			.passthrough()
	);
	if (!json.dashboard) {
		throw new Error(json.error ?? "failed to create dashboard");
	}
	return json.dashboard;
}

export async function getDashboard(
	target: ApiTarget,
	id: string
): Promise<{ dashboard: Dashboard; widgets: Widget[] }> {
	const json = await request<{
		dashboard?: Dashboard;
		widgets?: Widget[];
		error?: string;
	}>(
		target,
		`/api/dashboards/${id}`,
		{},
		z
			.object({
				dashboard: dashboardResponseCodec.optional(),
				widgets: z.array(widgetResponseCodec).optional(),
				error: z.string().optional(),
			})
			.passthrough()
	);
	if (!json.dashboard) {
		throw new Error(json.error ?? "dashboard not found");
	}
	return { dashboard: json.dashboard, widgets: json.widgets ?? [] };
}

export async function renameDashboard(
	target: ApiTarget,
	id: string,
	name: string
): Promise<Dashboard> {
	const json = await request<{ dashboard?: Dashboard; error?: string }>(
		target,
		`/api/dashboards/${id}`,
		{ method: "PUT", body: { name } },
		z
			.object({
				dashboard: dashboardResponseCodec.optional(),
				error: z.string().optional(),
			})
			.passthrough()
	);
	if (!json.dashboard) {
		throw new Error(json.error ?? "failed to rename dashboard");
	}
	return json.dashboard;
}

export async function deleteDashboard(
	target: ApiTarget,
	id: string
): Promise<void> {
	await request(
		target,
		`/api/dashboards/${id}`,
		{ method: "DELETE" },
		gatewayJsonValueSchema.transform(() => undefined)
	);
}

/**
 * Switch a dashboard's desktop render mode (grid ↔ canvas). Additive PUT — sends
 * only `view_mode`, so it never touches the dashboard name.
 */
export async function setDashboardViewMode(
	target: ApiTarget,
	id: string,
	viewMode: DashboardViewMode
): Promise<Dashboard> {
	const json = await request<{ dashboard?: Dashboard; error?: string }>(
		target,
		`/api/dashboards/${id}`,
		{ method: "PUT", body: { view_mode: viewMode } },
		z
			.object({
				dashboard: dashboardResponseCodec.optional(),
				error: z.string().optional(),
			})
			.passthrough()
	);
	if (!json.dashboard) {
		throw new Error(json.error ?? "failed to set view mode");
	}
	return json.dashboard;
}

// ── Widgets ───────────────────────────────────────────────────────────────────

export async function createWidget(
	target: ApiTarget,
	dashboardId: string,
	data: WidgetInput
): Promise<Widget> {
	const json = await request<{ widget?: Widget; error?: string }>(
		target,
		`/api/dashboards/${dashboardId}/widgets`,
		{ method: "POST", body: data },
		z
			.object({
				widget: widgetResponseCodec.optional(),
				error: z.string().optional(),
			})
			.passthrough()
	);
	if (!json.widget) {
		throw new Error(json.error ?? "failed to create widget");
	}
	return json.widget;
}

export async function updateWidget(
	target: ApiTarget,
	dashboardId: string,
	widgetId: string,
	data: WidgetInput
): Promise<Widget> {
	const json = await request<{ widget?: Widget; error?: string }>(
		target,
		`/api/dashboards/${dashboardId}/widgets/${widgetId}`,
		{ method: "PUT", body: data },
		z
			.object({
				widget: widgetResponseCodec.optional(),
				error: z.string().optional(),
			})
			.passthrough()
	);
	if (!json.widget) {
		throw new Error(json.error ?? "failed to update widget");
	}
	return json.widget;
}

export async function deleteWidget(
	target: ApiTarget,
	dashboardId: string,
	widgetId: string
): Promise<void> {
	await request(
		target,
		`/api/dashboards/${dashboardId}/widgets/${widgetId}`,
		{
			method: "DELETE",
		},
		gatewayJsonValueSchema.transform(() => undefined)
	);
}

export async function updateWidgetLayout(
	target: ApiTarget,
	dashboardId: string,
	widgetId: string,
	layout: GridLayoutRect
): Promise<void> {
	await request(
		target,
		`/api/dashboards/${dashboardId}/widgets/${widgetId}/layout`,
		{ method: "PUT", body: layout },
		gatewayJsonValueSchema.transform(() => undefined)
	);
}

/**
 * Persist a widget's v2 canvas position/size. Additive PUT to the same layout
 * endpoint — sends only `{ canvas }`, so the grid layout (v1) is never disturbed.
 */
export async function updateWidgetCanvas(
	target: ApiTarget,
	dashboardId: string,
	widgetId: string,
	canvas: CanvasLayoutRect
): Promise<void> {
	await request(
		target,
		`/api/dashboards/${dashboardId}/widgets/${widgetId}/layout`,
		{ method: "PUT", body: { canvas } },
		gatewayJsonValueSchema.transform(() => undefined)
	);
}

export async function refreshWidget(
	target: ApiTarget,
	dashboardId: string,
	widgetId: string
): Promise<{ value?: unknown; error?: string }> {
	return await request<{ value?: unknown; error?: string }>(
		target,
		`/api/dashboards/${dashboardId}/widgets/${widgetId}/refresh`,
		{ method: "POST" },
		z
			.object({
				value: gatewayJsonValueSchema.optional(),
				error: z.string().optional(),
			})
			.passthrough()
	);
}

export async function getCatalog(target: ApiTarget): Promise<DashboardCatalog> {
	return await request<DashboardCatalog>(
		target,
		"/api/dashboards/catalog",
		{},
		dashboardCatalogResponseCodec
	);
}

/**
 * Subscribe to dashboard events and invoke `onEvent` for every event. Resolves
 * when the stream ends or `signal` aborts.
 *
 * Dashboards now runs out-of-process (`apps-store/dashboards`); its store change
 * stream is no longer folded into Core's unified `/api/events/all`, so this opens
 * the sidecar's own SSE feed at `/api/dashboards/events` (reached over the node
 * URL via the sidecar's `public_mount`). That endpoint holds a **viewer guard**
 * for the life of the connection, which is what tells the sidecar's refresh loop
 * a human is watching — so expensive widget sources only run while Home is open.
 * (We must NOT pass `?internal=1`; that path holds no guard and is reserved for
 * the hardware nudge loop.)
 */
export async function streamDashboardEvents(
	target: ApiTarget,
	onEvent: (event: DashboardEvent) => void,
	signal?: AbortSignal
): Promise<void> {
	const resp = await authenticatedFetch(target, "/api/dashboards/events", {
		method: "GET",
		headers: { Accept: "text/event-stream" },
		signal,
	});
	if (!(resp.ok && resp.body)) {
		throw new Error(`dashboard events stream failed: ${resp.status}`);
	}
	const reader = resp.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	// SSE frames are separated by a blank line; each `data:` line carries the
	// JSON of one `DashboardEvent`.
	try {
		while (!signal?.aborted) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			const frames = buffer.split("\n\n");
			buffer = frames.pop() ?? "";
			for (const frame of frames) {
				for (const line of frame.split("\n")) {
					if (signal?.aborted) {
						return;
					}
					const trimmed = line.trim();
					if (!trimmed.startsWith("data:")) {
						continue;
					}
					const payload = trimmed.slice("data:".length).trim();
					if (!payload) {
						continue;
					}
					try {
						onEvent(dashboardEventSchema.parse(JSON.parse(payload)));
					} catch {
						// Non-JSON keep-alive or partial frame — ignore; the feed self-heals.
					}
				}
			}
		}
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}
