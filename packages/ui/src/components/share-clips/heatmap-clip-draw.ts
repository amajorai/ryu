/**
 * Painting one frame of the contributions-heatmap clip. Split from
 * `heatmap-clip.ts` (which owns the layout, timeline and copy, and re-exports
 * `drawHeatmapFrame`).
 *
 * The frame follows the UI's reading direction the way the live
 * `ContributionsGraph` does under `dir="rtl"`: the lockup and the name start at
 * the right, the meta sits opposite on the left, the stat grid fills from the
 * right, and the year's weeks run right to left. In LTR every anchor is the one
 * it always was.
 */

import type { LiteralMessage } from "@ryu/i18n/react";
import { drawGhost, ellipsize } from "../pass-studio/paint.ts";
import {
	buildHeatmapCells,
	cellRevealProgress,
	clamp01,
	FOOTER_PX,
	heatmapCellPosition,
	heatmapClipFooter,
	heatmapClipStats,
	heatmapClipTimeline,
	layoutHeatmapClip,
	SECTION_GAP_PX,
	STAT_ROW_PX,
} from "./heatmap-clip.ts";
import { fillRoundedRect, fontString } from "./heatmap-clip-canvas.ts";
import type {
	HeatmapClipCell,
	HeatmapClipData,
	HeatmapClipLayout,
	HeatmapClipPalette,
	HeatmapClipSize,
	HeatmapGridLayout,
} from "./heatmap-clip-types.ts";

const MARK_PX = 44;
const WORDMARK_PX = 38;
const META_PX = 26;
const NAME_PX = 64;
const SUBTITLE_PX = 30;
const STAT_VALUE_PX = 60;
const STAT_LABEL_PX = 26;

/** The frame's inline axis: start-relative x to physical x, and alignments. */
interface InlineAxis {
	end: CanvasTextAlign;
	rtl: boolean;
	start: CanvasTextAlign;
	x(x: number): number;
}

function inlineAxis(width: number, rtl: boolean): InlineAxis {
	return {
		end: rtl ? "left" : "right",
		rtl,
		start: rtl ? "right" : "left",
		x: (x) => (rtl ? width - x : x),
	};
}

interface FrameContext {
	family: string;
	inline: InlineAxis;
	layout: HeatmapClipLayout;
	palette: HeatmapClipPalette;
	size: HeatmapClipSize;
	tl: LiteralMessage;
}

function drawHeader(
	ctx: CanvasRenderingContext2D,
	data: HeatmapClipData,
	{ family, inline, layout, palette, size, tl }: FrameContext
): void {
	const { margin, unit } = layout;
	// Ryu mark + wordmark, top start.
	drawGhost(ctx, {
		color: palette.foreground,
		scale: unit,
		size: MARK_PX,
		x: inline.rtl ? (size.width - margin) / unit - MARK_PX : margin / unit,
		y: margin / unit,
	});
	const middle = margin + (MARK_PX * unit) / 2;
	ctx.textBaseline = "middle";
	ctx.textAlign = inline.start;
	ctx.fillStyle = palette.foreground;
	ctx.font = fontString(family, 600, WORDMARK_PX, unit);
	ctx.fillText("Ryu", inline.x(margin + (MARK_PX + 14) * unit), middle);
	ctx.textAlign = inline.end;
	ctx.fillStyle = palette.muted;
	ctx.font = fontString(family, 400, META_PX, unit);
	ctx.fillText(tl("Last 12 months"), inline.x(size.width - margin), middle);

	ctx.textBaseline = "alphabetic";
	ctx.textAlign = inline.start;
	const available = size.width - margin * 2;
	const nameBaseline = margin + (MARK_PX + 40 + NAME_PX) * unit;
	ctx.fillStyle = palette.foreground;
	ctx.font = fontString(family, 600, NAME_PX, unit);
	ctx.fillText(
		ellipsize(ctx, data.name, available),
		inline.x(margin),
		nameBaseline
	);
	ctx.fillStyle = palette.muted;
	ctx.font = fontString(family, 400, SUBTITLE_PX, unit);
	ctx.fillText(
		tl("Daily activity on Ryu"),
		inline.x(margin),
		nameBaseline + (SUBTITLE_PX + 18) * unit
	);
}

function drawGrid(
	ctx: CanvasRenderingContext2D,
	cells: readonly HeatmapClipCell[],
	grid: HeatmapGridLayout,
	palette: HeatmapClipPalette,
	fill: number,
	rtl: boolean
): void {
	const total = cells.reduce((sum, cell) => sum + (cell.filler ? 0 : 1), 0);
	const radius = grid.cell * 0.2;
	for (const cell of cells) {
		if (cell.filler) {
			continue;
		}
		const { x, y } = heatmapCellPosition(grid, cell.week, cell.weekday, rtl);
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
	progress: number,
	{ family, inline, layout, palette, size, tl }: FrameContext
): void {
	const { margin, statsTop, unit } = layout;
	const columnWidth = (size.width - margin * 2) / 2;
	const stats = heatmapClipStats(data, progress, tl);
	ctx.textAlign = inline.start;
	ctx.textBaseline = "alphabetic";
	// The block fades in over the first half of its count-up rather than sitting
	// on screen as a row of zeros while the grid fills.
	ctx.globalAlpha *= clamp01(progress * 2);
	for (const [index, stat] of stats.entries()) {
		const x = inline.x(margin + (index % 2) * columnWidth);
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
	const footer = heatmapClipFooter(data, tl);
	if (footer) {
		ctx.fillStyle = palette.muted;
		ctx.font = fontString(family, 400, FOOTER_PX, unit);
		ctx.fillText(
			ellipsize(ctx, footer, size.width - margin * 2),
			inline.x(margin),
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
	options: {
		cells?: readonly HeatmapClipCell[];
		fontFamily?: string;
		/** Lay the frame out right-to-left (the UI's direction). */
		rtl?: boolean;
		tl: LiteralMessage;
	}
): void {
	const rtl = options.rtl ?? false;
	const frame: FrameContext = {
		family: options.fontFamily ?? "system-ui, sans-serif",
		inline: inlineAxis(size.width, rtl),
		layout: layoutHeatmapClip(size),
		palette,
		size,
		tl: options.tl,
	};
	const cells = options.cells ?? buildHeatmapCells(data.days, data.endDay);
	const phase = heatmapClipTimeline(time);

	ctx.save();
	ctx.direction = rtl ? "rtl" : "ltr";
	ctx.globalAlpha = 1;
	ctx.fillStyle = palette.background;
	ctx.fillRect(0, 0, size.width, size.height);
	ctx.globalAlpha = phase.alpha;
	drawHeader(ctx, data, frame);
	drawGrid(ctx, cells, frame.layout.grid, palette, phase.fill, rtl);
	drawStats(ctx, data, phase.stats, frame);
	ctx.restore();
}
