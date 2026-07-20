// Voice-mode canvas widgets: pull renderable UI-component specs out of the
// assistant's streamed text and turn them into the same `Widget` shape the
// dashboard grid renders. The assistant emits a fenced block —
//
//   ```ryu-widget
//   { "kind": "stat", "title": "Temp", "config": { "label": "Now" },
//     "data": { "value": 24 } }
//   ```
//
// — and the voice panel renders it on the blank canvas beside the transcript.
// Reuses the dashboard widget catalog (one JSON contract, one renderer set); the
// only voice-specific piece is treating the inline `data` as a `static` source so
// nothing has to be fetched. Malformed blocks are skipped, never thrown.

import { widgetDefinition } from "@/src/components/dashboard/widgets/registry.tsx";
import {
	type WidgetKind,
	widgetInputSchema,
} from "@/src/components/dashboard/widgets/schema.ts";
import type { Widget } from "@/src/lib/api/dashboard.ts";

/** One renderable widget parsed from assistant text. */
export interface VoiceWidget {
	/** Stable id (block index) so the canvas list has React keys. */
	id: string;
	/** Resolved static value handed to the widget body. */
	value: unknown;
	/** Dashboard-shaped widget the catalog renderer consumes. */
	widget: Widget;
}

// Fenced ```ryu-widget … ``` blocks. `s` so `.` spans newlines; global to sweep
// every block in the accumulated caption. Top-level regex (never built in a loop).
const WIDGET_BLOCK = /```ryu-widget\s+([\s\S]*?)```/g;
const PLACEHOLDER_LAYOUT = { x: 0, y: 0, w: 4, h: 4 } as const;

/**
 * Extract every well-formed `ryu-widget` block from `text`. Each block's `data`
 * field becomes a `static` source so the catalog renderer treats it as resolved.
 * Unknown kinds and unparseable JSON are dropped silently.
 */
export function extractVoiceWidgets(text: string): VoiceWidget[] {
	if (!text.includes("```ryu-widget")) {
		return [];
	}
	const out: VoiceWidget[] = [];
	WIDGET_BLOCK.lastIndex = 0;
	let match = WIDGET_BLOCK.exec(text);
	let index = 0;
	while (match !== null) {
		const widget = parseBlock(match[1] ?? "", index);
		if (widget) {
			out.push(widget);
		}
		index++;
		match = WIDGET_BLOCK.exec(text);
	}
	return out;
}

/** True when `kind` is a widget the catalog knows how to render. */
function isRenderableKind(kind: WidgetKind | undefined): kind is WidgetKind {
	return kind !== undefined && widgetDefinition(kind) !== undefined;
}

function parseBlock(raw: string, index: number): VoiceWidget | null {
	let json: unknown;
	try {
		json = JSON.parse(raw.trim());
	} catch {
		return null;
	}
	const parsed = widgetInputSchema.safeParse(json);
	if (!(parsed.success && isRenderableKind(parsed.data.kind))) {
		return null;
	}
	// The inline data rides on `data` (not part of the input schema); read it off
	// the raw object so the static widget has a value to render.
	const data = (json as { data?: unknown }).data;
	const widget: Widget = {
		id: `voice-widget-${index}`,
		dashboard_id: "voice",
		kind: parsed.data.kind,
		title: parsed.data.title ?? "",
		config: parsed.data.config,
		source: { type: "static", data },
		layout: parsed.data.layout ?? PLACEHOLDER_LAYOUT,
	};
	return { id: widget.id, widget, value: data };
}
