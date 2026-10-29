import {
	type InterfaceAgent,
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	THREAD_STATUS_ORDER,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

/**
 * Pure view-model for the Noticeboard: which paper each conversation is
 * pinned up on, how it sits, and where it goes on the board. Everything here
 * is deterministic for a thread id, so a note keeps its look across reloads.
 */

/** A sticky note, a ruled index card, or a typed memo with a header strip. */
export type NoteKind = "card" | "memo" | "note";
/** What holds the paper to the board. */
export type NoteFastener = "pin" | "tape";

export interface NoteSize {
	height: number;
	width: number;
}

/** Every paper's footprint. Heights are fixed so the board keeps a rhythm. */
export const NOTE_SIZES: Record<NoteKind, NoteSize> = {
	card: { height: 168, width: 248 },
	memo: { height: 232, width: 224 },
	note: { height: 208, width: 224 },
};

/** One grid slot: the widest paper plus room for its tilt. */
export const CELL_WIDTH = 256;
/** Gutter between grid slots, inside and between areas. */
export const COLUMN_GAP = 24;
/** Gap under each paper inside an area column. */
export const NOTE_GAP_Y = 28;
/** Gap between an area and the one stacked below it. */
export const AREA_GAP_Y = 40;
/** Height of an area's label strip, including the space below it. */
export const AREA_LABEL_HEIGHT = 44;
/** Board margin around the laid-out areas. */
export const BOARD_PADDING = 24;
/** Narrow boards (phones) use a tighter margin. */
export const BOARD_PADDING_COMPACT = 16;
/** The widest tilt, in degrees, either way. */
export const MAX_TILT = 2;

export interface NoteLook {
	fastener: NoteFastener;
	/** Small horizontal drift inside the slot, in px. */
	jitterX: number;
	/** Small vertical drift inside the slot, in px. */
	jitterY: number;
	kind: NoteKind;
	/** Natural tilt in degrees, within ±{@link MAX_TILT}. */
	rotation: number;
	/** Extra twist on the tape strips, in degrees. */
	tapeAngle: number;
}

/**
 * 32-bit FNV-1a with a final avalanche, so ids that differ only in their last
 * characters still land far apart: small, fast, and stable across runtimes.
 */
export function noticeboardHash(value: string): number {
	let hash = 0x81_1c_9d_c5;
	for (const char of value) {
		hash ^= char.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 0x01_00_01_93);
	}
	hash ^= hash >>> 16;
	hash = Math.imul(hash, 0x85_eb_ca_6b);
	hash ^= hash >>> 13;
	hash = Math.imul(hash, 0xc2_b2_ae_35);
	hash ^= hash >>> 16;
	return hash >>> 0;
}

/** A value in [0, 1) drawn from a thread id and a salt. */
function unit(id: string, salt: string): number {
	return noticeboardHash(`${salt}:${id}`) / 0x1_00_00_00_00;
}

/** Round to a quarter so tilts read as deliberate, not noisy. */
function quarter(value: number): number {
	return Math.round(value * 4) / 4;
}

const KINDS: readonly NoteKind[] = ["note", "card", "note", "memo"];

/**
 * How a thread is pinned up: a sticky note, an index card or a typed memo.
 * About half the index cards are taped at two corners; everything else
 * takes a push pin. Every kind reads the same with or without an agent.
 */
export function noteLook(threadId: string): NoteLook {
	const picked =
		KINDS[Math.floor(unit(threadId, "kind") * KINDS.length)] ?? "note";
	const kind: NoteKind = picked;
	let rotation = quarter((unit(threadId, "tilt") * 2 - 1) * MAX_TILT);
	// A perfectly level paper looks placed by a machine; nudge it.
	if (rotation === 0) {
		rotation = unit(threadId, "side") < 0.5 ? -0.5 : 0.5;
	}
	return {
		fastener:
			kind === "card" && unit(threadId, "tape-on") < 0.5 ? "tape" : "pin",
		jitterX: Math.round((unit(threadId, "x") * 2 - 1) * 6),
		jitterY: Math.round((unit(threadId, "y") * 2 - 1) * 4),
		kind,
		rotation,
		tapeAngle: quarter((unit(threadId, "tape") * 2 - 1) * 4),
	};
}

export interface NoticeboardNote {
	agents: InterfaceAgent[];
	look: NoteLook;
	size: NoteSize;
	status: ThreadStatus;
	thread: InterfaceThread;
}

export interface NoticeboardArea {
	label: string;
	notes: NoticeboardNote[];
	status: ThreadStatus;
}

function pinnedThenRecent(a: InterfaceThread, b: InterfaceThread): number {
	return (
		Number(b.pinned) - Number(a.pinned) ||
		b.updatedAt.localeCompare(a.updatedAt) ||
		a.id.localeCompare(b.id)
	);
}

export function noticeboardNote(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread
): NoticeboardNote {
	const agents: InterfaceAgent[] = [];
	for (const agentId of thread.agentIds) {
		const agent = snapshot.agents.find((candidate) => candidate.id === agentId);
		if (agent) {
			agents.push(agent);
		}
	}
	const look = noteLook(thread.id);
	return {
		agents,
		look,
		size: NOTE_SIZES[look.kind],
		status: threadStatus(thread),
		thread,
	};
}

/**
 * Conversations grouped into the board's areas, most urgent first. Inside an
 * area, pinned threads lead and the rest follow by latest activity. Empty
 * areas are left off the board.
 */
export function noticeboardAreas(
	snapshot: InterfaceSnapshot
): NoticeboardArea[] {
	const byStatus = new Map<ThreadStatus, NoticeboardNote[]>();
	for (const thread of [...snapshot.threads].sort(pinnedThenRecent)) {
		const note = noticeboardNote(snapshot, thread);
		const list = byStatus.get(note.status) ?? [];
		list.push(note);
		byStatus.set(note.status, list);
	}
	const areas: NoticeboardArea[] = [];
	for (const status of THREAD_STATUS_ORDER) {
		const notes = byStatus.get(status);
		if (notes && notes.length > 0) {
			areas.push({ label: THREAD_STATUS_LABELS[status], notes, status });
		}
	}
	return areas;
}

export interface NotePoint {
	x: number;
	y: number;
}

export type NotePositions = Record<string, NotePoint>;

export interface PlacedNote {
	note: NoticeboardNote;
	/** True when the viewer dragged it here, false for the tidy layout. */
	placed: boolean;
	x: number;
	y: number;
}

export interface PlacedArea {
	count: number;
	label: string;
	status: ThreadStatus;
	width: number;
	x: number;
	y: number;
}

export interface NoticeboardLayout {
	areas: PlacedArea[];
	height: number;
	notes: PlacedNote[];
	width: number;
}

interface AreaBlock {
	area: NoticeboardArea;
	/** Notes in reading order, each given a tidy slot. */
	loose: NoticeboardNote[];
}

/** The board grid: how many slots fit across the inner width. */
export function noticeboardColumns(innerWidth: number): number {
	return Math.max(
		1,
		Math.floor((innerWidth + COLUMN_GAP) / (CELL_WIDTH + COLUMN_GAP))
	);
}

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

/** Where the viewer's arrangement lives (per browser profile). */
export const NOTICEBOARD_POSITIONS_KEY = "ryu:noticeboard-positions";
/** Notes may not be pushed past this, so a stray value cannot grow the board forever. */
export const MAX_COORDINATE = 20_000;

function clampCoordinate(value: number): number {
	return Math.min(MAX_COORDINATE, Math.max(0, Math.round(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Accepts only `{ [threadId]: { x, y } }` with finite numbers; drops the rest. */
export function parseNotePositions(raw: unknown): NotePositions {
	if (!isRecord(raw)) {
		return {};
	}
	const positions: NotePositions = {};
	for (const [threadId, value] of Object.entries(raw)) {
		if (!(threadId && isRecord(value))) {
			continue;
		}
		const { x, y } = value;
		if (
			typeof x === "number" &&
			typeof y === "number" &&
			Number.isFinite(x) &&
			Number.isFinite(y)
		) {
			positions[threadId] = { x: clampCoordinate(x), y: clampCoordinate(y) };
		}
	}
	return positions;
}

/** Storage can be missing or blocked (private windows); never throw. */
export function readNotePositions(): NotePositions {
	try {
		const raw = globalThis.localStorage?.getItem(NOTICEBOARD_POSITIONS_KEY);
		return raw ? parseNotePositions(JSON.parse(raw)) : {};
	} catch {
		return {};
	}
}

export function writeNotePositions(positions: NotePositions): void {
	try {
		if (Object.keys(positions).length === 0) {
			globalThis.localStorage?.removeItem(NOTICEBOARD_POSITIONS_KEY);
			return;
		}
		globalThis.localStorage?.setItem(
			NOTICEBOARD_POSITIONS_KEY,
			JSON.stringify(positions)
		);
	} catch {
		// Storage is a convenience: the board still works without it.
	}
}

/** A moved note, snapped to the board and kept on it. */
export function moveNote(
	positions: NotePositions,
	threadId: string,
	point: NotePoint
): NotePositions {
	return {
		...positions,
		[threadId]: { x: clampCoordinate(point.x), y: clampCoordinate(point.y) },
	};
}

/** Positions for threads that still exist, so old ids do not pile up. */
export function prunePositions(
	positions: NotePositions,
	threadIds: ReadonlySet<string>
): NotePositions {
	const kept: NotePositions = {};
	let changed = false;
	for (const [threadId, point] of Object.entries(positions)) {
		if (threadIds.has(threadId)) {
			kept[threadId] = point;
		} else {
			changed = true;
		}
	}
	return changed ? kept : positions;
}

/** Who a note is from, in words. */
export function noteByline(note: NoticeboardNote): string {
	const [lead, ...rest] = note.agents;
	if (!lead) {
		return "No agent";
	}
	if (rest.length === 0) {
		return lead.name;
	}
	return `${lead.name} +${rest.length}`;
}

/** "5m ago", "Just now", or empty for an unreadable time. */
export function spokenAge(compact: string): string {
	if (!compact) {
		return "";
	}
	return compact === "now" ? "just now" : `${compact} ago`;
}

/** The note's accessible name: what it is, where it stands, who, and when. */
export function noteAccessibleName(
	note: NoticeboardNote,
	compactAgeText: string
): string {
	const parts = [
		note.thread.title || "Untitled conversation",
		THREAD_STATUS_LABELS[note.status],
	];
	const names = note.agents.map((agent) => agent.name);
	parts.push(names.length > 0 ? names.join(", ") : "No agent");
	const age = spokenAge(compactAgeText);
	if (age) {
		parts.push(`updated ${age}`);
	}
	if (note.thread.pinned) {
		parts.push("pinned");
	}
	return parts.join(". ");
}

export interface NoticeboardSummary {
	attention: number;
	total: number;
	working: number;
	yourTurn: number;
}

export function noticeboardSummary(
	snapshot: InterfaceSnapshot
): NoticeboardSummary {
	const summary: NoticeboardSummary = {
		attention: 0,
		total: snapshot.threads.length,
		working: 0,
		yourTurn: 0,
	};
	for (const thread of snapshot.threads) {
		const status = threadStatus(thread);
		if (status === "attention") {
			summary.attention += 1;
		} else if (status === "working") {
			summary.working += 1;
		} else if (status === "your-turn") {
			summary.yourTurn += 1;
		}
	}
	return summary;
}

/** The header's one-line count, in the user's terms. */
export function summaryText(summary: NoticeboardSummary): string {
	const parts = [`${summary.total} ${summary.total === 1 ? "note" : "notes"}`];
	if (summary.attention > 0) {
		parts.push(`${summary.attention} need attention`);
	}
	if (summary.yourTurn > 0) {
		parts.push(`${summary.yourTurn} your turn`);
	}
	if (summary.working > 0) {
		parts.push(`${summary.working} working`);
	}
	return parts.join(" · ");
}

/** Keyboard nudge distance: a small step, or a large one with Shift. */
export const NUDGE_STEP = 8;
export const NUDGE_STEP_LARGE = 48;

const NUDGE_DIRECTIONS: Record<string, NotePoint> = {
	ArrowDown: { x: 0, y: 1 },
	ArrowLeft: { x: -1, y: 0 },
	ArrowRight: { x: 1, y: 0 },
	ArrowUp: { x: 0, y: -1 },
};

/** The point an arrow key moves a note to, or null for any other key. */
export function nudgedPoint(
	from: NotePoint,
	key: string,
	large: boolean
): NotePoint | null {
	const direction = NUDGE_DIRECTIONS[key];
	if (!direction) {
		return null;
	}
	const step = large ? NUDGE_STEP_LARGE : NUDGE_STEP;
	return {
		x: clampCoordinate(from.x + direction.x * step),
		y: clampCoordinate(from.y + direction.y * step),
	};
}
