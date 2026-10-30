/**
 * Types for the contributions-heatmap clip (`./heatmap-clip.ts`).
 */

export interface HeatmapClipDay {
	count: number;
	/** `yyyy-MM-dd`, UTC. */
	day: string;
}

export interface HeatmapClipData {
	/** Days with at least one recorded active day, from the Stats tab. */
	activeDays?: number | null;
	days: readonly HeatmapClipDay[];
	/** The last day the grid shows (`yyyy-MM-dd`). Defaults to the latest day in `days`. */
	endDay?: string | null;
	favoriteModel?: string | null;
	level: number;
	name: string;
	peakDay?: { day: string; tokens: number } | null;
	streakCurrent: number;
	streakLongest?: number | null;
	totalTokens: number;
}

export interface HeatmapClipPalette {
	background: string;
	/** The empty-day cell. */
	empty: string;
	foreground: string;
	/** Buckets 1..4, lowest first. */
	levels: readonly [string, string, string, string];
	muted: string;
}

export interface HeatmapClipSize {
	height: number;
	width: number;
}

export interface HeatmapClipCell {
	count: number;
	day: string;
	/** A day after `endDay` that only pads out the final week. */
	filler: boolean;
	/** 0 = empty, 1..4 = intensity bucket. */
	level: number;
	/** Chronological position among non-filler days, 0-based; -1 for filler. */
	order: number;
	week: number;
	weekday: number;
}

export interface HeatmapGridLayout {
	bands: number;
	cell: number;
	columns: number;
	height: number;
	left: number;
	pitch: number;
	top: number;
	width: number;
}

export interface HeatmapClipLayout {
	grid: HeatmapGridLayout;
	margin: number;
	statsTop: number;
	/** Device px per 1080-short-edge px. */
	unit: number;
}

export interface HeatmapClipTimeline {
	/** Whole-scene opacity: fades in at the start and out before the wrap. */
	alpha: number;
	/** Fraction of the year's days revealed, 0..1. */
	fill: number;
	/** Count-up progress of the headline numbers, 0..1. */
	stats: number;
}

export interface HeatmapClipStat {
	label: string;
	value: string;
}
