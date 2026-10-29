import { describe, expect, test } from "bun:test";
import { PASS_FORMATS } from "../pass-studio/formats.ts";
import {
	buildHeatmapCells,
	cellRevealProgress,
	countUp,
	drawHeatmapFrame,
	HEATMAP_CLIP_HOLD_TIME,
	HEATMAP_CLIP_PALETTES,
	HEATMAP_CLIP_SECONDS,
	HEATMAP_WEEKS,
	type HeatmapClipData,
	heatmapCellPosition,
	heatmapClipFooter,
	heatmapClipStats,
	heatmapClipTimeline,
	heatmapGridLayout,
	heatmapLevel,
	layoutHeatmapClip,
} from "./heatmap-clip.ts";

const DATA: HeatmapClipData = {
	activeDays: 42,
	days: [
		{ count: 3, day: "2026-10-09" },
		{ count: 12, day: "2026-10-10" },
		{ count: 1, day: "2025-11-02" },
	],
	endDay: "2026-10-14",
	favoriteModel: "model-a",
	level: 7,
	name: "Ada Lovelace",
	peakDay: { day: "2026-10-01", tokens: 98_765 },
	streakCurrent: 4,
	streakLongest: 12,
	totalTokens: 1_234_567,
};

describe("buildHeatmapCells", () => {
	const cells = buildHeatmapCells(DATA.days, DATA.endDay);

	test("lays out 53 Sunday-first weeks ending on the end day's week", () => {
		expect(cells).toHaveLength(HEATMAP_WEEKS * 7);
		const last = cells.at(-1);
		// 2026-10-14 is a Wednesday, so the last week runs to Saturday the 17th.
		expect(last?.day).toBe("2026-10-17");
		expect(last?.filler).toBe(true);
		expect(cells.find((cell) => cell.day === "2026-10-14")?.filler).toBe(false);
		expect(new Date(`${cells[0]?.day}T00:00:00Z`).getUTCDay()).toBe(0);
	});

	test("orders real days chronologically and skips filler", () => {
		const real = cells.filter((cell) => !cell.filler);
		expect(real.map((cell) => cell.order)).toEqual(real.map((_, i) => i));
		expect(
			cells.filter((cell) => cell.filler).every((cell) => cell.order === -1)
		).toBe(true);
	});

	test("buckets against the busiest day", () => {
		const level = (day: string) =>
			cells.find((cell) => cell.day === day)?.level;
		expect(level("2026-10-10")).toBe(4);
		expect(level("2026-10-09")).toBe(1);
		expect(level("2026-10-11")).toBe(0);
	});

	test("defaults the end to the latest data day", () => {
		const fallback = buildHeatmapCells(DATA.days);
		expect(fallback.some((cell) => cell.day === "2026-10-10")).toBe(true);
		expect(fallback.filter((cell) => !cell.filler).at(-1)?.day).toBe(
			"2026-10-10"
		);
	});
});

test("heatmapLevel matches the contributions graph's bucket rule", () => {
	expect(heatmapLevel(0, 10)).toBe(0);
	expect(heatmapLevel(1, 10)).toBe(1);
	expect(heatmapLevel(5, 10)).toBe(2);
	expect(heatmapLevel(10, 10)).toBe(4);
	expect(heatmapLevel(3, 0)).toBe(0);
});

describe("grid layout", () => {
	test("a wide box keeps one strip; a tall box wraps into bands", () => {
		expect(
			heatmapGridLayout({ height: 300, left: 0, top: 0, width: 1800 }).bands
		).toBe(1);
		expect(
			heatmapGridLayout({ height: 1000, left: 0, top: 0, width: 900 }).bands
		).toBeGreaterThan(1);
	});

	test("every share format's grid stays inside the frame and above the stats", () => {
		for (const format of PASS_FORMATS) {
			const size = { height: format.height, width: format.width };
			const layout = layoutHeatmapClip(size);
			const { grid } = layout;
			expect(grid.left).toBeGreaterThanOrEqual(layout.margin - 0.001);
			expect(grid.left + grid.width).toBeLessThanOrEqual(
				size.width - layout.margin + 0.001
			);
			expect(layout.statsTop).toBeGreaterThan(grid.top + grid.height);
			expect(layout.statsTop).toBeLessThan(size.height);
			const lastWeek = heatmapCellPosition(grid, HEATMAP_WEEKS - 1, 6);
			expect(lastWeek.x + grid.cell).toBeLessThanOrEqual(
				grid.left + grid.width + 0.001
			);
			expect(lastWeek.y + grid.cell).toBeLessThanOrEqual(
				grid.top + grid.height + 0.001
			);
		}
	});

	test("cells never overlap", () => {
		const grid = heatmapGridLayout({
			height: 900,
			left: 0,
			top: 0,
			width: 900,
		});
		const a = heatmapCellPosition(grid, 0, 0);
		const b = heatmapCellPosition(grid, 1, 0);
		const c = heatmapCellPosition(grid, 0, 1);
		expect(b.x - a.x).toBeGreaterThan(grid.cell);
		expect(c.y - a.y).toBeGreaterThan(grid.cell);
	});
});

describe("timeline", () => {
	test("starts and ends on the bare background so the loop has no seam", () => {
		expect(heatmapClipTimeline(0).alpha).toBe(0);
		expect(heatmapClipTimeline(HEATMAP_CLIP_SECONDS - 1e-6).alpha).toBeCloseTo(
			0,
			4
		);
		expect(heatmapClipTimeline(HEATMAP_CLIP_SECONDS).alpha).toBe(0);
	});

	test("fills, then counts, then holds the finished frame", () => {
		expect(heatmapClipTimeline(0).fill).toBe(0);
		const hold = heatmapClipTimeline(HEATMAP_CLIP_HOLD_TIME);
		expect(hold).toEqual({ alpha: 1, fill: 1, stats: 1 });
		let previous = -1;
		for (let t = 0; t < HEATMAP_CLIP_SECONDS; t += 0.25) {
			const { fill } = heatmapClipTimeline(t);
			expect(fill).toBeGreaterThanOrEqual(previous);
			previous = fill;
		}
	});

	test("cells reveal in order and all land by the end of the fill", () => {
		expect(cellRevealProgress(0, 365, 0)).toBe(0);
		expect(cellRevealProgress(10, 365, 0.5)).toBeGreaterThan(
			cellRevealProgress(300, 365, 0.5)
		);
		expect(cellRevealProgress(364, 365, 1)).toBe(1);
		expect(cellRevealProgress(-1, 365, 1)).toBe(0);
	});

	test("countUp lands exactly on the real value", () => {
		expect(countUp(1_234_567, 1)).toBe(1_234_567);
		expect(countUp(1_234_567, 0)).toBe(0);
		expect(countUp(10, 0.5)).toBe(5);
	});
});

test("the stats and footer only carry the Stats tab's own figures", () => {
	expect(heatmapClipStats(DATA, 1)).toEqual([
		{ label: "Total tokens", value: "1.2m" },
		{ label: "Active days", value: "42" },
		{ label: "Day streak · best 12", value: "4" },
		{ label: "Level", value: "7" },
	]);
	expect(heatmapClipFooter(DATA)).toContain("Peak day 2026-10-01");
	expect(heatmapClipFooter(DATA)).toContain("Favourite model model-a");
	expect(
		heatmapClipFooter({ ...DATA, favoriteModel: null, peakDay: null })
	).toBe("");
});

/** A 2D context that records what was drawn and nothing else. */
function recordingContext() {
	const texts: string[] = [];
	const fills: string[] = [];
	const state = { fillStyle: "", globalAlpha: 1 };
	const ctx = new Proxy(state as Record<string, unknown>, {
		get(target, key) {
			if (key === "fillText") {
				return (text: string) => texts.push(text);
			}
			if (key === "measureText") {
				return (text: string) => ({ width: text.length * 10 });
			}
			if (key === "fillRect" || key === "fill") {
				return () => fills.push(String(target.fillStyle));
			}
			if (key in target) {
				return target[key as string];
			}
			return () => undefined;
		},
		set(target, key, value) {
			target[key as string] = value;
			return true;
		},
	}) as unknown as CanvasRenderingContext2D;
	return { ctx, fills, texts };
}

describe("drawHeatmapFrame", () => {
	globalThis.Path2D ??= class {} as unknown as typeof Path2D;
	const size = { height: 1080, width: 1080 };
	const palette = HEATMAP_CLIP_PALETTES.dark;

	test("the held frame shows the wordmark, the name, the numbers and every active day", () => {
		const { ctx, fills, texts } = recordingContext();
		drawHeatmapFrame(ctx, DATA, HEATMAP_CLIP_HOLD_TIME, size, palette);
		expect(texts).toContain("Ryu");
		expect(texts).toContain("Ada Lovelace");
		expect(texts).toContain("1.2m");
		expect(fills[0]).toBe(palette.background);
		const lit = fills.filter((fill) =>
			(palette.levels as readonly string[]).includes(fill)
		);
		expect(lit).toHaveLength(3);
	});

	test("before the fill starts no day is lit", () => {
		const { ctx, fills } = recordingContext();
		drawHeatmapFrame(ctx, DATA, 0.1, size, palette);
		expect(
			fills.some((fill) => (palette.levels as readonly string[]).includes(fill))
		).toBe(false);
	});
});
