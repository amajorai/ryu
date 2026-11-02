import {
	type InterfaceAgent,
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_ORDER,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { threadStatusLabel } from "./interface-renderer.ts";

export { noticeboardLayout } from "./noticeboard-model-layout.ts";
export {
	type NoticeboardSummary,
	noteAccessibleName,
	noteByline,
	noticeboardSummary,
	spokenAge,
	summaryText,
} from "./noticeboard-model-words.ts";

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
			areas.push({ label: threadStatusLabel(status), notes, status });
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

export interface AreaBlock {
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
