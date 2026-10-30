import { CANVAS_CELL } from "@/src/components/dashboard/DashboardCanvas.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type CanvasLayoutRect,
	createWidget,
	type GridLayoutRect,
	getCatalog,
	type Widget,
	type WidgetInput,
} from "@/src/lib/api/dashboard.ts";

/**
 * Quick-add presets so the grid is usable without the AI builder. Only the ones
 * whose source type the node's catalog lists are offered or seeded (see
 * `presetsFor`): the Core-metric presets reappear on a host that can read Core
 * endpoints, and stay hidden on the Dashboards sidecar, which cannot.
 */
export const PRESETS: Array<{ label: string } & WidgetInput> = [
	{
		label: "Connected clients",
		kind: "stat",
		title: "Connected clients",
		source: {
			type: "core_endpoint",
			endpoint: "connections",
			selector: "clients",
		},
		config: { label: "online now" },
		refresh_interval: "10s",
		layout: { x: 0, y: 0, w: 3, h: 3 },
	},
	{
		label: "Open quests",
		kind: "list",
		title: "Open quests",
		source: { type: "core_endpoint", endpoint: "quests", selector: "quests" },
		config: { label_key: "title" },
		refresh_interval: "30s",
		layout: { x: 0, y: 0, w: 4, h: 4 },
	},
	{
		label: "Monitors",
		kind: "table",
		title: "Monitors",
		source: {
			type: "core_endpoint",
			endpoint: "monitors",
			selector: "monitors",
		},
		config: {},
		refresh_interval: "30s",
		layout: { x: 0, y: 0, w: 6, h: 4 },
	},
	{
		label: "Note",
		kind: "text",
		title: "Note",
		source: { type: "static", data: null },
		config: { markdown: "Welcome to your Home dashboard. Edit me." },
		layout: { x: 0, y: 0, w: 4, h: 3 },
	},
];

/**
 * Non-overlapping grid placements for the auto-seeded starter (keyed by preset
 * label), so the widgets tile the 12-column grid neatly on first launch. The note
 * sits top-left so a starter of just the presets the host supports still starts at
 * the origin.
 */
export const STARTER_LAYOUTS = new Map<string, GridLayoutRect>([
	["Note", { x: 0, y: 0, w: 4, h: 4 }],
	["Connected clients", { x: 4, y: 0, w: 3, h: 3 }],
	["Open quests", { x: 7, y: 0, w: 5, h: 4 }],
	["Monitors", { x: 0, y: 4, w: 8, h: 4 }],
]);

/** The presets whose source type the node's catalog says it can resolve. */
export function presetsFor(sourceTypes: readonly string[]): typeof PRESETS {
	return PRESETS.filter((preset) =>
		sourceTypes.includes(preset.source?.type ?? "static")
	);
}

/**
 * The prompt the "Generate a dashboard for me" button auto-sends to the AI
 * builder (the local `ryu`/Gemma agent), which authors widgets via Core's
 * `dashboard_builder.*` tools.
 */
export const AI_STARTER_PROMPT =
	"Build me a useful starter Home dashboard. Start with a short welcome note, then add a few widgets that use only the source types this node supports — for example a public HTTPS JSON endpoint or a Composio action I have connected — and arrange them neatly on the 12-column grid. Keep it clean and not overwhelming.";

/**
 * Nodes for which we've already auto-seeded a starter Home this session. Guards
 * against a re-list (or a dev StrictMode double-mount) seeding the starter twice.
 */
export const bootstrappedNodes = new Set<string>();

/**
 * Seed the curated starter widgets onto a freshly created dashboard. Only presets
 * whose source type the catalog lists are seeded, so first launch never writes a
 * widget the node would reject or could only show as broken. Best-effort: a
 * missing catalog seeds just the static note, and a failed widget yields a
 * smaller starter rather than aborting the rest, so first launch always lands on
 * a populated (not blank) Home.
 */
export async function seedStarterWidgets(
	target: ApiTarget,
	dashboardId: string
): Promise<void> {
	let sourceTypes: string[] = ["static"];
	try {
		const catalog = await getCatalog(target);
		if (Array.isArray(catalog.source_types)) {
			sourceTypes = catalog.source_types;
		}
	} catch {
		// No catalog: seed only the host-independent static note.
	}
	for (const preset of presetsFor(sourceTypes)) {
		const { label, ...input } = preset;
		const layout = STARTER_LAYOUTS.get(label) ?? input.layout;
		try {
			await createWidget(target, dashboardId, { ...input, layout });
		} catch {
			// Best-effort: skip this widget and keep seeding the rest.
		}
	}
}

/** Compact, model-readable summary of a dashboard's widgets for the builder preamble. */
export function dashboardSnapshot(widgets: Widget[]): string {
	if (widgets.length === 0) {
		return "(empty — no widgets yet)";
	}
	return widgets
		.map(
			(w) =>
				`  - ${w.id} (${w.kind}) "${w.title}" source=${w.source.type} at ${w.layout.x},${w.layout.y} ${w.layout.w}x${w.layout.h}`
		)
		.join("\n");
}

/** The next free row beneath all current widgets (so a quick-add stacks). */
export function nextRow(widgets: Widget[]): number {
	return widgets.reduce((max, w) => Math.max(max, w.layout.y + w.layout.h), 0);
}

/** Place a new Canvas widget near the viewport center without covering a card. */
export function findCanvasRect(
	widgets: Widget[],
	center: { x: number; y: number },
	w: number,
	h: number
): CanvasLayoutRect {
	const gap = 24;
	const stepX = w + gap;
	const stepY = h + gap;
	const existing = widgets.map(
		(widget) =>
			widget.canvas ?? {
				h: widget.layout.h * CANVAS_CELL,
				w: widget.layout.w * CANVAS_CELL,
				x: widget.layout.x * CANVAS_CELL,
				y: widget.layout.y * CANVAS_CELL,
			}
	);
	const origin = { x: center.x - w / 2, y: center.y - h / 2 };
	const overlaps = (x: number, y: number) =>
		existing.some(
			(rect) =>
				x < rect.x + rect.w + gap &&
				x + w + gap > rect.x &&
				y < rect.y + rect.h + gap &&
				y + h + gap > rect.y
		);

	if (!overlaps(origin.x, origin.y)) {
		return { ...origin, w, h };
	}

	// Search outward in a deterministic diamond spiral. The canvas is infinite,
	// so moving one widget-width/height per step always gives existing cards room.
	for (let radius = 1; radius <= widgets.length + 2; radius += 1) {
		for (let dx = radius; dx >= -radius; dx -= 1) {
			const vertical = radius - Math.abs(dx);
			const offsets = vertical === 0 ? [0] : [vertical, -vertical];
			for (const dy of offsets) {
				const x = origin.x + dx * stepX;
				const y = origin.y + dy * stepY;
				if (!overlaps(x, y)) {
					return { h, w, x, y };
				}
			}
		}
	}

	const lowestEdge = existing.reduce(
		(max, rect) => Math.max(max, rect.y + rect.h),
		origin.y
	);
	return { h, w, x: origin.x, y: lowestEdge + gap };
}
