import {
	AREA_GAP_Y,
	AREA_LABEL_HEIGHT,
	type AreaBlock,
	BOARD_PADDING,
	BOARD_PADDING_COMPACT,
	CELL_WIDTH,
	COLUMN_GAP,
	NOTE_GAP_Y,
	type NotePoint,
	type NotePositions,
	type NoticeboardArea,
	type NoticeboardLayout,
	type NoticeboardNote,
	noticeboardColumns,
	type PlacedArea,
	type PlacedNote,
} from "./noticeboard-model.ts";

/** Width of an area spanning `span` grid slots. */
function spanWidth(span: number, cellWidth: number): number {
	return span * cellWidth + (span - 1) * COLUMN_GAP;
}

/** Notes in one area: shortest column first, in reading order. */
function placeAreaNotes(
	loose: NoticeboardNote[],
	span: number,
	origin: NotePoint,
	cellWidth: number = CELL_WIDTH
): { height: number; notes: PlacedNote[] } {
	const heights = Array.from({ length: span }, () => 0);
	const notes: PlacedNote[] = [];
	for (const note of loose) {
		let column = 0;
		for (let index = 1; index < heights.length; index += 1) {
			if ((heights[index] ?? 0) < (heights[column] ?? 0)) {
				column = index;
			}
		}
		const top = heights[column] ?? 0;
		const slack = cellWidth - note.size.width;
		notes.push({
			note,
			placed: false,
			x: Math.round(
				origin.x +
					column * (cellWidth + COLUMN_GAP) +
					slack / 2 +
					note.look.jitterX
			),
			y: Math.round(origin.y + top + Math.max(0, note.look.jitterY)),
		});
		heights[column] = top + note.size.height + NOTE_GAP_Y;
	}
	return { height: Math.max(0, ...heights) - NOTE_GAP_Y, notes };
}

/** An area is never spread wider than this many slots. */
const MAX_SPAN = 4;

interface Placement {
	column: number;
	span: number;
	top: number;
}

/**
 * Skyline placement of areas in order, each at the leftmost slot where it can
 * sit highest. `spans` picks each area's width; the caller searches spans.
 */
function skyline(
	heights: number[][],
	spans: number[],
	columns: number
): { bottom: number; placements: Placement[] } {
	const sky = Array.from({ length: columns }, () => 0);
	const placements: Placement[] = [];
	for (const [index, span] of spans.entries()) {
		let bestColumn = 0;
		let bestTop = Number.POSITIVE_INFINITY;
		for (let column = 0; column + span <= columns; column += 1) {
			const top = Math.max(...sky.slice(column, column + span));
			if (top < bestTop) {
				bestTop = top;
				bestColumn = column;
			}
		}
		const top = bestTop > 0 ? bestTop + AREA_GAP_Y : 0;
		const bottom = top + AREA_LABEL_HEIGHT + (heights[index]?.[span - 1] ?? 0);
		for (let column = bestColumn; column < bestColumn + span; column += 1) {
			sky[column] = bottom;
		}
		placements.push({ column: bestColumn, span, top });
	}
	return { bottom: Math.max(0, ...sky), placements };
}

/**
 * Pick how wide each area runs so the whole board is as short as it can be
 * (ties go to the narrower arrangement). There are at most five areas and
 * four widths each, so an exhaustive search is cheap.
 */
function arrangeAreas(blocks: AreaBlock[], columns: number): Placement[] {
	const heights = blocks.map((block) =>
		Array.from(
			{ length: Math.min(MAX_SPAN, columns, block.loose.length) },
			(_, index) =>
				placeAreaNotes(block.loose, index + 1, { x: 0, y: 0 }).height
		)
	);
	const best = {
		bottom: Number.POSITIVE_INFINITY,
		placements: [] as Placement[],
		width: Number.POSITIVE_INFINITY,
	};
	const spans: number[] = [];
	const search = (index: number) => {
		if (index === blocks.length) {
			const result = skyline(heights, spans, columns);
			const width = spans.reduce((sum, span) => sum + span, 0);
			if (
				result.bottom < best.bottom ||
				(result.bottom === best.bottom && width < best.width)
			) {
				best.bottom = result.bottom;
				best.placements = result.placements;
				best.width = width;
			}
			return;
		}
		const limit = heights[index]?.length ?? 1;
		for (let span = 1; span <= limit; span += 1) {
			spans.push(span);
			search(index + 1);
			spans.pop();
		}
	};
	search(0);
	return best.placements;
}

/**
 * The whole board: tidy areas packed onto a grid that fits the width, then
 * every note the viewer moved, at the spot they left it. A moved note keeps
 * its tidy slot (left empty), so taking one note down never shuffles the
 * rest; "Tidy up" puts everything back. The board grows to hold it all.
 */
export function noticeboardLayout(
	areas: NoticeboardArea[],
	positions: NotePositions,
	boardWidth: number
): NoticeboardLayout {
	const padding =
		boardWidth < CELL_WIDTH + BOARD_PADDING * 2
			? BOARD_PADDING_COMPACT
			: BOARD_PADDING;
	const innerWidth = boardWidth - padding * 2;
	const columns = noticeboardColumns(innerWidth);
	// One column (phones, slim panes): the column takes the full width and
	// each paper centers in it, instead of hugging the left edge.
	const cellWidth =
		columns === 1 ? Math.max(CELL_WIDTH, innerWidth) : CELL_WIDTH;
	const blocks: AreaBlock[] = areas
		.filter((area) => area.notes.length > 0)
		.map((area) => ({ area, loose: area.notes }));

	const placedAreas: PlacedArea[] = [];
	const notes: PlacedNote[] = [];
	let right = 0;
	let bottom = padding;
	for (const [index, placement] of arrangeAreas(blocks, columns).entries()) {
		const block = blocks[index];
		if (!block) {
			continue;
		}
		const x = padding + placement.column * (cellWidth + COLUMN_GAP);
		const y = padding + placement.top;
		const width = spanWidth(placement.span, cellWidth);
		placedAreas.push({
			count: block.area.notes.length,
			label: block.area.label,
			status: block.area.status,
			width,
			x,
			y,
		});
		const laid = placeAreaNotes(
			block.loose,
			placement.span,
			{ x, y: y + AREA_LABEL_HEIGHT },
			cellWidth
		);
		for (const item of laid.notes) {
			const point = positions[item.note.thread.id];
			notes.push(point ? { ...item, placed: true, ...point } : item);
		}
		right = Math.max(right, x + width);
		bottom = Math.max(bottom, y + AREA_LABEL_HEIGHT + laid.height);
	}

	for (const item of notes) {
		if (item.placed) {
			right = Math.max(right, item.x + item.note.size.width);
			bottom = Math.max(bottom, item.y + item.note.size.height);
		}
	}
	return {
		areas: placedAreas,
		height: Math.ceil(bottom + padding),
		notes,
		width: Math.ceil(Math.max(boardWidth, right + padding)),
	};
}
