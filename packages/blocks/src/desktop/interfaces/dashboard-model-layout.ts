// ---------------------------------------------------------------------------
// Widget catalog and layout
// ---------------------------------------------------------------------------

/** Where the viewer's own arrangement lives (per viewer, per device). */
export const DASHBOARD_LAYOUT_KEY = "ryu:dashboard-layout";
const LAYOUT_VERSION = 1;

/** Width on the 12-column grid: a quarter, a half, three quarters, or all of it. */
export type WidgetSize = "full" | "l" | "m" | "s";

export const WIDGET_SIZE_ORDER: readonly WidgetSize[] = ["s", "m", "l", "full"];

export const WIDGET_SIZE_SHORT: Record<WidgetSize, string> = {
	full: "Full",
	l: "L",
	m: "M",
	s: "S",
};

export const WIDGET_SIZE_NAMES: Record<WidgetSize, string> = {
	full: "full width",
	l: "large",
	m: "medium",
	s: "small",
};

/** Number tiles are one row tall; lists and charts are panels. */
export type WidgetKind = "panel" | "stat";

export type WidgetId =
	| "activity"
	| "agents"
	| "attention"
	| "pinned"
	| "recent"
	| "stat-agents"
	| "stat-attention"
	| "stat-scheduled"
	| "stat-updated"
	| "stat-working"
	| "stat-your-turn"
	| "upcoming"
	| "working"
	| "your-turn";

export interface WidgetSpec {
	/** One plain line for the Add widget menu. */
	description: string;
	id: WidgetId;
	kind: WidgetKind;
	/** The size a widget takes when it is added. */
	size: WidgetSize;
	/** Sizes the resize control cycles through, smallest first. */
	sizes: readonly WidgetSize[];
	title: string;
}

const PANEL_SIZES: readonly WidgetSize[] = WIDGET_SIZE_ORDER;
/** A single number never needs more than half the row. */
const STAT_SIZES: readonly WidgetSize[] = ["s", "m"];

export const WIDGETS: readonly WidgetSpec[] = [
	{
		description: "Threads where an agent replied and is waiting on you",
		id: "your-turn",
		kind: "panel",
		size: "m",
		sizes: PANEL_SIZES,
		title: "Your turn",
	},
	{
		description: "Failed or interrupted threads and failed scheduled runs",
		id: "attention",
		kind: "panel",
		size: "s",
		sizes: PANEL_SIZES,
		title: "Needs attention",
	},
	{
		description: "Threads with a run in progress",
		id: "working",
		kind: "panel",
		size: "s",
		sizes: PANEL_SIZES,
		title: "Working now",
	},
	{
		description: "Every agent, what it is doing, and its latest thread",
		id: "agents",
		kind: "panel",
		size: "s",
		sizes: PANEL_SIZES,
		title: "Agents",
	},
	{
		description: "Threads updated per hour over the last 24 hours",
		id: "activity",
		kind: "panel",
		size: "l",
		sizes: PANEL_SIZES,
		title: "Activity",
	},
	{
		description: "Scheduled routines that run next",
		id: "upcoming",
		kind: "panel",
		size: "s",
		sizes: PANEL_SIZES,
		title: "Upcoming runs",
	},
	{
		description: "Threads you pinned",
		id: "pinned",
		kind: "panel",
		size: "s",
		sizes: PANEL_SIZES,
		title: "Pinned",
	},
	{
		description: "Every thread, most recently updated first",
		id: "recent",
		kind: "panel",
		size: "m",
		sizes: PANEL_SIZES,
		title: "Recent",
	},
	{
		description: "Count of replies waiting on you",
		id: "stat-your-turn",
		kind: "stat",
		size: "s",
		sizes: STAT_SIZES,
		title: "Your turn",
	},
	{
		description: "Count of failed threads and scheduled runs",
		id: "stat-attention",
		kind: "stat",
		size: "s",
		sizes: STAT_SIZES,
		title: "Needs attention",
	},
	{
		description: "Count of runs in progress",
		id: "stat-working",
		kind: "stat",
		size: "s",
		sizes: STAT_SIZES,
		title: "Running now",
	},
	{
		description: "Threads with activity in the last 24 hours",
		id: "stat-updated",
		kind: "stat",
		size: "s",
		sizes: STAT_SIZES,
		title: "Updated in 24h",
	},
	{
		description: "Agents with a run in progress",
		id: "stat-agents",
		kind: "stat",
		size: "s",
		sizes: STAT_SIZES,
		title: "Agents working",
	},
	{
		description: "Scheduled runs due in the next 24 hours",
		id: "stat-scheduled",
		kind: "stat",
		size: "s",
		sizes: STAT_SIZES,
		title: "Runs due in 24h",
	},
];

const SPEC_BY_ID = new Map<string, WidgetSpec>(
	WIDGETS.map((spec) => [spec.id, spec])
);

export function widgetSpec(id: WidgetId): WidgetSpec {
	const spec = SPEC_BY_ID.get(id);
	if (!spec) {
		throw new Error(`Unknown dashboard widget: ${id}`);
	}
	return spec;
}

export function isWidgetId(value: unknown): value is WidgetId {
	return typeof value === "string" && SPEC_BY_ID.has(value);
}

export interface LayoutItem {
	id: WidgetId;
	size: WidgetSize;
}

export type DashboardLayout = readonly LayoutItem[];

/** Four number tiles, then the panels in rows that fill the grid exactly. */
export const DEFAULT_LAYOUT: DashboardLayout = [
	{ id: "stat-your-turn", size: "s" },
	{ id: "stat-attention", size: "s" },
	{ id: "stat-working", size: "s" },
	{ id: "stat-updated", size: "s" },
	{ id: "activity", size: "l" },
	{ id: "agents", size: "s" },
	{ id: "your-turn", size: "m" },
	{ id: "attention", size: "s" },
	{ id: "working", size: "s" },
	{ id: "recent", size: "m" },
	{ id: "upcoming", size: "s" },
	{ id: "pinned", size: "s" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readItem(raw: unknown): LayoutItem | null {
	const id = isRecord(raw) ? raw.id : raw;
	if (!isWidgetId(id)) {
		return null;
	}
	const spec = widgetSpec(id);
	const size = isRecord(raw) ? raw.size : undefined;
	const valid = spec.sizes.find((option) => option === size);
	return { id, size: valid ?? spec.size };
}

/**
 * Reads a stored layout. Unknown widget ids are dropped (a newer build may
 * have written them), duplicates keep their first position, and a size the
 * widget does not support falls back to its default. Returns null when
 * nothing usable is stored, so the caller shows the default arrangement.
 */
export function parseLayout(raw: string | null): LayoutItem[] | null {
	if (!raw) {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	const list = isRecord(parsed) ? parsed.widgets : parsed;
	if (!Array.isArray(list)) {
		return null;
	}
	const seen = new Set<WidgetId>();
	const layout: LayoutItem[] = [];
	for (const entry of list) {
		const item = readItem(entry);
		if (item && !seen.has(item.id)) {
			seen.add(item.id);
			layout.push(item);
		}
	}
	return layout;
}

export function serializeLayout(layout: DashboardLayout): string {
	return JSON.stringify({
		version: LAYOUT_VERSION,
		widgets: layout.map(({ id, size }) => ({ id, size })),
	});
}

/** Moves a widget to `toIndex` (clamped), keeping everything else in order. */
export function moveWidget(
	layout: DashboardLayout,
	id: WidgetId,
	toIndex: number
): LayoutItem[] {
	const from = layout.findIndex((item) => item.id === id);
	const moving = layout[from];
	if (!moving) {
		return [...layout];
	}
	const rest = layout.filter((item) => item.id !== id);
	const target = Math.max(0, Math.min(rest.length, toIndex));
	return [...rest.slice(0, target), moving, ...rest.slice(target)];
}

/** The next size this widget supports, wrapping back to its smallest. */
export function nextWidgetSize(id: WidgetId, size: WidgetSize): WidgetSize {
	const { sizes } = widgetSpec(id);
	const index = sizes.indexOf(size);
	return sizes[(index + 1) % sizes.length] ?? sizes[0] ?? "s";
}

export function cycleWidgetSize(
	layout: DashboardLayout,
	id: WidgetId
): LayoutItem[] {
	return layout.map((item) =>
		item.id === id ? { id, size: nextWidgetSize(id, item.size) } : item
	);
}

export function removeWidget(
	layout: DashboardLayout,
	id: WidgetId
): LayoutItem[] {
	return layout.filter((item) => item.id !== id);
}

/** Adds a widget at its default size; number tiles join the other tiles. */
export function addWidget(layout: DashboardLayout, id: WidgetId): LayoutItem[] {
	if (layout.some((item) => item.id === id)) {
		return [...layout];
	}
	const spec = widgetSpec(id);
	const item: LayoutItem = { id, size: spec.size };
	if (spec.kind === "stat") {
		let lastStat = -1;
		for (const [index, entry] of layout.entries()) {
			if (widgetSpec(entry.id).kind === "stat") {
				lastStat = index;
			}
		}
		if (lastStat >= 0) {
			return [
				...layout.slice(0, lastStat + 1),
				item,
				...layout.slice(lastStat + 1),
			];
		}
		return [item, ...layout];
	}
	return [...layout, item];
}

/** Catalog entries that are not on the dashboard, in catalog order. */
export function availableWidgets(layout: DashboardLayout): WidgetSpec[] {
	const present = new Set(layout.map((item) => item.id));
	return WIDGETS.filter((spec) => !present.has(spec.id));
}

export function sameLayout(a: DashboardLayout, b: DashboardLayout): boolean {
	return (
		a.length === b.length &&
		a.every(
			(item, index) => item.id === b[index]?.id && item.size === b[index]?.size
		)
	);
}
