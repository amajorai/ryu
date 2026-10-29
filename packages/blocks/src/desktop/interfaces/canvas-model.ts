import {
	type CanvasParams,
	type InterfaceAgent,
	type InterfaceGroup,
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	THREAD_STATUS_ORDER,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

/**
 * Pure view-model for the Canvas interface: where each sticky and frame sits
 * in world space, the camera math (world <-> screen, zoom about a point, fit),
 * and the per-viewer position overrides kept in browser storage. Nothing here
 * touches React or the DOM, so it is unit-tested directly.
 */

export type CanvasArrange = CanvasParams["arrange"];

export interface CanvasPoint {
	x: number;
	y: number;
}

export interface CanvasRect {
	height: number;
	width: number;
	x: number;
	y: number;
}

/** Screen = world * zoom + (x, y). */
export interface CanvasCamera {
	x: number;
	y: number;
	zoom: number;
}

export interface CanvasViewport {
	height: number;
	width: number;
}

export interface CanvasCardModel {
	agents: InterfaceAgent[];
	/** Frame the card is filed under for the current arrangement. */
	frameId: string;
	/** The project or team the thread is filed under, when it has one. */
	group: InterfaceGroup | undefined;
	/** Default (un-dragged) top-left corner in world space. */
	home: CanvasPoint;
	id: string;
	lead: InterfaceAgent | undefined;
	status: ThreadStatus;
	thread: InterfaceThread;
}

export interface CanvasFrameModel {
	/** Set for agent frames. */
	agent: InterfaceAgent | undefined;
	/**
	 * The frame's full home area (every thread slotted), which decides whether a
	 * moved sticky still counts as filed inside it. Packing uses it too, so a
	 * sticky leaving its frame never shifts the frames around it.
	 */
	claim: CanvasRect;
	id: string;
	label: string;
	/** The frame as drawn: just big enough for the stickies still slotted in it. */
	rect: CanvasRect;
	/** Set for status frames. */
	status: ThreadStatus | undefined;
	threadIds: string[];
}

export interface CanvasLayout {
	/** Union of every frame, the area "Zoom to fit" frames. */
	bounds: CanvasRect;
	cards: CanvasCardModel[];
	frames: CanvasFrameModel[];
	/** Stickies the viewer moved out of their frame: they hold no slot. */
	loose: Set<string>;
}

export const CARD_WIDTH = 264;
export const CARD_HEIGHT = 176;
export const CARD_GAP = 16;
/** The gutter between a frame's edge and its stickies, the same on all four sides. */
export const FRAME_PADDING = 16;
/**
 * The frame's label sits above its box, as tldraw draws it: a band this tall
 * (world units) at the top of the frame rect, outside the drawn box.
 */
export const FRAME_LABEL = 28;
/** Label band plus the top gutter: where a frame's first row of stickies starts. */
export const FRAME_HEADER = FRAME_LABEL + FRAME_PADDING;
export const FRAME_GAP = 56;
/**
 * Between rows of frames the next row's label band sits inside the gap, so
 * frame body to frame body is FRAME_GAP down the board as well as across it.
 */
export const FRAME_ROW_GAP = FRAME_GAP - FRAME_LABEL;
/** A frame never grows closer than this to its neighbour; the sticky lifts out instead. */
export const FRAME_MIN_GAP = 12;
export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 3;
/** Stops the +/- buttons walk through, like tldraw's zoom menu. */
export const ZOOM_STEPS = [
	0.2, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3,
] as const;
export const NUDGE = 8;
export const NUDGE_LARGE = 40;
export const UNASSIGNED_FRAME_ID = "agent:none";
/**
 * Below this zoom a sticky shows its compact face (status, big title, who it
 * is with). It is also the floor for the full face: its 11px meta never draws
 * smaller than about 10px on screen.
 */
export const COMPACT_ZOOM = 0.9;

const EMPTY_RECT: CanvasRect = { height: 0, width: 0, x: 0, y: 0 };

function pinnedThenRecent(a: InterfaceThread, b: InterfaceThread): number {
	return (
		Number(b.pinned) - Number(a.pinned) ||
		b.updatedAt.localeCompare(a.updatedAt) ||
		a.id.localeCompare(b.id)
	);
}

/** Squarish frames: one column for a single card, then ceil(sqrt(n)), up to four. */
export function frameColumns(count: number): number {
	if (count <= 1) {
		return 1;
	}
	return Math.min(4, Math.ceil(Math.sqrt(count)));
}

function frameWidth(columns: number): number {
	return FRAME_PADDING * 2 + columns * CARD_WIDTH + (columns - 1) * CARD_GAP;
}

function frameHeight(rows: number): number {
	return (
		FRAME_HEADER + rows * CARD_HEIGHT + (rows - 1) * CARD_GAP + FRAME_PADDING
	);
}

function frameSize(
	count: number,
	columns: number
): { height: number; width: number } {
	const used = Math.max(1, Math.min(columns, count));
	return {
		height: frameHeight(Math.max(1, Math.ceil(count / used))),
		width: frameWidth(used),
	};
}

interface FrameDraft {
	agent: InterfaceAgent | undefined;
	id: string;
	label: string;
	status: ThreadStatus | undefined;
	threads: InterfaceThread[];
}

interface FramePlan {
	columns: number;
	/** Keep the planned size even with fewer slotted stickies (the agent grid). */
	fixed: boolean;
	rect: CanvasRect;
}

function statusFrames(threads: InterfaceThread[]): FrameDraft[] {
	return THREAD_STATUS_ORDER.map((status) => ({
		agent: undefined,
		id: `status:${status}`,
		label: THREAD_STATUS_LABELS[status],
		status,
		threads: threads.filter((thread) => threadStatus(thread) === status),
	}));
}

function agentFrames(
	snapshot: InterfaceSnapshot,
	threads: InterfaceThread[]
): FrameDraft[] {
	const known = new Set(snapshot.agents.map((agent) => agent.id));
	const drafts: FrameDraft[] = snapshot.agents.map((agent) => ({
		agent,
		id: `agent:${agent.id}`,
		label: agent.name,
		status: undefined,
		threads: threads.filter((thread) => thread.agentIds[0] === agent.id),
	}));
	drafts.push({
		agent: undefined,
		id: UNASSIGNED_FRAME_ID,
		label: "No agent",
		status: undefined,
		threads: threads.filter((thread) => {
			const lead = thread.agentIds[0];
			return !(lead && known.has(lead));
		}),
	});
	return drafts;
}

/**
 * Status frames: shelf-pack left to right into rows about as wide as a 16:10
 * sheet of the same area, so "Zoom to fit" lands near 100% instead of a strip.
 */
function shelfPlans(drafts: FrameDraft[], portrait: boolean): FramePlan[] {
	// A phone gets one column of frames, each at most two stickies wide.
	const columns = drafts.map((draft) =>
		Math.min(portrait ? 2 : 4, frameColumns(draft.threads.length))
	);
	const sizes = drafts.map((draft, index) =>
		frameSize(draft.threads.length, columns[index] ?? 1)
	);
	const area = sizes.reduce((sum, size) => sum + size.width * size.height, 0);
	const widest = Math.max(0, ...sizes.map((size) => size.width));
	const rowLimit = portrait
		? widest
		: Math.max(widest, Math.sqrt(area * 1.8) * 1.15);
	const plans: FramePlan[] = [];
	let cursorX = 0;
	let cursorY = 0;
	let rowHeight = 0;
	for (const [index, size] of sizes.entries()) {
		if (cursorX > 0 && cursorX + size.width > rowLimit) {
			cursorX = 0;
			cursorY += rowHeight + FRAME_ROW_GAP;
			rowHeight = 0;
		}
		plans.push({
			columns: columns[index] ?? 1,
			fixed: false,
			rect: { ...size, x: cursorX, y: cursorY },
		});
		cursorX += size.width + FRAME_GAP;
		rowHeight = Math.max(rowHeight, size.height);
	}
	return plans;
}

/** Card columns every agent frame shares: one lane, wider only for busy agents. */
export function agentFrameColumns(counts: readonly number[]): number {
	const most = Math.max(1, ...counts);
	return most <= 4 ? 1 : Math.min(3, Math.ceil(most / 4));
}

function chunk<T>(items: readonly T[], size: number): T[][] {
	const rows: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		rows.push(items.slice(index, index + size));
	}
	return rows;
}

/**
 * Agent frames: sections on one grid. Every frame is the same width, so the
 * columns line up, and each is only as tall as its own stickies (tldraw and
 * FigJam never stretch a frame to its neighbour); the frames-per-row count is
 * the one closest to a 16:10 sheet.
 */
function gridPlans(drafts: FrameDraft[], portrait: boolean): FramePlan[] {
	const aspect = portrait ? 0.45 : 1.6;
	const columns = agentFrameColumns(
		drafts.map((draft) => draft.threads.length)
	);
	const width = frameWidth(columns);
	const heights = drafts.map(
		(draft) => frameSize(draft.threads.length, columns).height
	);
	let bestPerRow = Math.max(1, drafts.length);
	let bestScore = Number.POSITIVE_INFINITY;
	for (let perRow = 1; perRow <= drafts.length; perRow += 1) {
		const rows = chunk(heights, perRow);
		const height =
			rows.reduce((sum, row) => sum + Math.max(...row), 0) +
			(rows.length - 1) * FRAME_ROW_GAP;
		const total = perRow * width + (perRow - 1) * FRAME_GAP;
		const score = Math.abs(Math.log(total / height / aspect));
		if (score < bestScore - 0.001) {
			bestScore = score;
			bestPerRow = perRow;
		}
	}
	const plans: FramePlan[] = [];
	let cursorY = 0;
	for (const row of chunk(heights, bestPerRow)) {
		const rowHeight = Math.max(...row);
		for (const [column, height] of row.entries()) {
			plans.push({
				columns,
				fixed: true,
				rect: {
					height,
					width,
					x: column * (width + FRAME_GAP),
					y: cursorY,
				},
			});
		}
		cursorY += rowHeight + FRAME_ROW_GAP;
	}
	return plans;
}

/** Union of rectangles (an empty rect for none). */
export function unionRects(rects: readonly CanvasRect[]): CanvasRect {
	const [first, ...rest] = rects;
	if (!first) {
		return EMPTY_RECT;
	}
	let left = first.x;
	let top = first.y;
	let right = first.x + first.width;
	let bottom = first.y + first.height;
	for (const rect of rest) {
		left = Math.min(left, rect.x);
		top = Math.min(top, rect.y);
		right = Math.max(right, rect.x + rect.width);
		bottom = Math.max(bottom, rect.y + rect.height);
	}
	return { height: bottom - top, width: right - left, x: left, y: top };
}

export function rectsOverlap(a: CanvasRect, b: CanvasRect): boolean {
	return (
		a.x < b.x + b.width &&
		b.x < a.x + a.width &&
		a.y < b.y + b.height &&
		b.y < a.y + a.height
	);
}

export function inflateRect(rect: CanvasRect, by: number): CanvasRect {
	return {
		height: rect.height + by * 2,
		width: rect.width + by * 2,
		x: rect.x - by,
		y: rect.y - by,
	};
}

function containsPoint(rect: CanvasRect, point: CanvasPoint): boolean {
	return (
		point.x >= rect.x &&
		point.x <= rect.x + rect.width &&
		point.y >= rect.y &&
		point.y <= rect.y + rect.height
	);
}

function cardCenter(point: CanvasPoint): CanvasPoint {
	return { x: point.x + CARD_WIDTH / 2, y: point.y + CARD_HEIGHT / 2 };
}

export function cardRect(point: CanvasPoint): CanvasRect {
	return { height: CARD_HEIGHT, width: CARD_WIDTH, x: point.x, y: point.y };
}

/**
 * FigJam's section rule, with a gutter: a moved sticky stays filed in its
 * frame while its centre is inside the frame's home area and the frame,
 * grown to hold it, keeps FRAME_MIN_GAP clear of every other frame.
 */
function isFiled(
	point: CanvasPoint,
	claim: CanvasRect,
	others: readonly CanvasRect[]
): boolean {
	if (!containsPoint(claim, cardCenter(point))) {
		return false;
	}
	const reach = inflateRect(cardRect(point), FRAME_PADDING + FRAME_MIN_GAP);
	return !others.some((other) => rectsOverlap(reach, other));
}

function slotPoint(
	origin: CanvasPoint,
	columns: number,
	slot: number
): CanvasPoint {
	return {
		x: origin.x + FRAME_PADDING + (slot % columns) * (CARD_WIDTH + CARD_GAP),
		y:
			origin.y +
			FRAME_HEADER +
			Math.floor(slot / columns) * (CARD_HEIGHT + CARD_GAP),
	};
}

/**
 * Hand out a frame's slots with no gaps: a moved sticky still filed here keeps
 * the slot nearest where it sits, and the rest fill the free slots in order.
 */
function assignSlots(
	threads: readonly InterfaceThread[],
	origin: CanvasPoint,
	columns: number,
	overrides: Readonly<Record<string, CanvasPoint>>
): Map<string, number> {
	const slots = new Map<string, number>();
	const taken = new Set<number>();
	for (const thread of threads) {
		const point = overrides[thread.id];
		if (!point) {
			continue;
		}
		let best = -1;
		let bestDistance = Number.POSITIVE_INFINITY;
		for (let slot = 0; slot < threads.length; slot += 1) {
			if (taken.has(slot)) {
				continue;
			}
			const home = slotPoint(origin, columns, slot);
			const distance = Math.hypot(home.x - point.x, home.y - point.y);
			if (distance < bestDistance) {
				bestDistance = distance;
				best = slot;
			}
		}
		slots.set(thread.id, best);
		taken.add(best);
	}
	let next = 0;
	for (const thread of threads) {
		if (slots.has(thread.id)) {
			continue;
		}
		while (taken.has(next)) {
			next += 1;
		}
		slots.set(thread.id, next);
		taken.add(next);
	}
	return slots;
}

/**
 * Frames (empty ones dropped) and each card's home slot for an arrangement.
 * Stickies the viewer moved out of their frame (`overrides`) take no slot, so
 * the stickies left behind pack with no holes. `portrait` (a phone) stacks
 * the frames in one scrolling column instead of a 16:10 sheet.
 */
export function buildCanvasLayout(
	snapshot: InterfaceSnapshot,
	arrange: CanvasArrange,
	overrides: Readonly<Record<string, CanvasPoint>> = {},
	{ portrait = false }: { portrait?: boolean } = {}
): CanvasLayout {
	const threads = [...snapshot.threads].sort(pinnedThenRecent);
	const drafts = (
		arrange === "agent" ? agentFrames(snapshot, threads) : statusFrames(threads)
	).filter((draft) => draft.threads.length > 0);
	const plans =
		arrange === "agent"
			? gridPlans(drafts, portrait)
			: shelfPlans(drafts, portrait);
	const claims = plans.map((plan) => plan.rect);
	const agentsById = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
	const groupsById = new Map(snapshot.groups.map((group) => [group.id, group]));
	const frames: CanvasFrameModel[] = [];
	const cards: CanvasCardModel[] = [];
	const loose = new Set<string>();
	for (const [index, draft] of drafts.entries()) {
		const plan = plans[index];
		if (!plan) {
			continue;
		}
		const others = claims.filter((_claim, other) => other !== index);
		const slotted = draft.threads.filter((thread) => {
			const point = overrides[thread.id];
			if (point && !isFiled(point, plan.rect, others)) {
				loose.add(thread.id);
				return false;
			}
			return true;
		});
		const columns = Math.max(1, Math.min(plan.columns, slotted.length));
		const size = plan.fixed
			? { height: plan.rect.height, width: plan.rect.width }
			: frameSize(slotted.length, columns);
		const slots = assignSlots(slotted, plan.rect, columns, overrides);
		frames.push({
			agent: draft.agent,
			claim: plan.rect,
			id: draft.id,
			label: draft.label,
			rect: { ...size, x: plan.rect.x, y: plan.rect.y },
			status: draft.status,
			threadIds: draft.threads.map((thread) => thread.id),
		});
		for (const thread of draft.threads) {
			const slot = slots.get(thread.id);
			const agents = thread.agentIds
				.map((id) => agentsById.get(id))
				.filter((agent): agent is InterfaceAgent => agent !== undefined);
			cards.push({
				agents,
				frameId: draft.id,
				group: groupsById.get(thread.projectId ?? thread.teamId ?? ""),
				home:
					slot === undefined
						? (overrides[thread.id] ?? { x: plan.rect.x, y: plan.rect.y })
						: slotPoint(plan.rect, columns, slot),
				id: thread.id,
				lead: agentsById.get(thread.agentIds[0] ?? ""),
				status: threadStatus(thread),
				thread,
			});
		}
	}
	return {
		bounds: unionRects(frames.map((frame) => frame.rect)),
		cards,
		frames,
		loose,
	};
}

/** Where a card is now: the viewer's override, else its home slot. */
export function cardPosition(
	card: CanvasCardModel,
	overrides: Readonly<Record<string, CanvasPoint>>
): CanvasPoint {
	return overrides[card.id] ?? card.home;
}

export interface CanvasFrameFit {
	/** Cards dragged out of their frame: drawn lifted, no longer inside it. */
	loose: Set<string>;
	/** Each frame's rect, grown to keep the stickies still filed inside it. */
	rects: Map<string, CanvasRect>;
}

/**
 * FigJam's section behaviour: a sticky still filed in its frame (see
 * `isFiled`) grows the frame to hold it; one dragged out is un-parented and
 * floats above the board instead of straddling the frame's border.
 */
export function fitFrames(
	layout: CanvasLayout,
	overrides: Readonly<Record<string, CanvasPoint>>
): CanvasFrameFit {
	const framesById = new Map(layout.frames.map((frame) => [frame.id, frame]));
	const members = new Map<string, CanvasRect[]>();
	const loose = new Set<string>();
	for (const card of layout.cards) {
		const frame = framesById.get(card.frameId);
		const point = overrides[card.id];
		if (!(frame && point)) {
			continue;
		}
		const others = layout.frames
			.filter((other) => other.id !== frame.id)
			.map((other) => other.claim);
		if (isFiled(point, frame.claim, others)) {
			const padded = inflateRect(cardRect(point), FRAME_PADDING);
			members.set(frame.id, [...(members.get(frame.id) ?? []), padded]);
		} else {
			loose.add(card.id);
		}
	}
	const rects = new Map<string, CanvasRect>();
	for (const frame of layout.frames) {
		const grown = members.get(frame.id);
		rects.set(
			frame.id,
			grown ? unionRects([frame.rect, ...grown]) : frame.rect
		);
	}
	return { loose, rects };
}

/** Everything on the canvas right now: frames plus cards wherever they sit. */
export function contentBounds(
	layout: CanvasLayout,
	overrides: Readonly<Record<string, CanvasPoint>>
): CanvasRect {
	const { rects } = fitFrames(layout, overrides);
	return unionRects([
		...rects.values(),
		...layout.cards.map((card) => cardRect(cardPosition(card, overrides))),
	]);
}

/**
 * The nearest top-left (searching outward from `desired` in `step` rings) where
 * a `size` rect fits inside `within` (when given) and stays `gap` clear of
 * every obstacle; undefined when nothing within `radius` is free.
 */
export function findFreeSpot(
	desired: CanvasPoint,
	size: { height: number; width: number },
	obstacles: readonly CanvasRect[],
	{
		gap = 24,
		radius = 1200,
		step = 24,
		within,
	}: {
		gap?: number;
		radius?: number;
		step?: number;
		within?: CanvasRect;
	} = {}
): CanvasPoint | undefined {
	const blocked = obstacles.map((rect) => inflateRect(rect, gap));
	const fits = (point: CanvasPoint) => {
		const rect = { ...size, ...point };
		if (
			within &&
			(rect.x < within.x ||
				rect.y < within.y ||
				rect.x + rect.width > within.x + within.width ||
				rect.y + rect.height > within.y + within.height)
		) {
			return false;
		}
		return !blocked.some((other) => rectsOverlap(rect, other));
	};
	const rings = Math.ceil(radius / step);
	for (let ring = 0; ring <= rings; ring += 1) {
		let best: CanvasPoint | undefined;
		let bestDistance = Number.POSITIVE_INFINITY;
		for (let dx = -ring; dx <= ring; dx += 1) {
			for (let dy = -ring; dy <= ring; dy += 1) {
				if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) {
					continue;
				}
				const point = { x: desired.x + dx * step, y: desired.y + dy * step };
				const distance = Math.hypot(dx, dy);
				if (distance < bestDistance && fits(point)) {
					best = point;
					bestDistance = distance;
				}
			}
		}
		if (best) {
			return best;
		}
	}
	return undefined;
}

/**
 * Where a sticky started from the keyboard or the dock lands: the free spot
 * nearest the view's centre that is clear of every frame and sticky. When the
 * view has no such room it goes to the empty canvas right of the board, which
 * the camera then pans just far enough to show, so the new sticky never lands
 * on top of existing content.
 */
export function placeClearSticky(
	centre: CanvasPoint,
	obstacles: readonly CanvasRect[],
	within: CanvasRect,
	content: CanvasRect,
	zoom: number
): CanvasPoint {
	const clearance = 24 / zoom;
	const step = Math.max(8, 16 / zoom);
	const radius = Math.max(within.width, within.height);
	const size = { height: CARD_HEIGHT, width: CARD_WIDTH };
	const spot = findFreeSpot(
		{ x: centre.x - CARD_WIDTH / 2, y: centre.y - CARD_HEIGHT / 2 },
		size,
		obstacles,
		{ gap: clearance, radius, step, within }
	);
	if (spot) {
		return { x: Math.round(spot.x), y: Math.round(spot.y) };
	}
	const start = {
		x: content.x + content.width + FRAME_GAP,
		y: Math.min(
			Math.max(content.y, centre.y - CARD_HEIGHT / 2),
			content.y + content.height - CARD_HEIGHT
		),
	};
	const outside =
		findFreeSpot(start, size, obstacles, {
			gap: FRAME_GAP,
			radius: 1200,
			step: 24,
		}) ?? start;
	return { x: Math.round(outside.x), y: Math.round(outside.y) };
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

export function clampZoom(zoom: number): number {
	if (!Number.isFinite(zoom)) {
		return 1;
	}
	return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function screenToWorld(
	camera: CanvasCamera,
	point: CanvasPoint
): CanvasPoint {
	return {
		x: (point.x - camera.x) / camera.zoom,
		y: (point.y - camera.y) / camera.zoom,
	};
}

export function worldToScreen(
	camera: CanvasCamera,
	point: CanvasPoint
): CanvasPoint {
	return {
		x: point.x * camera.zoom + camera.x,
		y: point.y * camera.zoom + camera.y,
	};
}

/** Zoom to `zoom` keeping the world point under `anchor` (screen) still. */
export function zoomAt(
	camera: CanvasCamera,
	anchor: CanvasPoint,
	zoom: number
): CanvasCamera {
	const next = clampZoom(zoom);
	const ratio = next / camera.zoom;
	return {
		x: anchor.x - (anchor.x - camera.x) * ratio,
		y: anchor.y - (anchor.y - camera.y) * ratio,
		zoom: next,
	};
}

/** The next stop up (direction 1) or down (-1) from the current zoom. */
export function stepZoom(zoom: number, direction: -1 | 1): number {
	const epsilon = 0.001;
	if (direction > 0) {
		return ZOOM_STEPS.find((step) => step > zoom + epsilon) ?? MAX_ZOOM;
	}
	return (
		[...ZOOM_STEPS].reverse().find((step) => step < zoom - epsilon) ?? MIN_ZOOM
	);
}

/** Frame `rect` inside the viewport with a screen-space margin, never above `maxZoom`. */
export function fitCamera(
	rect: CanvasRect,
	viewport: CanvasViewport,
	{ margin = 64, maxZoom = 1 }: { margin?: number; maxZoom?: number } = {}
): CanvasCamera {
	if (rect.width <= 0 || rect.height <= 0) {
		return { x: viewport.width / 2, y: viewport.height / 2, zoom: 1 };
	}
	const availableWidth = Math.max(1, viewport.width - margin * 2);
	const availableHeight = Math.max(1, viewport.height - margin * 2);
	const zoom = clampZoom(
		Math.min(
			maxZoom,
			availableWidth / rect.width,
			availableHeight / rect.height
		)
	);
	return {
		x: viewport.width / 2 - (rect.x + rect.width / 2) * zoom,
		y: viewport.height / 2 - (rect.y + rect.height / 2) * zoom,
		zoom,
	};
}

/**
 * Fit `rect` into the part of the viewport the floating chrome leaves clear
 * (`insets` in screen pixels), never above `maxZoom`.
 */
export function fitCameraInsets(
	rect: CanvasRect,
	viewport: CanvasViewport,
	insets: CanvasInsets,
	{ margin = 16, maxZoom = 1 }: { margin?: number; maxZoom?: number } = {}
): CanvasCamera {
	const inner = {
		height: Math.max(1, viewport.height - insets.top - insets.bottom),
		width: Math.max(1, viewport.width - insets.left - insets.right),
	};
	const fitted = fitCamera(rect, inner, { margin, maxZoom });
	return {
		x: fitted.x + insets.left,
		y: fitted.y + insets.top,
		zoom: fitted.zoom,
	};
}

export interface CanvasInsets {
	bottom: number;
	left: number;
	right: number;
	top: number;
}

/**
 * Chrome that floats over one corner (the minimap), in screen pixels, and the
 * world rects that must stay clear of it (the stickies).
 */
export interface CanvasClearance {
	/** Right inset that keeps the whole board clear of the obstacles. */
	blockedRight: number;
	obstacles: readonly CanvasRect[];
	pieces: readonly CanvasRect[];
}

function screenRect(camera: CanvasCamera, rect: CanvasRect): CanvasRect {
	const topLeft = worldToScreen(camera, rect);
	return {
		height: rect.height * camera.zoom,
		width: rect.width * camera.zoom,
		x: topLeft.x,
		y: topLeft.y,
	};
}

/**
 * Fit `rect` centred in the viewport, keeping corner chrome clear only when it
 * would actually cover a sticky: first by the smallest shift left or up that
 * clears it, else by reserving the chrome's whole column.
 */
export function fitCameraClear(
	rect: CanvasRect,
	viewport: CanvasViewport,
	insets: CanvasInsets,
	clearance: CanvasClearance | undefined,
	{ margin = 16, maxZoom = 1 }: { margin?: number; maxZoom?: number } = {}
): CanvasCamera {
	const centred = fitCameraInsets(rect, viewport, insets, {
		margin,
		maxZoom,
	});
	if (!clearance || clearance.obstacles.length === 0) {
		return centred;
	}
	const covered = (camera: CanvasCamera) =>
		clearance.pieces.some((piece) => {
			const onScreen = inflateRect(screenRect(camera, piece), 8);
			return clearance.obstacles.some((obstacle) =>
				rectsOverlap(onScreen, obstacle)
			);
		});
	if (!covered(centred)) {
		return centred;
	}
	const board = screenRect(centred, rect);
	let shiftLeft = 0;
	let shiftUp = 0;
	for (const piece of clearance.pieces) {
		const onScreen = inflateRect(screenRect(centred, piece), 8);
		for (const obstacle of clearance.obstacles) {
			if (rectsOverlap(onScreen, obstacle)) {
				shiftLeft = Math.max(
					shiftLeft,
					onScreen.x + onScreen.width - obstacle.x
				);
				shiftUp = Math.max(shiftUp, onScreen.y + onScreen.height - obstacle.y);
			}
		}
	}
	const roomLeft = board.x - insets.left - margin;
	const roomUp = board.y - insets.top - margin;
	const options = [
		shiftLeft <= roomLeft
			? { ...centred, x: centred.x - shiftLeft, cost: shiftLeft }
			: undefined,
		shiftUp <= roomUp
			? { ...centred, cost: shiftUp, y: centred.y - shiftUp }
			: undefined,
	]
		.filter((option) => option !== undefined)
		.sort((a, b) => a.cost - b.cost);
	const [cheapest] = options;
	if (cheapest) {
		return { x: cheapest.x, y: cheapest.y, zoom: cheapest.zoom };
	}
	return fitCameraInsets(
		rect,
		viewport,
		{ ...insets, right: Math.max(insets.right, clearance.blockedRight) },
		{ margin, maxZoom }
	);
}

/**
 * The opening view: fit everything when that stays readable, otherwise hold
 * `minZoom` and start from the content's top-left corner, the way a large
 * board opens in FigJam.
 */
export function openingCamera(
	rect: CanvasRect,
	viewport: CanvasViewport,
	insets: CanvasInsets,
	minZoom = 0.75,
	clearance?: CanvasClearance
): CanvasCamera {
	const fitted = fitCameraClear(rect, viewport, insets, clearance);
	if (fitted.zoom >= minZoom || rect.width <= 0) {
		return fitted;
	}
	const margin = 16;
	const inner = viewport.height - insets.top - insets.bottom - margin * 2;
	const tallFits = rect.height * minZoom <= inner;
	return {
		x: insets.left + margin - rect.x * minZoom,
		y: tallFits
			? insets.top +
				margin +
				(inner - rect.height * minZoom) / 2 -
				rect.y * minZoom
			: insets.top + margin - rect.y * minZoom,
		zoom: minZoom,
	};
}

/** Zoom floor for a docked thread, where the stickies show their compact face. */
export const FOCUS_MIN_ZOOM = 0.4;

/**
 * The view after the viewport narrows (a thread docks beside the canvas):
 * fit the whole board if that stays above `minZoom`; otherwise centre the
 * `focus` rect (the open sticky's frame) so it is whole, never above `minZoom`.
 */
export function focusCamera(
	content: CanvasRect,
	focus: CanvasRect | undefined,
	viewport: CanvasViewport,
	insets: CanvasInsets,
	minZoom = FOCUS_MIN_ZOOM,
	clearance?: CanvasClearance
): CanvasCamera {
	const all = fitCameraClear(content, viewport, insets, clearance);
	if (all.zoom >= minZoom || !focus) {
		return openingCamera(content, viewport, insets, minZoom, clearance);
	}
	return fitCameraInsets(focus, viewport, insets, { maxZoom: minZoom });
}

export type CanvasEdge = "bottom" | "left" | "right" | "top";

export interface CanvasOffscreen {
	count: number;
	/** The off-screen sticky closest to the view on that side. */
	nearest: CanvasRect | undefined;
}

/**
 * Stickies whose centre is outside the visible world rect, grouped by the side of the
 * view they are past (the axis they overshoot more), for the edge hints shown
 * when there is no minimap.
 */
export function offscreenCards(
	rects: readonly CanvasRect[],
	visible: CanvasRect
): Record<CanvasEdge, CanvasOffscreen> {
	const result: Record<CanvasEdge, CanvasOffscreen> = {
		bottom: { count: 0, nearest: undefined },
		left: { count: 0, nearest: undefined },
		right: { count: 0, nearest: undefined },
		top: { count: 0, nearest: undefined },
	};
	const distances: Record<CanvasEdge, number> = {
		bottom: Number.POSITIVE_INFINITY,
		left: Number.POSITIVE_INFINITY,
		right: Number.POSITIVE_INFINITY,
		top: Number.POSITIVE_INFINITY,
	};
	const right = visible.x + visible.width;
	const bottom = visible.y + visible.height;
	for (const rect of rects) {
		// A sticky counts as off-screen once its centre is past the edge.
		const centerX = rect.x + rect.width / 2;
		const centerY = rect.y + rect.height / 2;
		const overLeft = visible.x - centerX;
		const overRight = centerX - right;
		const overTop = visible.y - centerY;
		const overBottom = centerY - bottom;
		const horizontal = Math.max(overLeft, overRight);
		const vertical = Math.max(overTop, overBottom);
		if (horizontal <= 0 && vertical <= 0) {
			continue;
		}
		let edge: CanvasEdge;
		if (horizontal >= vertical) {
			edge = overLeft > overRight ? "left" : "right";
		} else {
			edge = overTop > overBottom ? "top" : "bottom";
		}
		const distance = Math.max(horizontal, vertical);
		result[edge].count += 1;
		if (distance < distances[edge]) {
			distances[edge] = distance;
			result[edge].nearest = rect;
		}
	}
	return result;
}

/** Whether `rect` sits wholly inside the part of the viewport the chrome leaves clear. */
export function rectInView(
	camera: CanvasCamera,
	rect: CanvasRect,
	viewport: CanvasViewport,
	insets: CanvasInsets
): boolean {
	const topLeft = worldToScreen(camera, rect);
	return (
		topLeft.x >= insets.left &&
		topLeft.y >= insets.top &&
		topLeft.x + rect.width * camera.zoom <= viewport.width - insets.right &&
		topLeft.y + rect.height * camera.zoom <= viewport.height - insets.bottom
	);
}

/** Centre the camera on a world point at the current zoom. */
export function centerOn(
	camera: CanvasCamera,
	point: CanvasPoint,
	viewport: CanvasViewport
): CanvasCamera {
	return {
		x: viewport.width / 2 - point.x * camera.zoom,
		y: viewport.height / 2 - point.y * camera.zoom,
		zoom: camera.zoom,
	};
}

/**
 * The smallest pan that brings `rect` fully into view (with a margin), or the
 * same camera when it is already visible. Zoom is untouched.
 */
export function revealRect(
	camera: CanvasCamera,
	rect: CanvasRect,
	viewport: CanvasViewport,
	margin = 48
): CanvasCamera {
	const topLeft = worldToScreen(camera, rect);
	const width = rect.width * camera.zoom;
	const height = rect.height * camera.zoom;
	const shift = (start: number, size: number, limit: number) => {
		if (size + margin * 2 > limit) {
			return (limit - size) / 2 - start;
		}
		if (start < margin) {
			return margin - start;
		}
		if (start + size > limit - margin) {
			return limit - margin - (start + size);
		}
		return 0;
	};
	const dx = shift(topLeft.x, width, viewport.width);
	const dy = shift(topLeft.y, height, viewport.height);
	if (dx === 0 && dy === 0) {
		return camera;
	}
	return { x: camera.x + dx, y: camera.y + dy, zoom: camera.zoom };
}

/**
 * A camera part-way (t in 0..1) between two others: the centre of the view
 * moves linearly while zoom moves in log space, so a fit or zoom animation
 * feels even instead of rushing at the small end.
 */
export function interpolateCamera(
	from: CanvasCamera,
	to: CanvasCamera,
	viewport: CanvasViewport,
	t: number
): CanvasCamera {
	const middle = { x: viewport.width / 2, y: viewport.height / 2 };
	const fromCenter = screenToWorld(from, middle);
	const toCenter = screenToWorld(to, middle);
	const zoom = Math.exp(
		Math.log(from.zoom) + (Math.log(to.zoom) - Math.log(from.zoom)) * t
	);
	const center = {
		x: fromCenter.x + (toCenter.x - fromCenter.x) * t,
		y: fromCenter.y + (toCenter.y - fromCenter.y) * t,
	};
	if (t >= 1) {
		return to;
	}
	return {
		x: middle.x - center.x * zoom,
		y: middle.y - center.y * zoom,
		zoom,
	};
}

/** The world rectangle the viewport currently shows. */
export function visibleWorldRect(
	camera: CanvasCamera,
	viewport: CanvasViewport
): CanvasRect {
	const topLeft = screenToWorld(camera, { x: 0, y: 0 });
	return {
		height: viewport.height / camera.zoom,
		width: viewport.width / camera.zoom,
		x: topLeft.x,
		y: topLeft.y,
	};
}

/**
 * Dot-grid spacing on screen: a 24-unit world grid that doubles while the dots
 * would crowd closer than 16px, so zooming out never turns into grey noise.
 */
export function gridSpacing(zoom: number): number {
	let spacing = 24 * zoom;
	while (spacing < 16) {
		spacing *= 2;
	}
	return spacing;
}

// ---------------------------------------------------------------------------
// Per-viewer positions
// ---------------------------------------------------------------------------

export const CANVAS_POSITIONS_KEY = "ryu:canvas-positions";

export type CanvasPositions = Record<
	CanvasArrange,
	Record<string, CanvasPoint>
>;

export function emptyPositions(): CanvasPositions {
	return { agent: {}, status: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPoint(value: unknown): CanvasPoint | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const { x, y } = value;
	if (
		typeof x === "number" &&
		typeof y === "number" &&
		Number.isFinite(x) &&
		Number.isFinite(y)
	) {
		return { x: Math.round(x), y: Math.round(y) };
	}
	return undefined;
}

function readArrangement(value: unknown): Record<string, CanvasPoint> {
	const points: Record<string, CanvasPoint> = {};
	if (!isRecord(value)) {
		return points;
	}
	for (const [id, raw] of Object.entries(value)) {
		const point = readPoint(raw);
		if (point) {
			points[id] = point;
		}
	}
	return points;
}

/** Tolerant parse: anything malformed reads as "no overrides". */
export function parsePositions(
	raw: string | null | undefined
): CanvasPositions {
	if (!raw) {
		return emptyPositions();
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return emptyPositions();
	}
	if (!isRecord(parsed)) {
		return emptyPositions();
	}
	return {
		agent: readArrangement(parsed.agent),
		status: readArrangement(parsed.status),
	};
}

/** Browser storage can be missing or throw (private mode, blocked site data). */
export function loadPositions(): CanvasPositions {
	try {
		return parsePositions(
			globalThis.localStorage?.getItem(CANVAS_POSITIONS_KEY)
		);
	} catch {
		return emptyPositions();
	}
}

export function savePositions(positions: CanvasPositions): void {
	try {
		globalThis.localStorage?.setItem(
			CANVAS_POSITIONS_KEY,
			JSON.stringify(positions)
		);
	} catch {
		// Storage is a convenience: the canvas keeps working without it.
	}
}

/** Set once the viewer has panned, zoomed or double-clicked: the gesture hint retires. */
export const CANVAS_HINT_KEY = "ryu:canvas-hint-seen";

export function loadHintSeen(): boolean {
	try {
		return globalThis.localStorage?.getItem(CANVAS_HINT_KEY) === "1";
	} catch {
		return false;
	}
}

export function saveHintSeen(): void {
	try {
		globalThis.localStorage?.setItem(CANVAS_HINT_KEY, "1");
	} catch {
		// Without storage the hint simply shows again next time.
	}
}

/** Overrides for threads the snapshot still has; unknown ids are ignored. */
export function knownOverrides(
	overrides: Readonly<Record<string, CanvasPoint>>,
	layout: CanvasLayout
): Record<string, CanvasPoint> {
	const known: Record<string, CanvasPoint> = {};
	for (const card of layout.cards) {
		const point = overrides[card.id];
		if (point) {
			known[card.id] = point;
		}
	}
	return known;
}

/** The overrides for threads the snapshot has, by thread id. */
export function overridesForThreads(
	overrides: Readonly<Record<string, CanvasPoint>>,
	threads: readonly InterfaceThread[]
): Record<string, CanvasPoint> {
	const known: Record<string, CanvasPoint> = {};
	for (const thread of threads) {
		const point = overrides[thread.id];
		if (point) {
			known[thread.id] = point;
		}
	}
	return known;
}

/** Ids from `after` that `before` did not have (newest first, by snapshot order). */
export function newThreadIds(
	before: ReadonlySet<string>,
	after: readonly InterfaceThread[]
): string[] {
	return after
		.filter((thread) => !before.has(thread.id))
		.map((thread) => thread.id);
}

export interface CanvasSummary {
	attention: number;
	threads: number;
	working: number;
}

export function canvasSummary(snapshot: InterfaceSnapshot): CanvasSummary {
	let attention = 0;
	let working = 0;
	for (const thread of snapshot.threads) {
		const status = threadStatus(thread);
		if (status === "attention") {
			attention += 1;
		} else if (status === "working") {
			working += 1;
		}
	}
	return { attention, threads: snapshot.threads.length, working };
}
