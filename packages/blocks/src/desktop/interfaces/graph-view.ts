import {
	type GraphNode,
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { GRAPH_NODE_SIZE } from "./graph-model.ts";

/*
 * View-level derivations for the Graph map: what each node calls out, and
 * how the canvas frames nodes clear of its own overlays.
 */

/** The most urgent status among threads (they arrive sorted by urgency). */
export function urgentStatus(
	threads: readonly InterfaceThread[]
): ThreadStatus | null {
	const first = threads[0];
	return first ? threadStatus(first) : null;
}

/**
 * The line under an agent's name: trouble first, then live work, then a
 * count of replies owed when more than one thread waits on the user. A single
 * owed reply stays off the map (the panel lists it), so the map calls out
 * only what stands apart. `spoken` joins the node's accessible name and
 * always carries the owed replies; `text` is null when nothing is shown.
 */
export function agentSubLabel({
	urgent,
	working,
	yourTurn,
}: {
	urgent: ThreadStatus | null;
	working: boolean;
	yourTurn: number;
}): { spoken: string; status: ThreadStatus; text: string | null } | null {
	const yourTurnLabel = THREAD_STATUS_LABELS["your-turn"];
	const owed = `${yourTurnLabel.toLowerCase()} on ${yourTurn} ${yourTurn === 1 ? "thread" : "threads"}`;
	if (urgent === "attention") {
		return {
			spoken: THREAD_STATUS_LABELS.attention.toLowerCase(),
			status: "attention",
			text: THREAD_STATUS_LABELS.attention,
		};
	}
	if (working) {
		return {
			spoken: yourTurn > 0 ? `working, ${owed}` : "working",
			status: "working",
			text: THREAD_STATUS_LABELS.working,
		};
	}
	if (yourTurn > 0) {
		return {
			spoken: owed,
			status: "your-turn",
			text: yourTurn > 1 ? `${yourTurnLabel} · ${yourTurn}` : null,
		};
	}
	return null;
}

/** Map names are 13px at 100%; below this screen size they stop shrinking. */
const LABEL_PX = 13;
const LABEL_MIN_PX = 11;
/** How far a name may grow against the zoom before it would crowd neighbors. */
const LABEL_MAX_SCALE = 2;

/**
 * How much node labels are scaled up at a zoom, so names stay at least 11px
 * on screen when the map is zoomed out to fit a small canvas.
 */
export function labelScale(zoom: number): number {
	if (zoom <= 0) {
		return 1;
	}
	const scale = LABEL_MIN_PX / (LABEL_PX * zoom);
	return Math.round(Math.min(LABEL_MAX_SCALE, Math.max(1, scale)) * 100) / 100;
}

export type GraphDirection = "down" | "left" | "right" | "up";

const ARROW_DIRECTION = new Map<string, GraphDirection>([
	["ArrowDown", "down"],
	["ArrowLeft", "left"],
	["ArrowRight", "right"],
	["ArrowUp", "up"],
]);

/** The map direction an arrow key names, or null for any other key. */
export function arrowDirection(key: string): GraphDirection | null {
	return ARROW_DIRECTION.get(key) ?? null;
}

/**
 * The node an arrow key should move to: the nearest one whose center lies in
 * that direction, preferring nodes straight ahead over ones off to the side.
 * Null when nothing lies that way.
 */
export function nearestInDirection(
	nodes: readonly GraphNode[],
	fromId: string,
	direction: GraphDirection
): string | null {
	const from = nodes.find((node) => node.id === fromId);
	if (!from) {
		return null;
	}
	let best: { id: string; score: number } | null = null;
	for (const node of nodes) {
		if (node.id === fromId) {
			continue;
		}
		const dx = node.x - from.x;
		const dy = node.y - from.y;
		const horizontal = direction === "left" || direction === "right";
		const sign = direction === "right" || direction === "down" ? 1 : -1;
		const ahead = (horizontal ? dx : dy) * sign;
		const aside = Math.abs(horizontal ? dy : dx);
		// Only nodes within 60 degrees either side of the arrow count.
		if (ahead <= 0 || aside > ahead * 1.75) {
			continue;
		}
		const score = ahead + aside * 2;
		if (!best || score < best.score) {
			best = { id: node.id, score };
		}
	}
	return best?.id ?? null;
}

/** A box in flow or screen space. */
export interface GraphRect {
	height: number;
	width: number;
	x: number;
	y: number;
}

/** Height of the name and status lines under an avatar, with their gap. */
const AGENT_LABEL_HEIGHT = 44;
/** Half the width a typical name and status line spans. */
const AGENT_LABEL_HALF_WIDTH = 64;
/** Room taken by the focus ring around an avatar. */
const AGENT_RING = 4;

/**
 * Flow-space bounds of the given nodes (all when `ids` is empty), including
 * the agent names around each avatar, so a framed node is never cut through
 * its label. Positions are node centers (the map uses a centered origin).
 * `scale` grows the labels and group pills the way a zoomed-out map draws
 * them (see `labelScale`).
 */
export function graphBounds(
	nodes: readonly GraphNode[],
	ids: ReadonlySet<string>,
	scale = 1
): GraphRect | null {
	let left = Number.POSITIVE_INFINITY;
	let top = Number.POSITIVE_INFINITY;
	let right = Number.NEGATIVE_INFINITY;
	let bottom = Number.NEGATIVE_INFINITY;
	for (const node of nodes) {
		if (ids.size > 0 && !ids.has(node.id)) {
			continue;
		}
		const base = GRAPH_NODE_SIZE[node.kind];
		const grows = node.kind === "team" || node.kind === "project";
		const size = grows
			? { height: base.height * scale, width: base.width * scale }
			: base;
		let box = {
			bottom: node.y + size.height / 2,
			left: node.x - size.width / 2,
			right: node.x + size.width / 2,
			top: node.y - size.height / 2,
		};
		if (node.kind === "agent") {
			const half = size.width / 2 + AGENT_RING;
			const labelHalf = AGENT_LABEL_HALF_WIDTH * scale;
			box = {
				bottom: node.y + size.height / 2 + AGENT_LABEL_HEIGHT * scale,
				left: node.x - Math.max(half, labelHalf),
				right: node.x + Math.max(half, labelHalf),
				top: node.y - half,
			};
		}
		left = Math.min(left, box.left);
		right = Math.max(right, box.right);
		top = Math.min(top, box.top);
		bottom = Math.max(bottom, box.bottom);
	}
	if (!Number.isFinite(left)) {
		return null;
	}
	return { height: bottom - top, width: right - left, x: left, y: top };
}

interface Insets {
	bottom: number;
	left: number;
	right: number;
	top: number;
}

/**
 * A viewport that frames `bounds` inside a `width` x `height` canvas while
 * keeping clear of corner overlays (legend, zoom controls, mini map). Each
 * overlay can be cleared sideways or vertically; every combination is tried
 * and the one that allows the largest zoom wins.
 */
export function viewportAvoiding({
	bounds,
	centered = false,
	gap,
	height,
	maxZoom,
	minZoom,
	overlays,
	width,
}: {
	bounds: GraphRect;
	/** Keep the left and right insets equal, so the box centers on the canvas. */
	centered?: boolean;
	gap: number;
	height: number;
	maxZoom: number;
	minZoom: number;
	/** Overlay boxes in canvas pixels (relative to its top-left). */
	overlays: readonly GraphRect[];
	width: number;
}): { x: number; y: number; zoom: number } {
	const combos = 2 ** overlays.length;
	let best: { insets: Insets; zoom: number } | null = null;
	for (let combo = 0; combo < combos; combo++) {
		const insets: Insets = { bottom: gap, left: gap, right: gap, top: gap };
		overlays.forEach((rect, index) => {
			const sideways = (combo >> index) % 2 === 1;
			const onLeft = rect.x + rect.width / 2 < width / 2;
			const onTop = rect.y + rect.height / 2 < height / 2;
			if (sideways && onLeft) {
				insets.left = Math.max(insets.left, rect.x + rect.width + gap);
			} else if (sideways) {
				insets.right = Math.max(insets.right, width - rect.x + gap);
			} else if (onTop) {
				insets.top = Math.max(insets.top, rect.y + rect.height + gap);
			} else {
				insets.bottom = Math.max(insets.bottom, height - rect.y + gap);
			}
		});
		if (centered) {
			const side = Math.max(insets.left, insets.right);
			insets.left = side;
			insets.right = side;
		}
		const room = {
			height: height - insets.top - insets.bottom,
			width: width - insets.left - insets.right,
		};
		if (room.width <= 0 || room.height <= 0) {
			continue;
		}
		const zoom = Math.min(
			room.width / Math.max(bounds.width, 1),
			room.height / Math.max(bounds.height, 1)
		);
		if (!best || zoom > best.zoom) {
			best = { insets, zoom };
		}
	}
	const insets = best?.insets ?? { bottom: 0, left: 0, right: 0, top: 0 };
	const zoom = Math.min(
		maxZoom,
		Math.max(
			minZoom,
			best?.zoom ?? Math.min(width / bounds.width, height / bounds.height)
		)
	);
	const roomWidth = width - insets.left - insets.right;
	const roomHeight = height - insets.top - insets.bottom;
	return {
		x: insets.left + (roomWidth - bounds.width * zoom) / 2 - bounds.x * zoom,
		y: insets.top + (roomHeight - bounds.height * zoom) / 2 - bounds.y * zoom,
		zoom,
	};
}

/** A box widened so it spans as far left of `centerX` as right of it. */
export function mirroredAround(rect: GraphRect, centerX: number): GraphRect {
	const reach = Math.max(centerX - rect.x, rect.x + rect.width - centerX);
	return { ...rect, width: reach * 2, x: centerX - reach };
}

export interface GraphFrameInput {
	/** Every node on the map (positions are centers; "you" sits at 0,0). */
	allNodes: readonly GraphNode[];
	/** Node ids to bring into focus; empty frames the whole map. */
	focusIds: readonly string[];
	/** Canvas size in screen pixels, as measured from the DOM. */
	height: number;
	overlays: readonly GraphRect[];
	width: number;
}

export interface GraphFrameLimits {
	fitMaxZoom: number;
	focusMaxZoom: number;
	/** Space kept between framed nodes and the canvas edge or an overlay. */
	gap: number;
	minZoom: number;
	/**
	 * Canvases narrower than this frame the map's own box instead of one
	 * mirrored around you, so a phone-width canvas spends no width on symmetry.
	 */
	narrowWidth: number;
	/** At or above this the whole map reads fine, so a focus does not zoom. */
	readableZoom: number;
}

interface Viewport {
	x: number;
	y: number;
	zoom: number;
}

/**
 * Fits the given nodes, growing their labels the way the map draws them at
 * the resulting zoom and refitting until the two agree.
 */
function fitNodes(
	input: GraphFrameInput,
	ids: readonly string[],
	options: { centered: boolean; gap: number; maxZoom: number; minZoom: number }
): Viewport | null {
	let scale = 1;
	let viewport: Viewport | null = null;
	for (let pass = 0; pass < 4; pass++) {
		const box = graphBounds(input.allNodes, new Set(ids), scale);
		if (!box) {
			return null;
		}
		viewport = viewportAvoiding({
			bounds: options.centered ? mirroredAround(box, 0) : box,
			centered: options.centered,
			gap: options.gap,
			height: input.height,
			maxZoom: options.maxZoom,
			minZoom: options.minZoom,
			overlays: input.overlays,
			width: input.width,
		});
		const next = labelScale(viewport.zoom);
		if (next <= scale) {
			break;
		}
		scale = next;
	}
	return viewport;
}

/**
 * The viewport for a canvas of the given size. The whole map is always
 * framed, clear of the overlays (centered on you unless the canvas is
 * phone-width); a focus only magnifies when the whole map would be too small
 * to read, so neighbors are never cropped. Recomputed whenever the canvas is
 * measured at a new size.
 */
export function frameViewport(
	input: GraphFrameInput,
	limits: GraphFrameLimits
): Viewport | null {
	const { focusIds, height, width } = input;
	if (width <= 0 || height <= 0) {
		return null;
	}
	const fitAll = fitNodes(input, [], {
		centered: width >= limits.narrowWidth,
		gap: limits.gap,
		maxZoom: limits.fitMaxZoom,
		minZoom: limits.minZoom,
	});
	if (!fitAll || focusIds.length === 0 || fitAll.zoom >= limits.readableZoom) {
		return fitAll;
	}
	return (
		fitNodes(input, focusIds, {
			centered: false,
			gap: limits.gap,
			maxZoom: Math.min(limits.focusMaxZoom, Math.max(fitAll.zoom, 0.85)),
			minZoom: limits.minZoom,
		}) ?? fitAll
	);
}
