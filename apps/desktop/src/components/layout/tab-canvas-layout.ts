import { z } from "zod";
import type { Split, Tab, TabGroup } from "@/src/contexts/TabsContext.tsx";

export interface CanvasRect {
	height: number;
	width: number;
	x: number;
	y: number;
}

export interface CanvasViewport {
	x: number;
	y: number;
	zoom: number;
}

export interface TabCanvasSnapshot {
	groups: Record<string, CanvasRect>;
	tabs: Record<string, CanvasRect>;
	version: 1;
	viewport: CanvasViewport;
}

export const TAB_CANVAS_MIN_WIDTH = 360;
export const TAB_CANVAS_MIN_HEIGHT = 240;
export const TAB_CANVAS_MAX_WIDTH = 1200;
export const TAB_CANVAS_MAX_HEIGHT = 1200;
export const TAB_CANVAS_DEFAULT_WIDTH = 420;
export const TAB_CANVAS_DEFAULT_HEIGHT = 280;

const TAB_GAP = 56;
const CANVAS_PADDING = 24;
const REGION_HEADER_HEIGHT = 40;
const REGION_START_Y = 460;
const REGION_COLUMNS = 2;

interface CanvasRegion {
	id: string;
	tabIds: string[];
}

// Saved geometry is untrusted. Validate each member independently so one bad
// rectangle never discards valid positions or resets another region.
const savedNumber = z.number().optional().catch(undefined);
const savedRectSchema = z
	.object({
		height: savedNumber,
		width: savedNumber,
		x: savedNumber,
		y: savedNumber,
	})
	.catch({});
const savedViewportSchema = z
	.object({
		x: savedNumber,
		y: savedNumber,
		zoom: savedNumber,
	})
	.catch({});
const savedRectanglesSchema = z.record(z.string(), savedRectSchema).catch({});
const savedCanvasSchema = z
	.object({
		groups: savedRectanglesSchema,
		tabs: savedRectanglesSchema,
		viewport: savedViewportSchema,
	})
	.catch({ groups: {}, tabs: {}, viewport: {} });

type SavedRect = z.output<typeof savedRectSchema>;
type SavedViewport = z.output<typeof savedViewportSchema>;
/** Input accepted by the actual persistence-boundary parser. */
type SavedCanvasInput = Parameters<typeof savedCanvasSchema.parse>[0];

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function tabRectAt(index: number): CanvasRect {
	const column = index % REGION_COLUMNS;
	const row = Math.floor(index / REGION_COLUMNS);
	return {
		height: TAB_CANVAS_DEFAULT_HEIGHT,
		width: TAB_CANVAS_DEFAULT_WIDTH,
		x: CANVAS_PADDING + column * (TAB_CANVAS_DEFAULT_WIDTH + TAB_GAP),
		y:
			CANVAS_PADDING +
			REGION_HEADER_HEIGHT +
			row * (TAB_CANVAS_DEFAULT_HEIGHT + TAB_GAP),
	};
}

function regionRectAt(index: number, memberCount: number): CanvasRect {
	const columns = Math.min(REGION_COLUMNS, Math.max(1, memberCount));
	const rows = Math.ceil(memberCount / columns);
	const width =
		CANVAS_PADDING * 2 +
		columns * TAB_CANVAS_DEFAULT_WIDTH +
		(columns - 1) * TAB_GAP;
	const height =
		REGION_HEADER_HEIGHT +
		CANVAS_PADDING * 2 +
		rows * TAB_CANVAS_DEFAULT_HEIGHT +
		(rows - 1) * TAB_GAP;
	const column = index % REGION_COLUMNS;
	const row = Math.floor(index / REGION_COLUMNS);
	return {
		height,
		width,
		x: column * (TAB_CANVAS_MAX_WIDTH - 176),
		y: REGION_START_Y + row * (TAB_CANVAS_MAX_HEIGHT - 584),
	};
}

function rectFromSaved(
	value: SavedRect | undefined,
	fallback: CanvasRect,
	maxWidth = TAB_CANVAS_MAX_WIDTH,
	maxHeight = TAB_CANVAS_MAX_HEIGHT
): CanvasRect {
	if (!value) {
		return fallback;
	}
	return {
		height:
			value.height === undefined
				? fallback.height
				: clamp(value.height, TAB_CANVAS_MIN_HEIGHT, maxHeight),
		width:
			value.width === undefined
				? fallback.width
				: clamp(value.width, TAB_CANVAS_MIN_WIDTH, maxWidth),
		x: value.x ?? fallback.x,
		y: value.y ?? fallback.y,
	};
}

function viewportFromSaved(value: SavedViewport): CanvasViewport {
	const zoom = value.zoom;
	return {
		x: value.x ?? 0,
		y: value.y ?? 0,
		zoom: zoom !== undefined && zoom >= 0.2 && zoom <= 2 ? zoom : 1,
	};
}

function regionMemberships(
	tabs: Tab[],
	groups: TabGroup[],
	splits: Split[]
): CanvasRegion[] {
	const regions: CanvasRegion[] = [];
	for (const group of groups) {
		const tabIds = tabs
			.filter((tab) => tab.groupId === group.id)
			.map((tab) => tab.id);
		if (tabIds.length > 0) {
			regions.push({ id: `group:${group.id}`, tabIds });
		}
	}
	for (const split of splits) {
		const tabIds = tabs
			.filter((tab) => tab.splitId === split.id)
			.map((tab) => tab.id);
		if (tabIds.length > 0) {
			regions.push({ id: `split:${split.id}`, tabIds });
		}
	}
	return regions;
}

export function defaultTabCanvasSnapshot(): TabCanvasSnapshot {
	return {
		groups: {},
		tabs: {},
		version: 1,
		viewport: { x: 0, y: 0, zoom: 1 },
	};
}

export function createInitialTabCanvasSnapshot(
	tabs: Tab[],
	groups: TabGroup[],
	splits: Split[]
): TabCanvasSnapshot {
	const snapshot = defaultTabCanvasSnapshot();
	const regions = regionMemberships(tabs, groups, splits);
	const regionTabs = new Set(regions.flatMap((region) => region.tabIds));

	for (const [index, tab] of tabs
		.filter((candidate) => !regionTabs.has(candidate.id))
		.entries()) {
		snapshot.tabs[tab.id] = tabRectAt(index);
	}

	for (const [index, region] of regions.entries()) {
		const regionRect = regionRectAt(index, region.tabIds.length);
		snapshot.groups[region.id] = regionRect;
		for (const [memberIndex, tabId] of region.tabIds.entries()) {
			const tabRect = tabRectAt(memberIndex);
			snapshot.tabs[tabId] = {
				...tabRect,
				x: regionRect.x + tabRect.x,
				y: regionRect.y + tabRect.y,
			};
		}
	}

	return snapshot;
}

export function reconcileTabCanvasSnapshot(
	snapshot: SavedCanvasInput,
	tabIds: string[],
	regionIds: string[]
): TabCanvasSnapshot {
	const base = defaultTabCanvasSnapshot();
	const source = savedCanvasSchema.parse(snapshot);
	const sourceTabs = source.tabs;
	const sourceGroups = source.groups;

	for (const [index, tabId] of tabIds.entries()) {
		base.tabs[tabId] = rectFromSaved(sourceTabs[tabId], tabRectAt(index));
	}
	for (const [index, regionId] of regionIds.entries()) {
		base.groups[regionId] = rectFromSaved(
			sourceGroups[regionId],
			regionRectAt(index, 1)
		);
	}
	base.viewport = viewportFromSaved(source.viewport);
	return base;
}
