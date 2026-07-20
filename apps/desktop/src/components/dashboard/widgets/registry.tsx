// The widget catalog: one entry per widget kind, binding its display label,
// default grid size, config schema, and renderer together. This is the single
// place a new widget kind is registered — WidgetCard (render), AddWidgetDialog
// (picker options + default sizes), and the AI builder preamble (allowed kinds)
// all read from here instead of repeating the list. Adding a kind means: add its
// schema in ./schema.ts, its body component, and one entry below.

import type { ReactNode } from "react";
import type { z } from "zod";
import type { Widget } from "@/src/lib/api/dashboard.ts";
import { AgentFeedBody } from "./AgentFeedWidget.tsx";
import { ChartBody } from "./ChartWidget.tsx";
import { ListBody } from "./ListWidget.tsx";
import { MapBody } from "./MapWidget.tsx";
import { StatBody } from "./StatWidget.tsx";
import {
	chartConfigSchema,
	emptyConfigSchema,
	listConfigSchema,
	mapConfigSchema,
	statConfigSchema,
	tableConfigSchema,
	textConfigSchema,
	type WidgetKind,
} from "./schema.ts";
import { TableBodyWidget } from "./TableWidget.tsx";
import { TextBody } from "./TextWidget.tsx";

/** Everything the app needs to know about a single widget kind. */
export interface WidgetDefinition {
	/** Schema for this kind's display `config` (see parseConfig). */
	configSchema: z.ZodType;
	/** Grid size a freshly-added widget of this kind gets. */
	defaultSize: { w: number; h: number };
	kind: WidgetKind;
	/** Human label for pickers. */
	label: string;
	/** Render this kind's body from a widget + its resolved live value. */
	render: (ctx: { widget: Widget; value: unknown }) => ReactNode;
}

// Ordered so pickers list kinds in a sensible progression (numbers → charts →
// collections → freeform). Insertion order here is the order the UI shows.
export const WIDGET_DEFINITIONS: readonly WidgetDefinition[] = [
	{
		kind: "stat",
		label: "Stat / KPI number",
		defaultSize: { w: 3, h: 3 },
		configSchema: statConfigSchema,
		render: ({ widget, value }) => (
			<StatBody config={widget.config} value={value} />
		),
	},
	{
		kind: "line_chart",
		label: "Line chart",
		defaultSize: { w: 6, h: 4 },
		configSchema: chartConfigSchema,
		render: ({ widget, value }) => (
			<ChartBody config={widget.config} kind="line_chart" value={value} />
		),
	},
	{
		kind: "bar_chart",
		label: "Bar chart",
		defaultSize: { w: 6, h: 4 },
		configSchema: chartConfigSchema,
		render: ({ widget, value }) => (
			<ChartBody config={widget.config} kind="bar_chart" value={value} />
		),
	},
	{
		kind: "area_chart",
		label: "Area chart",
		defaultSize: { w: 6, h: 4 },
		configSchema: chartConfigSchema,
		render: ({ widget, value }) => (
			<ChartBody config={widget.config} kind="area_chart" value={value} />
		),
	},
	{
		kind: "pie_chart",
		label: "Pie chart",
		defaultSize: { w: 4, h: 4 },
		configSchema: chartConfigSchema,
		render: ({ widget, value }) => (
			<ChartBody config={widget.config} kind="pie_chart" value={value} />
		),
	},
	{
		kind: "table",
		label: "Table",
		defaultSize: { w: 6, h: 4 },
		configSchema: tableConfigSchema,
		render: ({ widget, value }) => (
			<TableBodyWidget config={widget.config} value={value} />
		),
	},
	{
		kind: "list",
		label: "List",
		defaultSize: { w: 4, h: 4 },
		configSchema: listConfigSchema,
		render: ({ widget, value }) => (
			<ListBody config={widget.config} value={value} />
		),
	},
	{
		kind: "text",
		label: "Text / Markdown",
		defaultSize: { w: 4, h: 3 },
		configSchema: textConfigSchema,
		render: ({ widget, value }) => (
			<TextBody config={widget.config} value={value} />
		),
	},
	{
		kind: "map",
		label: "Map",
		defaultSize: { w: 6, h: 5 },
		configSchema: mapConfigSchema,
		render: ({ widget, value }) => (
			<MapBody config={widget.config} value={value} />
		),
	},
	{
		kind: "agent_feed",
		label: "Agent feed",
		defaultSize: { w: 4, h: 4 },
		configSchema: emptyConfigSchema,
		render: ({ widget, value }) => (
			<AgentFeedBody refreshedAt={widget.last_refresh_at} value={value} />
		),
	},
];

const REGISTRY: Record<WidgetKind, WidgetDefinition> = Object.fromEntries(
	WIDGET_DEFINITIONS.map((def) => [def.kind, def])
) as Record<WidgetKind, WidgetDefinition>;

/** Look up a kind's definition, or undefined for an unknown kind. */
export function widgetDefinition(
	kind: WidgetKind
): WidgetDefinition | undefined {
	return REGISTRY[kind];
}
