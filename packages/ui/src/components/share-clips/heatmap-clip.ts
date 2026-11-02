/**
 * The contributions-heatmap clip: a share scene that is NOT a card.
 *
 * The member's trailing year of daily usage fills in day by day, their headline
 * numbers count up beneath it, the frame holds, and the whole thing fades back
 * to the background so the loop's last frame runs into its first without a
 * seam. Exported as MP4/WebM by `recordCanvasLoop` and as a GIF by
 * `recordCanvasGif` (both in `../pass-studio/`), at the sizes in
 * `PASS_FORMATS`.
 *
 * The grid mirrors `ContributionsGraph` (`../contributions-graph.tsx`): 53
 * Sunday-first weeks ending on the week of the latest day, four intensity
 * buckets scaled against the busiest day. On a tall frame one 53-column strip
 * would leave the cells tiny, so the year is wrapped into stacked bands —
 * `heatmapGridLayout` picks whichever band count gives the largest cells.
 *
 * Everything here is a pure function of (data, time, size, palette): the
 * preview and both encoders call `drawHeatmapFrame` with a timestamp and get
 * the same frame, which is what keeps the file identical to what was previewed.
 * Only numbers the Stats tab already shows go on the clip.
 */

import type { LiteralMessage } from "@ryu/i18n/react";
import { formatNumber } from "../../lib/number-format.ts";
import type {
	HeatmapClipCell,
	HeatmapClipData,
	HeatmapClipDay,
	HeatmapClipLayout,
	HeatmapClipSize,
	HeatmapClipStat,
	HeatmapClipTimeline,
	HeatmapGridLayout,
} from "./heatmap-clip-types.ts";

export { drawHeatmapFrame } from "./heatmap-clip-draw.ts";
export { HEATMAP_CLIP_PALETTES } from "./heatmap-clip-palettes.ts";
export type {
	HeatmapClipCell,
	HeatmapClipData,
	HeatmapClipDay,
	HeatmapClipLayout,
	HeatmapClipPalette,
	HeatmapClipSize,
	HeatmapClipStat,
	HeatmapClipTimeline,
	HeatmapGridLayout,
} from "./heatmap-clip-types.ts";

/** The loop's period. Long enough to watch a year fill in, short enough to repost. */
export const HEATMAP_CLIP_SECONDS = 8;
/**
 * 30, not the passes' 60: nothing here is a slow continuous rotation (the case
 * 60 exists for), and half the frames halves the export time.
 */
export const HEATMAP_CLIP_FPS = 30;
export const HEATMAP_WEEKS = 53;
export const HEATMAP_LEVELS = 4;
/** The short edge every layout constant below is written against. */
const REFERENCE_EDGE_PX = 1080;
const DAYS_IN_WEEK = 7;
const SATURDAY = 6;
const MS_PER_DAY = 86_400_000;
const MAX_BANDS = 4;
/** A cell is this share of its pitch; the rest is the gutter. */
const CELL_FILL = 0.8;
/** Days that are still popping in behind the leading edge of the fill. */
const POP_TRAIL_DAYS = 10;

const FADE_IN_END = 0.6;
const FILL_START = 0.5;
const FILL_END = 5;
const STATS_START = 4.4;
const STATS_END = 5.6;
const FADE_OUT_START = 7.3;

const MARGIN_PX = 80;
export const STAT_ROW_PX = 130;
export const FOOTER_PX = 26;
const HEADER_BLOCK_PX = 260;
export const SECTION_GAP_PX = 56;

export const clamp01 = (value: number): number =>
	Math.min(1, Math.max(0, value));
const easeOutCubic = (value: number): number => 1 - (1 - clamp01(value)) ** 3;
const pad2 = (value: number): string => value.toString().padStart(2, "0");
const toKey = (date: Date): string =>
	`${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
const parseDay = (day: string): Date => new Date(`${day}T00:00:00Z`);
const addDays = (date: Date, days: number): Date =>
	new Date(date.getTime() + days * MS_PER_DAY);

/** The same bucket rule as `ContributionsGraph`. */
export function heatmapLevel(count: number, maxCount: number): number {
	if (count <= 0 || maxCount <= 0) {
		return 0;
	}
	const scaled = Math.ceil((count / maxCount) * HEATMAP_LEVELS);
	return Math.min(Math.max(scaled, 1), HEATMAP_LEVELS);
}

function latestDay(days: readonly HeatmapClipDay[]): string | null {
	let latest: string | null = null;
	for (const entry of days) {
		if (latest === null || entry.day > latest) {
			latest = entry.day;
		}
	}
	return latest;
}

/**
 * The 53×7 grid, week-major, each cell tagged with its chronological order so
 * the fill can reveal it day by day.
 */
export function buildHeatmapCells(
	days: readonly HeatmapClipDay[],
	endDay?: string | null
): HeatmapClipCell[] {
	const counts = new Map<string, number>();
	let maxCount = 0;
	for (const entry of days) {
		const next = (counts.get(entry.day) ?? 0) + Math.max(0, entry.count);
		counts.set(entry.day, next);
		maxCount = Math.max(maxCount, next);
	}
	const end = parseDay(endDay ?? latestDay(days) ?? toKey(new Date()));
	const lastCell = addDays(end, SATURDAY - end.getUTCDay());
	const firstCell = addDays(lastCell, -(HEATMAP_WEEKS * DAYS_IN_WEEK - 1));

	const cells: HeatmapClipCell[] = [];
	let order = 0;
	for (let week = 0; week < HEATMAP_WEEKS; week += 1) {
		for (let weekday = 0; weekday < DAYS_IN_WEEK; weekday += 1) {
			const date = addDays(firstCell, week * DAYS_IN_WEEK + weekday);
			const day = toKey(date);
			const filler = date.getTime() > end.getTime();
			const count = counts.get(day) ?? 0;
			cells.push({
				count,
				day,
				filler,
				level: filler ? 0 : heatmapLevel(count, maxCount),
				order: filler ? -1 : order,
				week,
				weekday,
			});
			if (!filler) {
				order += 1;
			}
		}
	}
	return cells;
}

/**
 * Fit the year into a box, wrapping it into 1..4 stacked bands of weeks and
 * keeping whichever gives the largest cells. Centred horizontally, top-aligned.
 */
export function heatmapGridLayout(box: {
	height: number;
	left: number;
	top: number;
	width: number;
}): HeatmapGridLayout {
	let best: HeatmapGridLayout | null = null;
	for (let bands = 1; bands <= MAX_BANDS; bands += 1) {
		const columns = Math.ceil(HEATMAP_WEEKS / bands);
		// One empty row of pitch between bands.
		const rows = bands * DAYS_IN_WEEK + (bands - 1);
		const pitch = Math.min(box.width / columns, box.height / rows);
		if (best === null || pitch > best.pitch) {
			const width = columns * pitch - (1 - CELL_FILL) * pitch;
			best = {
				bands,
				cell: pitch * CELL_FILL,
				columns,
				height: rows * pitch - (1 - CELL_FILL) * pitch,
				left: box.left + (box.width - width) / 2,
				pitch,
				top: box.top,
				width,
			};
		}
	}
	// SAFETY: the loop runs at least once (MAX_BANDS >= 1), so best is set.
	return best as HeatmapGridLayout;
}

/** Top-left corner of a cell in device px; mirrored inside the grid in RTL. */
export function heatmapCellPosition(
	grid: HeatmapGridLayout,
	week: number,
	weekday: number,
	/** Weeks run right to left, as the live graph's flex row does under RTL. */
	rtl = false
): { x: number; y: number } {
	const band = Math.floor(week / grid.columns);
	const column = week % grid.columns;
	const slot = rtl ? grid.columns - 1 - column : column;
	return {
		x: grid.left + slot * grid.pitch,
		y: grid.top + (band * (DAYS_IN_WEEK + 1) + weekday) * grid.pitch,
	};
}

/** Where everything sits in a frame of `size`. */
export function layoutHeatmapClip(size: HeatmapClipSize): HeatmapClipLayout {
	const unit = Math.min(size.width, size.height) / REFERENCE_EDGE_PX;
	const margin = MARGIN_PX * unit;
	const statsBlock = STAT_ROW_PX * 2 * unit;
	const footer = (FOOTER_PX + SECTION_GAP_PX) * unit;
	const gridTop = margin + HEADER_BLOCK_PX * unit;
	const gridBox = {
		height: Math.max(
			0,
			size.height -
				gridTop -
				margin -
				statsBlock -
				footer -
				SECTION_GAP_PX * unit
		),
		left: margin,
		top: gridTop,
		width: size.width - margin * 2,
	};
	const grid = heatmapGridLayout(gridBox);
	// The numbers sit just under the grid, not pinned to the floor: on a wide
	// frame the grid is short and a pinned block would float far below it.
	return {
		grid,
		margin,
		statsTop: grid.top + grid.height + SECTION_GAP_PX * unit,
		unit,
	};
}

/** The scene's phases at `time` seconds (wrapped into the loop). */
export function heatmapClipTimeline(time: number): HeatmapClipTimeline {
	const t =
		((time % HEATMAP_CLIP_SECONDS) + HEATMAP_CLIP_SECONDS) %
		HEATMAP_CLIP_SECONDS;
	const fadeIn = clamp01(t / FADE_IN_END);
	const fadeOut = clamp01(
		(HEATMAP_CLIP_SECONDS - t) / (HEATMAP_CLIP_SECONDS - FADE_OUT_START)
	);
	return {
		alpha: Math.min(fadeIn, fadeOut),
		fill: clamp01((t - FILL_START) / (FILL_END - FILL_START)),
		stats: easeOutCubic((t - STATS_START) / (STATS_END - STATS_START)),
	};
}

/** The fully drawn frame: the one a still or a reduced-motion preview shows. */
export const HEATMAP_CLIP_HOLD_TIME = (STATS_END + FADE_OUT_START) / 2;

/**
 * How far one day has popped in, 0..1, when `fill` of `total` days are revealed.
 * Linear in the fill so the year sweeps at a constant rate, with a short trail
 * so the leading edge reads as cells landing rather than a hard wipe.
 */
export function cellRevealProgress(
	order: number,
	total: number,
	fill: number
): number {
	if (order < 0 || total <= 0) {
		return 0;
	}
	if (fill >= 1) {
		return 1;
	}
	const head = fill * (total + POP_TRAIL_DAYS);
	return easeOutCubic((head - order) / POP_TRAIL_DAYS);
}

/** A whole number counting up to `value` as `progress` goes 0→1. */
export function countUp(value: number, progress: number): number {
	return Math.round(Math.max(0, value) * clamp01(progress));
}

/** The four headline stats, every one of them a figure the Stats tab shows. */
export function heatmapClipStats(
	data: HeatmapClipData,
	progress: number,
	tl: LiteralMessage
): HeatmapClipStat[] {
	const longest = data.streakLongest ?? 0;
	return [
		{
			label: tl("Total tokens"),
			value: formatNumber(countUp(data.totalTokens, progress)),
		},
		{
			label: tl("Active days"),
			value: formatNumber(countUp(data.activeDays ?? 0, progress)),
		},
		{
			label:
				longest > 0
					? tl("Day streak · best {longest}", { longest: String(longest) })
					: tl("Day streak"),
			value: formatNumber(countUp(data.streakCurrent, progress)),
		},
		{ label: tl("Level"), value: formatNumber(countUp(data.level, progress)) },
	];
}

/** The footer line: peak day and favourite model, when there are any. */
export function heatmapClipFooter(
	data: HeatmapClipData,
	tl: LiteralMessage
): string {
	const parts: string[] = [];
	if (data.peakDay && data.peakDay.tokens > 0) {
		parts.push(
			tl("Peak day {day} · {tokens} tokens", {
				day: data.peakDay.day,
				tokens: formatNumber(data.peakDay.tokens),
			})
		);
	}
	if (data.favoriteModel) {
		parts.push(tl("Favourite model {model}", { model: data.favoriteModel }));
	}
	return parts.join("   ·   ");
}
