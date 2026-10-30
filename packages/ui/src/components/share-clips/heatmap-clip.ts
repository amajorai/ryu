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

import { formatNumber } from "../../lib/number-format.ts";
import { drawGhost, ellipsize } from "../pass-studio/paint.ts";
import type {
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
const MARK_PX = 44;
const WORDMARK_PX = 38;
const META_PX = 26;
const NAME_PX = 64;
const SUBTITLE_PX = 30;
const STAT_VALUE_PX = 60;
const STAT_LABEL_PX = 26;
const STAT_ROW_PX = 130;
const FOOTER_PX = 26;
const HEADER_BLOCK_PX = 260;
const SECTION_GAP_PX = 56;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
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

/** Top-left corner of a cell in device px. */
export function heatmapCellPosition(
	grid: HeatmapGridLayout,
	week: number,
	weekday: number
): { x: number; y: number } {
	const band = Math.floor(week / grid.columns);
	const column = week % grid.columns;
	return {
		x: grid.left + column * grid.pitch,
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
	progress: number
): HeatmapClipStat[] {
	const longest = data.streakLongest ?? 0;
	return [
		{
			label: "Total tokens",
			value: formatNumber(countUp(data.totalTokens, progress)),
		},
		{
			label: "Active days",
			value: formatNumber(countUp(data.activeDays ?? 0, progress)),
		},
		{
			label: longest > 0 ? `Day streak · best ${longest}` : "Day streak",
			value: formatNumber(countUp(data.streakCurrent, progress)),
		},
		{ label: "Level", value: formatNumber(countUp(data.level, progress)) },
	];
}

/** The footer line: peak day and favourite model, when there are any. */
export function heatmapClipFooter(data: HeatmapClipData): string {
	const parts: string[] = [];
	if (data.peakDay && data.peakDay.tokens > 0) {
		parts.push(
			`Peak day ${data.peakDay.day} · ${formatNumber(data.peakDay.tokens)} tokens`
		);
	}
	if (data.favoriteModel) {
		parts.push(`Favourite model ${data.favoriteModel}`);
	}
	return parts.join("   ·   ");
}

const fontString = (
	family: string,
	weight: number,
	px: number,
	unit: number
): string => `${weight} ${px * unit}px ${family}`;

function fillRoundedRect(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	size: number,
	radius: number
): void {
	if (typeof ctx.roundRect === "function") {
		ctx.beginPath();
		ctx.roundRect(x, y, size, size, radius);
		ctx.fill();
		return;
	}
	ctx.fillRect(x, y, size, size);
}

function drawHeader(
	ctx: CanvasRenderingContext2D,
	data: HeatmapClipData,
	layout: HeatmapClipLayout,
	size: HeatmapClipSize,
	palette: HeatmapClipPalette,
	family: string
): void {
	const { margin, unit } = layout;
	// Ryu mark + wordmark, top left.
	drawGhost(ctx, {
		color: palette.foreground,
		scale: unit,
		size: MARK_PX,
		x: margin / unit,
		y: margin / unit,
	});
	const middle = margin + (MARK_PX * unit) / 2;
	ctx.textBaseline = "middle";
	ctx.textAlign = "left";
	ctx.fillStyle = palette.foreground;
	ctx.font = fontString(family, 600, WORDMARK_PX, unit);
	ctx.fillText("Ryu", margin + (MARK_PX + 14) * unit, middle);
	ctx.textAlign = "right";
	ctx.fillStyle = palette.muted;
	ctx.font = fontString(family, 400, META_PX, unit);
	ctx.fillText("Last 12 months", size.width - margin, middle);

	ctx.textBaseline = "alphabetic";
	ctx.textAlign = "left";
	const available = size.width - margin * 2;
	const nameBaseline = margin + (MARK_PX + 40 + NAME_PX) * unit;
	ctx.fillStyle = palette.foreground;
	ctx.font = fontString(family, 600, NAME_PX, unit);
	ctx.fillText(ellipsize(ctx, data.name, available), margin, nameBaseline);
	ctx.fillStyle = palette.muted;
	ctx.font = fontString(family, 400, SUBTITLE_PX, unit);
	ctx.fillText(
		"Daily activity on Ryu",
		margin,
		nameBaseline + (SUBTITLE_PX + 18) * unit
	);
}

function drawGrid(
	ctx: CanvasRenderingContext2D,
	cells: readonly HeatmapClipCell[],
	grid: HeatmapGridLayout,
	palette: HeatmapClipPalette,
	fill: number
): void {
	const total = cells.reduce((sum, cell) => sum + (cell.filler ? 0 : 1), 0);
	const radius = grid.cell * 0.2;
	for (const cell of cells) {
		if (cell.filler) {
			continue;
		}
		const { x, y } = heatmapCellPosition(grid, cell.week, cell.weekday);
		ctx.fillStyle = palette.empty;
		fillRoundedRect(ctx, x, y, grid.cell, radius);
		if (cell.level === 0) {
			continue;
		}
		const reveal = cellRevealProgress(cell.order, total, fill);
		if (reveal <= 0) {
			continue;
		}
		// Grows from the cell's centre as it lands.
		const side = grid.cell * reveal;
		const inset = (grid.cell - side) / 2;
		ctx.fillStyle = palette.levels[cell.level - 1] ?? palette.levels[0];
		fillRoundedRect(ctx, x + inset, y + inset, side, radius * reveal);
	}
}

function drawStats(
	ctx: CanvasRenderingContext2D,
	data: HeatmapClipData,
	layout: HeatmapClipLayout,
	size: HeatmapClipSize,
	palette: HeatmapClipPalette,
	family: string,
	progress: number
): void {
	const { margin, statsTop, unit } = layout;
	const columnWidth = (size.width - margin * 2) / 2;
	const stats = heatmapClipStats(data, progress);
	ctx.textAlign = "left";
	ctx.textBaseline = "alphabetic";
	// The block fades in over the first half of its count-up rather than sitting
	// on screen as a row of zeros while the grid fills.
	ctx.globalAlpha *= clamp01(progress * 2);
	for (const [index, stat] of stats.entries()) {
		const x = margin + (index % 2) * columnWidth;
		const rowTop = statsTop + Math.floor(index / 2) * STAT_ROW_PX * unit;
		const maxWidth = columnWidth - 24 * unit;
		ctx.fillStyle = palette.foreground;
		ctx.font = fontString(family, 600, STAT_VALUE_PX, unit);
		ctx.fillText(
			ellipsize(ctx, stat.value, maxWidth),
			x,
			rowTop + STAT_VALUE_PX * unit
		);
		ctx.fillStyle = palette.muted;
		ctx.font = fontString(family, 400, STAT_LABEL_PX, unit);
		ctx.fillText(
			ellipsize(ctx, stat.label, maxWidth),
			x,
			rowTop + (STAT_VALUE_PX + STAT_LABEL_PX + 12) * unit
		);
	}
	const footer = heatmapClipFooter(data);
	if (footer) {
		ctx.fillStyle = palette.muted;
		ctx.font = fontString(family, 400, FOOTER_PX, unit);
		ctx.fillText(
			ellipsize(ctx, footer, size.width - margin * 2),
			margin,
			statsTop + (STAT_ROW_PX * 2 + SECTION_GAP_PX / 2 + FOOTER_PX) * unit
		);
	}
}

/**
 * Draw the frame at `time` seconds into a `size` canvas. Pure apart from the
 * canvas it is handed: same arguments, same pixels.
 */
export function drawHeatmapFrame(
	ctx: CanvasRenderingContext2D,
	data: HeatmapClipData,
	time: number,
	size: HeatmapClipSize,
	palette: HeatmapClipPalette,
	options: { cells?: readonly HeatmapClipCell[]; fontFamily?: string } = {}
): void {
	const family = options.fontFamily ?? "system-ui, sans-serif";
	const cells = options.cells ?? buildHeatmapCells(data.days, data.endDay);
	const layout = layoutHeatmapClip(size);
	const phase = heatmapClipTimeline(time);

	ctx.save();
	ctx.globalAlpha = 1;
	ctx.fillStyle = palette.background;
	ctx.fillRect(0, 0, size.width, size.height);
	ctx.globalAlpha = phase.alpha;
	drawHeader(ctx, data, layout, size, palette, family);
	drawGrid(ctx, cells, layout.grid, palette, phase.fill);
	drawStats(ctx, data, layout, size, palette, family, phase.stats);
	ctx.restore();
}
