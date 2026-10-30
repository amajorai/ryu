import {
	type HoloAgent,
	type MenuItemPlacement,
	normalizeAngle,
	polar,
	type RingSlot,
} from "./hologram-model.ts";

/**
 * Node labels sit on a plate of the deck tone, so a spoke running under
 * them stops at the text instead of striking through it.
 */
export const LABEL_PLATE = "bg-(--holo-deck) px-1";

export const NODE = 48;
export const NODE_RADIUS = NODE / 2 - 2;
/** Room a node and its label need around the ring's edge. */
export const NODE_MARGIN_X = 64;
export const NODE_MARGIN_Y = 76;
/** Below this ring radius, nodes show their name only and hug the edge. */
export const COMPACT_RADIUS = 170;
export const COMPACT_MARGIN_X = 36;
export const COMPACT_MARGIN_Y = 56;
/** How far out the menu items' near edges sit, from the node centre. */
export const MENU_RADIUS = 42;
/** The name label's top edge and line height, from the node centre. */
export const LABEL_TOP = NODE / 2 + 10;
export const LABEL_LINE = 16;
/** Half the widest a name label gets: its w-36 slot. */
export const LABEL_MAX_HALF = 72;

/** The tracked count line under the name (10px mono, 0.16em tracking). */
export const META_LINE = 18;

/** A node's count line, e.g. "2 threads". */
export function threadCountLabel(count: number): string {
	return `${count} ${count === 1 ? "thread" : "threads"}`;
}

/**
 * The node's name and count lines, from the node centre, so the open menu
 * keeps clear of them.
 */
export function labelKeepOut(
	name: string,
	meta = ""
): {
	bottom: number;
	left: number;
	right: number;
	top: number;
} {
	const half = Math.min(
		LABEL_MAX_HALF,
		Math.max(Math.ceil(name.length * 3.6), Math.ceil(meta.length * 4.4)) + 4
	);
	return {
		bottom: LABEL_TOP + LABEL_LINE + (meta ? META_LINE : 0) + 2,
		left: -half,
		right: half,
		top: LABEL_TOP - 2,
	};
}
/** Focus that came from the keyboard (a click focuses without `:focus-visible`). */
export function isKeyboardFocus(element: Element): boolean {
	try {
		return element.matches(":focus-visible");
	} catch {
		return false;
	}
}

/** Keeps the ring still this long after a press, so touch can land on a node. */
export const PRESS_HOLD_MS = 1000;

export type RadialAction = "message" | "open-latest" | "show-threads";

export const MENU_ITEMS: { action: RadialAction; label: string }[] = [
	{ action: "message", label: "Message" },
	{ action: "open-latest", label: "Open latest" },
	{ action: "show-threads", label: "Show threads" },
];

/**
 * A menu item's box: a tracked 10px mono label (about 7.6px a character)
 * with 8px either side.
 */
export function menuItemSize(label: string): { height: number; width: number } {
	return { height: 24, width: Math.ceil(label.length * 7.6 + 16) };
}

export const MENU_SIZES = MENU_ITEMS.map((item) => menuItemSize(item.label));

export interface Geometry {
	/** Name-only node labels, for small decks. */
	compact: boolean;
	coreDiameter: number;
	radii: [number, number];
}

/** Ring radii and core size that fit the measured box. */
export function orbitGeometry(
	width: number,
	height: number,
	rings: number
): Geometry {
	const fitRadius = (marginX: number, marginY: number) =>
		Math.max(96, Math.min(width / 2 - marginX, height / 2 - marginY));
	let outer = fitRadius(NODE_MARGIN_X, NODE_MARGIN_Y);
	const compact = outer < COMPACT_RADIUS;
	if (compact) {
		outer = fitRadius(COMPACT_MARGIN_X, COMPACT_MARGIN_Y);
	}
	const inner = rings > 1 ? Math.max(84, outer * 0.62) : outer;
	const coreDiameter = Math.round(
		Math.max(96, Math.min(248, (inner - NODE - 16) * 2))
	);
	return {
		compact,
		coreDiameter,
		radii: [Math.round(inner), Math.round(outer)],
	};
}

/** Spin direction and speed per ring: the outer ring turns back, slower. */
export const RING_SPIN = [
	"var(--holo-spin, 0deg)",
	"calc(var(--holo-spin, 0deg) * -0.6)",
] as const;

export function anchorTransform(slot: RingSlot, radius: number): string {
	const turn = `calc(${slot.angle}deg + ${RING_SPIN[slot.ring]})`;
	const back = `calc(-${slot.angle}deg - ${RING_SPIN[slot.ring]})`;
	return `rotate(${turn}) translateY(-${radius}px) rotate(${back})`;
}

export function nodeLabel(agent: HoloAgent): string {
	const parts = [
		agent.name,
		agent.status === "working" ? "working" : "idle",
		`${agent.threadCount} ${agent.threadCount === 1 ? "thread" : "threads"}`,
	];
	if (agent.failed > 0) {
		parts.push(`${agent.failed} failed`);
	}
	if (agent.needsYou > 0) {
		parts.push(
			`${agent.needsYou} ${agent.needsYou === 1 ? "needs" : "need"} you`
		);
	}
	return parts.join(", ");
}

/** Thread ticks around a node: one per thread, this far apart, at most this many. */
export const TICK_STEP = 24;
export const TICK_MAX = 360 / TICK_STEP;
export const TICK_INNER = NODE_RADIUS + 4;
export const TICK_OUTER = NODE_RADIUS + 9;
/** The working sweep's length on the rim, in degrees. */
export const SWEEP = 96;

/**
 * Tick tones in order: failed runs, then replies owed, live runs, the rest;
 * they sit on a hairline track, so a short run of ticks reads as a segment.
 */
export function tickTones(agent: HoloAgent): string[] {
	const tones: string[] = [];
	const push = (count: number, tone: string) => {
		for (let index = 0; index < count && tones.length < TICK_MAX; index++) {
			tones.push(tone);
		}
	};
	const needsYou = Math.max(0, agent.needsYou - agent.failed);
	push(agent.failed, "stroke-(--holo-alert)");
	push(needsYou, "stroke-(--holo-turn)");
	push(agent.workingThreads, "stroke-(--holo-ink)");
	push(
		agent.threadCount - agent.failed - needsYou - agent.workingThreads,
		"stroke-(--holo-dim)"
	);
	return tones;
}

/** An arc on a circle round the origin, clockwise from `from` to `to` degrees. */
export function arcPath(radius: number, from: number, to: number): string {
	const start = polar(from, radius);
	const end = polar(to, radius);
	const large = normalizeAngle(to - from) > 180 ? 1 : 0;
	return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${large} 1 ${end.x} ${end.y}`;
}

/** The arc the open menu's items hang off, just outside the thread ticks. */
export const MENU_ARC = TICK_OUTER + 4;

/**
 * The arc through the fan, from the item that is furthest anticlockwise to
 * the one furthest clockwise.
 */
export function menuArcPath(placements: MenuItemPlacement[]): string {
	const first = placements[0];
	if (!first) {
		return "";
	}
	// Offsets from the first item, so the fan reads as one span even when
	// it crosses 12 o'clock.
	const offsets = placements.map(
		(place) => normalizeAngle(place.angle - first.angle + 180) - 180
	);
	const from = first.angle + Math.min(...offsets);
	const to = first.angle + Math.max(...offsets);
	return arcPath(MENU_ARC, from, to);
}
