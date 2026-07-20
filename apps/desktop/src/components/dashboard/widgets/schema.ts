// The dashboard widget contract, expressed as Zod schemas — the single source of
// truth for the client. Widget *kinds*, *sources*, *layout*, and per-kind display
// *config* all live here; the wire types the API client uses are inferred from
// these schemas (see lib/api/dashboard.ts) so the client can't drift from what it
// actually validates and renders. Field shapes mirror Core's serde types.
//
// Two things stay deliberately loose. A widget's resolved `value` (the live JSON a
// source returns) is NOT modelled here — it is genuinely arbitrary and handled by
// the defensive coercion in ./data.ts. And every config field is tolerant: a bad
// field falls back to `undefined` (via `.catch`) rather than failing the whole
// object, so a malformed config never blanks a widget.

import { z } from "zod";

// ── Kind ────────────────────────────────────────────────────────────────────

export const widgetKindSchema = z.enum([
	"stat",
	"line_chart",
	"bar_chart",
	"area_chart",
	"pie_chart",
	"table",
	"list",
	"text",
	"map",
	"agent_feed",
]);
export type WidgetKind = z.infer<typeof widgetKindSchema>;

// ── Source (internally-tagged union mirroring Core's `WidgetSource`) ──────────

export const widgetSourceSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("static"), data: z.unknown().optional() }),
	z.object({
		type: z.literal("core_endpoint"),
		endpoint: z.string(),
		selector: z.string().nullish(),
	}),
	z.object({ type: z.literal("monitor"), monitor_id: z.string() }),
	z.object({
		type: z.literal("workflow"),
		workflow_id: z.string(),
		input: z.record(z.string(), z.string()).optional(),
		output_key: z.string().nullish(),
	}),
	z.object({
		type: z.literal("composio"),
		action: z.string(),
		args: z.unknown().optional(),
	}),
	z.object({
		type: z.literal("http"),
		url: z.string(),
		selector: z.string().nullish(),
		headers: z.record(z.string(), z.string()).optional(),
	}),
	z.object({
		type: z.literal("agent"),
		agent_id: z.string(),
		prompt: z.string(),
	}),
]);
export type WidgetSource = z.infer<typeof widgetSourceSchema>;
export type WidgetSourceType = WidgetSource["type"];

// ── Layout ────────────────────────────────────────────────────────────────────

export const gridLayoutSchema = z.object({
	h: z.number(),
	w: z.number(),
	x: z.number(),
	y: z.number(),
});
export type GridLayoutRect = z.infer<typeof gridLayoutSchema>;

// The v2 infinite-canvas position/size (pixels in canvas space). Mirrors Core's
// `CanvasLayout`. Optional on a widget: when absent the canvas view derives an
// initial rect from the grid layout (see CANVAS_CELL in DashboardCanvas).
export const canvasLayoutSchema = z.object({
	h: z.number(),
	w: z.number(),
	x: z.number(),
	y: z.number(),
});
export type CanvasLayoutRect = z.infer<typeof canvasLayoutSchema>;

// ── Per-kind display config ───────────────────────────────────────────────────
//
// A tolerant optional string: present-but-wrong-typed becomes `undefined` instead
// of failing the parse, matching the old field-by-field defensive reads.
const softString = z.string().optional().catch(undefined);

export const statConfigSchema = z.object({
	delta_key: softString,
	label: softString,
	unit: softString,
	value_key: softString,
});
export type StatConfig = z.infer<typeof statConfigSchema>;

export const chartConfigSchema = z.object({
	data_key: softString,
	// pie
	name_key: softString,
	series: z.array(z.string()).optional().catch(undefined),
	value_key: softString,
	x_key: softString,
});
export type ChartWidgetConfig = z.infer<typeof chartConfigSchema>;

export const tableConfigSchema = z.object({
	columns: z.array(z.string()).optional().catch(undefined),
	rows_key: softString,
});
export type TableConfig = z.infer<typeof tableConfigSchema>;

export const listConfigSchema = z.object({
	items_key: softString,
	label_key: softString,
});
export type ListConfig = z.infer<typeof listConfigSchema>;

export const textConfigSchema = z.object({ markdown: softString });
export type TextConfig = z.infer<typeof textConfigSchema>;

export const mapConfigSchema = z.object({
	center: z.tuple([z.number(), z.number()]).optional().catch(undefined),
	markers_key: softString,
	zoom: z.number().optional().catch(undefined),
});
export type MapConfig = z.infer<typeof mapConfigSchema>;

export const emptyConfigSchema = z.object({});

/**
 * Parse a raw config blob against its schema, never throwing. Falls back to the
 * schema's empty shape so an unexpected config degrades gracefully to defaults
 * rather than blanking the widget.
 */
export function parseConfig<S extends z.ZodType>(
	schema: S,
	config: unknown
): z.infer<S> {
	const parsed = schema.safeParse(config ?? {});
	if (parsed.success) {
		return parsed.data;
	}
	return schema.parse({});
}

// ── Widget input (the mutable fields a create/update request carries) ──────────
//
// `config` stays `unknown` here because its shape depends on `kind`; it is
// validated per-kind through the registry's `configSchema` at render and create.

export const widgetInputSchema = z.object({
	canvas: canvasLayoutSchema.optional(),
	config: z.unknown().optional(),
	kind: widgetKindSchema.optional(),
	layout: gridLayoutSchema.optional(),
	refresh_interval: z.string().nullish(),
	source: widgetSourceSchema.optional(),
	title: z.string().optional(),
});
export type WidgetInput = z.infer<typeof widgetInputSchema>;
