/**
 * Text fitting for stamps: estimated glyph widths, the room a shape leaves at
 * each height, and balanced wrapping into that room. Pure, so the layout is
 * the same in tests, on the server, and in the browser; the browser then
 * condenses any line whose real width still runs past its room.
 */

import type { StampShape } from "./passport-model.ts";

/** The stamp box, in stamp units. */
export const STAMP_BOX_WIDTH = 168;
export const STAMP_BOX_HEIGHT = 140;
const CY = STAMP_BOX_HEIGHT / 2;

const NARROW = new Set("iljI.,:;'|!·");
const SEMI_NARROW = new Set("frt()[]-–/ ");
const WIDE = new Set("mwMW@");

/** Estimated advance of a proportional (sans) run, in units of `size`. */
export function sansWidth(text: string, size: number): number {
	let total = 0;
	for (const char of text) {
		if (NARROW.has(char)) {
			total += 0.28;
		} else if (SEMI_NARROW.has(char)) {
			total += 0.37;
		} else if (WIDE.has(char)) {
			total += 0.84;
		} else if (char >= "0" && char <= "9") {
			total += 0.58;
		} else if (char === char.toLowerCase()) {
			total += 0.56;
		} else {
			total += 0.68;
		}
	}
	return total * size;
}

/** Advance of a monospace run with letter spacing, in stamp units. */
export function monoWidth(text: string, size: number, spacing: number): number {
	return [...text].length * (size * 0.6 + spacing);
}

/** Half the usable width of a shape's inner field at height `y`. */
function halfAt(shape: StampShape, y: number): number {
	switch (shape) {
		case "circle": {
			const radius = 46;
			const dy = Math.abs(y - CY);
			return dy >= radius ? 0 : Math.sqrt(radius * radius - dy * dy) - 3;
		}
		case "octagon": {
			const radius = 64;
			const side = radius * Math.cos(Math.PI / 8);
			const flat = radius * Math.sin(Math.PI / 8);
			const dy = Math.abs(y - CY);
			return (dy <= flat ? side : side + flat - dy) - 4;
		}
		case "triangle":
			// Inner border runs parallel to the sides, about 7 units in; lines
			// keep a further margin off it so they never press on the slope.
			return Math.max(0, 0.606 * (y - 4) - 12);
		default:
			return 68;
	}
}

/**
 * The width a line can use when its baseline sits at `baseline`: the
 * narrowest point between its cap height and its baseline.
 */
export function roomAt(
	shape: StampShape,
	baseline: number,
	size: number
): number {
	const top = baseline - size * 0.74;
	return 2 * Math.min(halfAt(shape, top), halfAt(shape, baseline + 1));
}

const TRAILING_BREAK = /[\s\-–—,.:;/·]+$/;

/** Cut `text` so it and an ellipsis fit `width`, at a word edge if close. */
export function ellipsize(
	text: string,
	width: number,
	measure: (value: string) => number
): string {
	if (measure(text) <= width) {
		return text;
	}
	const chars = [...text];
	let end = chars.length;
	while (end > 0 && measure(`${chars.slice(0, end).join("")}…`) > width) {
		end -= 1;
	}
	let cut = chars.slice(0, end).join("");
	const space = cut.lastIndexOf(" ");
	const midWord = /\S/.test(chars[end] ?? " ");
	// Never leave a one- or two-letter stub of a word before the ellipsis.
	if (midWord && space > 0 && cut.length - space - 1 < 3) {
		cut = cut.slice(0, space);
	}
	return `${cut.replace(TRAILING_BREAK, "")}…`;
}

/**
 * Wrap `text` into at most `widths.length` lines (1 or 2), each within its
 * own width. Two lines break where they come out most even, so a title reads
 * as a block, not a full line and a stub. Runs out of room with an ellipsis.
 */
export function wrapBalanced(
	text: string,
	widths: readonly number[],
	measure: (value: string) => number
): string[] {
	const clean = text.trim().replace(/\s+/g, " ");
	const first = widths[0] ?? 0;
	if (!clean) {
		return [];
	}
	if (widths.length < 2 || measure(clean) <= first) {
		return [ellipsize(clean, first, measure)];
	}
	const second = widths[1] ?? first;
	const words = clean.split(" ");
	let best: [string, string] | null = null;
	let bestScore = Number.POSITIVE_INFINITY;
	for (let index = 1; index < words.length; index += 1) {
		const head = words.slice(0, index).join(" ");
		const tail = words.slice(index).join(" ");
		const headFill = measure(head) / first;
		const tailFill = measure(tail) / second;
		if (headFill <= 1 && tailFill <= 1) {
			const score = Math.max(headFill, tailFill);
			if (score < bestScore) {
				bestScore = score;
				best = [head, tail];
			}
		}
	}
	if (best) {
		return best;
	}
	// Too long for two lines: fill the first, then cut the second.
	let split = 0;
	while (
		split < words.length &&
		measure(words.slice(0, split + 1).join(" ")) <= first
	) {
		split += 1;
	}
	if (split === 0) {
		// One word wider than the line: break it.
		const head = ellipsize(clean, first, measure).replace(/…$/, "");
		const rest = clean.slice(head.length).trim();
		return [head, ellipsize(rest, second, measure)];
	}
	return [
		words.slice(0, split).join(" "),
		ellipsize(words.slice(split).join(" "), second, measure),
	];
}

export interface StampTextRow {
	family: "mono" | "sans";
	/** Width the line may take; the browser condenses it past this. */
	room: number;
	size: number;
	/** Letter spacing in stamp units (mono lines). */
	spacing: number;
	text: string;
	weight: number;
	/** Baseline. */
	y: number;
}

/** Type sizes in stamp units; a stamp prints at 1:1 at the booklet's base scale. */
export const STAMP_TYPE = {
	/** The entry date: largest line, sized to the room each shape has. */
	date: { circle: 10.4, octagon: 10.4, rectangle: 11.4, triangle: 9.2 },
	latest: 8.4,
	marking: 8.6,
	title: { circle: 9.8, octagon: 9.8, rectangle: 9.8, triangle: 9.2 },
} as const;

/** The desk's larger printing (`stampTextRows({ large })`). */
const LARGE_TYPE = {
	date: { circle: 15, octagon: 15, rectangle: 17, triangle: 13 },
	latest: STAMP_TYPE.latest,
	marking: 10.4,
	title: { circle: 12.4, octagon: 12.4, rectangle: 13, triangle: 11.4 },
} as const;

/** Vertical centre of the entry lines, per shape. */
const CENTER: Record<StampShape, number> = {
	circle: 72,
	octagon: 72,
	rectangle: 71.5,
	triangle: 95,
};

/**
 * Destination lines per shape. The triangle's field is short and narrows
 * fast, so it prints the title on one line (the record and the tooltip
 * carry it in full).
 */
const TITLE_LINES: Record<StampShape, 1 | 2> = {
	circle: 2,
	octagon: 2,
	rectangle: 2,
	triangle: 1,
};

/** The triangle packs its lines tighter: its field is short and narrows fast. */
function rowGap(shape: StampShape): number {
	return shape === "triangle" ? 1.6 : 2.4;
}

const MONO_SPACING = 0.4;

function dateSpacing(shape: StampShape): number {
	return shape === "triangle" ? 0 : MONO_SPACING;
}

function rowSpacing(shape: StampShape, row: RowSpec): number {
	if (row.family === "sans") {
		return 0;
	}
	return row.kind === "date" ? dateSpacing(shape) : MONO_SPACING;
}

interface RowSpec {
	family: "mono" | "sans";
	kind: "date" | "latest" | "marking" | "title";
	size: number;
	text: string;
	weight: number;
}

function placeRows(shape: StampShape, rows: readonly RowSpec[]) {
	const heights = rows.map((row) => row.size * 1.12);
	const gap = rowGap(shape);
	const total =
		heights.reduce((sum, height) => sum + height, 0) +
		gap * Math.max(0, rows.length - 1);
	let top = CENTER[shape] - total / 2;
	return rows.map((row, index) => {
		const height = heights[index] ?? row.size;
		// Baseline sits a little above the box bottom, leaving room for descenders.
		const y = top + height - row.size * 0.2;
		top += height + gap;
		return { row, y };
	});
}

function sansMeasure(size: number) {
	return (value: string) => sansWidth(value, size);
}

function monoMeasure(size: number) {
	return (value: string) => monoWidth(value, size, MONO_SPACING);
}

/**
 * The lines inside a stamp: an optional marking (octagon), the entry date,
 * the destination in up to two balanced lines, and the latest date. Widths
 * follow the shape, so a line near a triangle's apex is shorter than one by
 * its base.
 */
export function stampTextRows({
	date,
	large = false,
	latest,
	marking,
	shape,
	title,
}: {
	date: string;
	/**
	 * The desk's printing (seen from a low angle): the date and a one-line
	 * destination in larger type, and no latest line.
	 */
	large?: boolean;
	latest: string;
	/** Printed among the lines (octagon); null when it prints on the rim. */
	marking: string | null;
	shape: StampShape;
	title: string;
}): StampTextRow[] {
	const type = large ? LARGE_TYPE : STAMP_TYPE;
	const markingRows = (lines: string[]): RowSpec[] =>
		lines.map((text) => ({
			family: "mono",
			kind: "marking",
			size: type.marking,
			text,
			weight: 800,
		}));
	const build = (markingLines: string[], titleLines: string[]): RowSpec[] => [
		...markingRows(markingLines),
		{
			family: "mono",
			kind: "date",
			size: type.date[shape],
			text: date,
			weight: 800,
		},
		...titleLines.map(
			(text): RowSpec => ({
				family: "sans",
				kind: "title",
				size: type.title[shape],
				text,
				weight: large ? 700 : 600,
			})
		),
		...(large
			? []
			: [
					{
						family: "mono",
						kind: "latest",
						size: type.latest,
						text: latest,
						weight: 700,
					} satisfies RowSpec,
				]),
	];

	// First pass: room for two marking lines and the shape's title lines.
	const markingMeasure = monoMeasure(type.marking);
	let markingLines: string[] = [];
	if (marking) {
		const draft = placeRows(
			shape,
			build(
				["", ""],
				Array.from({ length: large ? 1 : TITLE_LINES[shape] }, () => "")
			)
		);
		const widths = draft
			.filter(({ row }) => row.kind === "marking")
			.map(({ row, y }) => roomAt(shape, y, row.size));
		markingLines = wrapBalanced(marking, widths, markingMeasure);
	}
	const titleMeasure = sansMeasure(type.title[shape]);
	const slots: string[] = Array.from(
		{ length: large ? 1 : TITLE_LINES[shape] },
		() => ""
	);
	const titleDraft = placeRows(shape, build(markingLines, slots));
	const titleWidths = titleDraft
		.filter(({ row }) => row.kind === "title")
		.map(({ row, y }) => roomAt(shape, y, row.size));
	const titleLines = wrapBalanced(title, titleWidths, titleMeasure);
	let placed = placeRows(shape, build(markingLines, titleLines));
	if (titleLines.length === 1 && slots.length > 1) {
		// Centred on one line it may sit where the shape is narrower; if it
		// no longer fits there, keep the two-line slots and leave one empty.
		const slot = placed.find(({ row }) => row.kind === "title");
		const room = slot ? roomAt(shape, slot.y, slot.row.size) : 0;
		if (titleMeasure(titleLines[0] ?? "") > room) {
			placed = placeRows(shape, build(markingLines, [titleLines[0] ?? "", ""]));
		}
	}
	return placed
		.filter(({ row }) => row.text !== "")
		.map(({ row, y }) => ({
			family: row.family,
			room: roomAt(shape, y, row.size),
			size: row.size,
			spacing: rowSpacing(shape, row),
			text: row.text,
			weight: row.weight,
			y,
		}));
}
