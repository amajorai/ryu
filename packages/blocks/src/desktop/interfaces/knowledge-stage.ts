import {
	type Adjacency,
	type ForceSettings,
	type KnowledgeGraph,
	type KnowledgeNode,
	type Layout,
	neighbourhood,
	type Vec3,
} from "./knowledge-model.ts";
import {
	agentColor,
	type KnowledgePalette,
	type Rgb,
	unitRgb,
} from "./knowledge-palette.ts";

/**
 * What the two renderers (WebGL and the 2D fallback) share with the DOM:
 * per-node and per-link styles computed from React state, the screen
 * projection each renderer writes every frame (used for picking and for the
 * label layer), and the label placement itself.
 */

export interface GraphStyles {
	/** Per node: 1 for agents, drawn with an inner cut so they read apart. */
	agent: Uint8Array;
	/** Per node: target opacity. */
	alpha: Float32Array;
	/** Per node: 0..1 rgb. */
	colors: Float32Array;
	/**
	 * Per node: LABEL_HOVERED, LABEL_SELECTED or LABEL_FORCED force the label
	 * on (in that priority), -1 hides it, 0 leaves it to zoom.
	 */
	label: Int8Array;
	/** Per link: target opacity. */
	linkAlpha: Float32Array;
	/** Per link: 0..1 rgb. */
	linkColors: Float32Array;
	/** Per node: 1 draws the selection ring. */
	ring: Float32Array;
	/** Per node: radius in world units. */
	size: Float32Array;
}

/** Label priority: hovered or keyboard-focused, then selected, then forced. */
export const LABEL_HOVERED = 3;
export const LABEL_SELECTED = 2;
export const LABEL_FORCED = 1;

export interface Projection {
	/** Distance from the camera (for front-to-back picking and sorting). */
	depth: Float32Array;
	/** 0 at the front of the graph, 1 at the back (labels fade with it). */
	fog: Float32Array;
	/** Projected radius in CSS pixels. */
	radius: Float32Array;
	/** 1 when on screen and in front of the camera. */
	visible: Uint8Array;
	x: Float32Array;
	y: Float32Array;
}

export interface CameraApi {
	/**
	 * Ease the view to centre a node in the free area (keeping the zoom unless
	 * zoomed further out than the fit).
	 */
	focus: (id: string) => void;
	/** Draw a frame (chrome over the stage changed shape). */
	invalidate: () => void;
	/** Fit the whole graph again and resume auto-fit. */
	reset: () => void;
	/** Pan to a node only when it sits outside the free area. */
	reveal: (id: string) => void;
	zoom: (factor: number) => void;
}

export interface Emphasis {
	hovered: string | null;
	matches: ReadonlySet<string>;
	query: boolean;
	selected: string | null;
}

export function createProjection(count: number): Projection {
	return {
		depth: new Float32Array(count),
		fog: new Float32Array(count),
		radius: new Float32Array(count),
		visible: new Uint8Array(count),
		x: new Float32Array(count),
		y: new Float32Array(count),
	};
}

export function nodeColor(node: KnowledgeNode, palette: KnowledgePalette): Rgb {
	switch (node.kind) {
		case "agent":
			return agentColor(node.label, palette);
		case "project":
		case "team":
			return palette.hub;
		case "topic":
			return palette.topic;
		default:
			return node.status ? palette.status[node.status] : palette.neutral;
	}
}

/** Opacity of nodes outside the selection's neighbourhood (softer than hover). */
const SELECTION_DIM = 0.4;
/** Hovered or keyboard-focused nodes grow by this much. */
const FOCUS_GROWTH = 1.3;
/** Ring strength: the selection is solid, hover and focus lighter. */
const RING_SELECTED = 1;
const RING_FOCUSED = 0.55;

/**
 * Styles for the visible graph. Emphasis never repaints a node: an agent
 * keeps its avatar tint, a topic its topic colour, a conversation its status.
 * Hover (or keyboard focus) grows the node, rings it, lights its links and
 * dims everything else; a search query dims what it does not match (and
 * then hover only rings and labels the node under the pointer); the
 * selection wears a solid ring and keeps a softer emphasis on its
 * neighbourhood, however it was selected (click, key or URL).
 */
export function buildStyles(
	graph: KnowledgeGraph,
	layout: Layout,
	links: Adjacency,
	palette: KnowledgePalette,
	emphasis: Emphasis,
	nodeSize: number
): GraphStyles {
	const count = layout.ids.length;
	const linkCount = layout.links.length / 2;
	const styles: GraphStyles = {
		agent: new Uint8Array(count),
		alpha: new Float32Array(count),
		colors: new Float32Array(count * 3),
		label: new Int8Array(count),
		linkAlpha: new Float32Array(linkCount),
		linkColors: new Float32Array(linkCount * 3),
		ring: new Float32Array(count),
		size: new Float32Array(count),
	};
	const known = (id: string | null) =>
		id !== null && layout.index.has(id) ? id : null;
	const hovered = known(emphasis.hovered);
	const selected = known(emphasis.selected);
	let lit: ReadonlySet<string> | null = null;
	let dim = palette.dimAlpha;
	// A search wins over hover: while a query is typed, the matches stay lit
	// and hover only rings the node under the pointer.
	if (emphasis.query) {
		lit = emphasis.matches;
	} else if (hovered) {
		lit = neighbourhood(links, hovered, 1);
	} else if (selected) {
		lit = neighbourhood(links, selected, 1);
		dim = SELECTION_DIM;
	}
	for (const node of graph.nodes) {
		const index = layout.index.get(node.id);
		if (index === undefined) {
			continue;
		}
		styles.colors.set(unitRgb(nodeColor(node, palette)), index * 3);
		styles.agent[index] = node.kind === "agent" ? 1 : 0;
		const inLight = lit ? lit.has(node.id) : true;
		styles.alpha[index] = inLight ? 1 : dim;
		const grow = node.id === hovered && inLight ? FOCUS_GROWTH : 1;
		styles.size[index] = (layout.radii[index] ?? 2) * nodeSize * grow;
		if (node.id === selected) {
			styles.ring[index] = RING_SELECTED;
		} else if (node.id === hovered) {
			styles.ring[index] = RING_FOCUSED;
		}
		if (node.id === hovered) {
			styles.label[index] = LABEL_HOVERED;
		} else if (node.id === selected) {
			styles.label[index] = LABEL_SELECTED;
		} else if (lit && inLight) {
			styles.label[index] = LABEL_FORCED;
		} else if (lit && dim < SELECTION_DIM) {
			styles.label[index] = -1;
		}
	}
	const rest = unitRgb(palette.link);
	const highlight = unitRgb(palette.highlight);
	for (let link = 0; link < linkCount; link += 1) {
		const source = layout.ids[layout.links[link * 2] ?? 0] ?? "";
		const target = layout.ids[layout.links[link * 2 + 1] ?? 0] ?? "";
		let color = rest;
		let alpha = palette.linkAlpha;
		const touches = (id: string | null) =>
			id !== null && (source === id || target === id);
		if (emphasis.query) {
			const on = emphasis.matches.has(source) && emphasis.matches.has(target);
			alpha = on ? palette.linkAlpha : palette.dimLinkAlpha;
		} else if (hovered) {
			const on = touches(hovered);
			color = on ? highlight : rest;
			alpha = on ? 0.9 : palette.dimLinkAlpha;
		} else if (selected) {
			const on = touches(selected);
			color = on ? highlight : rest;
			alpha = on ? 0.8 : palette.linkAlpha * SELECTION_DIM;
		}
		styles.linkColors.set(color, link * 3);
		styles.linkAlpha[link] = alpha;
	}
	return styles;
}

/** Projected radius (px) at which labels are fully faded in. */
export function labelThreshold(textFade: number): number {
	return 9 - textFade * 7.5;
}

const KIND_RANK: Record<string, number> = {
	agent: 1,
	conversation: 3,
	project: 0,
	team: 0,
	topic: 2,
};

/**
 * How much on-screen size each kind needs before its label shows, relative
 * to the text-fade threshold. Zooming out drops conversation and topic
 * labels first, then agents; project and team hubs hold theirs longest,
 * as Obsidian keeps only the big nodes named from afar.
 */
const KIND_FADE: Record<string, number> = {
	agent: 1.9,
	conversation: 1.65,
	project: 1.3,
	team: 1.3,
	topic: 1.65,
};

interface LabelBox {
	rank: number;
	width: number;
}

const boxes = new WeakMap<HTMLElement, LabelBox>();
const fullBoxes = new WeakMap<HTMLElement, LabelBox>();

/**
 * A label's rank and rendered width, cached. `full` measures the label with
 * its whole text (hovered or selected: nothing is truncated then, as in
 * Obsidian); otherwise long titles are clipped to a short width.
 */
function labelBox(element: HTMLElement, full = false): LabelBox {
	const cache = full ? fullBoxes : boxes;
	const state = full ? "true" : "false";
	if (element.dataset.full !== state) {
		element.dataset.full = state;
	}
	const cached = cache.get(element);
	if (cached && cached.width > 0) {
		return cached;
	}
	const box = {
		rank: KIND_RANK[element.dataset.kind ?? ""] ?? 3,
		width: element.offsetWidth,
	};
	cache.set(element, box);
	return box;
}

const LABEL_HEIGHT = 18;
/** Bands at the top and bottom where header and legend sit (fallback chrome). */
const CHROME_TOP = 58;
const CHROME_BOTTOM = 44;
/**
 * How much of a label's opacity the back of the graph takes away. Kept small
 * so a resting label never drops below body-text contrast: depth reads
 * through the discs (perspective size and fog), not through the text.
 */
const LABEL_FOG = 0.1;
/** Labels keep this far from the stage edges (CSS pixels). */
const LABEL_GUTTER = 12;
/** Breathing room between two labels, across and down. */
const LABEL_SPACING_X = 8;
const LABEL_SPACING_Y = 3;

/** A label's rendered width (cached); 0 before it has been laid out. */
export function labelWidth(element: HTMLElement | undefined): number {
	if (!element) {
		return 0;
	}
	const cached = boxes.get(element);
	if (cached && cached.width > 0) {
		return cached.width;
	}
	// Only a clipped (resting) label measures its resting width.
	return element.dataset.full === "true"
		? (cached?.width ?? 0)
		: labelBox(element).width;
}
const LABEL_GAP = 4;
/** The selection ring's outer edge, in CSS pixels beyond the disc. */
export const RING_REACH_PX = 4;

/** Where labels may go: the stage size and the chrome floating over it. */
export interface LabelFrame {
	height: number;
	/**
	 * Boxes (left, top, right, bottom, in stage pixels) of the chrome over the
	 * graph: header, settings card, legend, zoom. Null falls back to bands at
	 * the top and bottom.
	 */
	obstacles: readonly Rect[] | null;
	textFade: number;
	width: number;
}

/**
 * Opacity of a label that is not forced: it fades in over a short zoom range
 * (bigger on screen means more legible, so hubs and agents label first), then
 * holds; depth takes off only a little.
 */
function restingOpacity(radius: number, threshold: number, fog: number) {
	const zoom = Math.min(
		1,
		Math.max(0, (radius - threshold * 0.6) / (threshold * 0.25))
	);
	return zoom * (1 - fog * LABEL_FOG);
}

/** A label the stage edge would push further than this from its node hides. */
const CLAMP_TOLERANCE = 6;
/** Overlap (px²) with a disc's margin that does not count as covering it. */
const COVER_TOLERANCE = 24;
/** Cost of a link running through a label: another side is preferred. */
const EDGE_COST = 60;
/** Links fainter than this (dimmed ones) do not count as obstacles. */
const EDGE_MIN_ALPHA = 0.15;
/** Past this many link tests per frame, links stop counting as obstacles. */
const EDGE_BUDGET = 80_000;
/** What makes a label spot bad, from worst to mildest. */
interface SpotCost {
	/** Another label, the chrome, or the stage edge: never shown there. */
	blocked: number;
	/** Over a node, or nearer another node than its own. */
	covers: number;
	/** Links running through it. */
	crossings: number;
}

/**
 * Lower is better. Any spot where the label can show (nothing blocks it,
 * no node is covered) beats every spot where it cannot, so a label is only
 * culled when no side around its node has room.
 */
function spotScore(cost: SpotCost): number {
	return (
		(cost.blocked > 0 ? 1e9 + cost.blocked : 0) +
		(cost.covers > 0 ? 1e6 + cost.covers : 0) +
		cost.crossings
	);
}

type Segment = [number, number, number, number];

/** True when the segment passes through the box (Liang-Barsky clip). */
export function segmentCrossesRect(segment: Segment, rect: Rect): boolean {
	const [x1, y1, x2, y2] = segment;
	const dx = x2 - x1;
	const dy = y2 - y1;
	const edges: [number, number][] = [
		[-dx, x1 - rect[0]],
		[dx, rect[2] - x1],
		[-dy, y1 - rect[1]],
		[dy, rect[3] - y1],
	];
	let enter = 0;
	let exit = 1;
	for (const [direction, distance] of edges) {
		if (direction === 0) {
			if (distance < 0) {
				return false;
			}
			continue;
		}
		const at = distance / direction;
		if (direction < 0) {
			if (at > exit) {
				return false;
			}
			enter = Math.max(enter, at);
		} else {
			if (at < enter) {
				return false;
			}
			exit = Math.min(exit, at);
		}
	}
	return enter <= exit;
}

/** On-screen links that are bright enough to cut through a label. */
function visibleSegments(
	layout: Layout,
	projection: Projection,
	styles: GraphStyles
): Segment[] {
	const segments: Segment[] = [];
	const linkCount = layout.links.length / 2;
	for (let link = 0; link < linkCount; link += 1) {
		const source = layout.links[link * 2] ?? 0;
		const target = layout.links[link * 2 + 1] ?? 0;
		if (
			!(projection.visible[source] && projection.visible[target]) ||
			(styles.linkAlpha[link] ?? 0) < EDGE_MIN_ALPHA
		) {
			continue;
		}
		segments.push([
			projection.x[source] ?? 0,
			projection.y[source] ?? 0,
			projection.x[target] ?? 0,
			projection.y[target] ?? 0,
		]);
	}
	return segments;
}

/**
 * Move each label under its node and fade it by zoom. Forced labels (hover,
 * search, selection) always show; dimmed ones hide. Labels never overlap:
 * the hovered and the selected node's labels claim space first, then the
 * other forced ones, then hubs, agents, topics and conversations (bigger
 * nodes first). A label sits under its node, nudged sideways when that
 * collides, preferring a spot no link runs through; a forced label that
 * still collides with another label hides, and a resting one also hides
 * when it would cover a node or sit nearer another node than its own. A
 * label whose node is off the stage, or that the stage edge would push away
 * from its node, hides too. Labels keep clear of the chrome.
 */
export function syncLabels(
	layout: Layout,
	projection: Projection,
	styles: GraphStyles,
	currentAlpha: Float32Array,
	labels: ReadonlyMap<string, HTMLElement>,
	frame: LabelFrame
): void {
	const { height, width } = frame;
	const threshold = labelThreshold(frame.textFade);
	const chrome: readonly Rect[] = frame.obstacles ?? [
		[
			Number.NEGATIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			Number.POSITIVE_INFINITY,
			CHROME_TOP,
		],
		[
			Number.NEGATIVE_INFINITY,
			height - CHROME_BOTTOM,
			Number.POSITIVE_INFINITY,
			Number.POSITIVE_INFINITY,
		],
	];
	const candidates: {
		box: LabelBox;
		element: HTMLElement;
		index: number;
		opacity: number;
	}[] = [];
	for (const [index, id] of layout.ids.entries()) {
		const element = labels.get(id);
		if (!element) {
			continue;
		}
		let opacity = 0;
		const forced = styles.label[index] ?? 0;
		const x = projection.x[index] ?? 0;
		const y = projection.y[index] ?? 0;
		// A node off the stage takes its label with it.
		const onStage = x >= 0 && x <= width && y >= 0 && y <= height;
		if (projection.visible[index] && onStage) {
			if (forced >= LABEL_FORCED) {
				opacity = 1;
			} else if (forced === 0) {
				opacity =
					restingOpacity(
						projection.radius[index] ?? 0,
						threshold * (KIND_FADE[element.dataset.kind ?? ""] ?? 1),
						projection.fog[index] ?? 0
					) * Math.min(1, (currentAlpha[index] ?? 1) * 1.4);
			}
		}
		if (opacity < 0.02) {
			if (element.style.opacity !== "0") {
				element.style.opacity = "0";
			}
			continue;
		}
		candidates.push({
			box: labelBox(element, forced >= LABEL_SELECTED),
			element,
			index,
			opacity,
		});
	}
	candidates.sort(
		(a, b) =>
			(styles.label[b.index] ?? 0) - (styles.label[a.index] ?? 0) ||
			a.box.rank - b.box.rank ||
			(projection.radius[b.index] ?? 0) - (projection.radius[a.index] ?? 0)
	);
	// Node discs are obstacles too: a label never covers another node.
	const discs: [number, number, number, number, number][] = [];
	for (let index = 0; index < layout.ids.length; index += 1) {
		const radius = projection.radius[index] ?? 0;
		if (projection.visible[index]) {
			const x = projection.x[index] ?? 0;
			const y = projection.y[index] ?? 0;
			const reach = Math.max(radius, 2.5);
			discs.push([x - reach, y - reach, x + reach, y + reach, index]);
		}
	}
	const allSegments = visibleSegments(layout, projection, styles);
	const segments =
		allSegments.length * candidates.length * SIDES.length <= EDGE_BUDGET
			? allSegments
			: [];
	const placed: Rect[] = [];
	// While a node is hovered, resting labels hold the slot they had: only
	// labels that were hidden, or that the hover now blocks, move.
	let hovering = false;
	for (const value of styles.label) {
		if (value === LABEL_HOVERED) {
			hovering = true;
			break;
		}
	}
	for (const [
		order,
		{ box, element, index, opacity },
	] of candidates.entries()) {
		const priority = styles.label[index] ?? 0;
		const forced = priority >= LABEL_FORCED;
		// The first hovered or selected label always shows; it claims space
		// before every other label.
		const primary = order === 0 && priority >= LABEL_SELECTED;
		const x = projection.x[index] ?? 0;
		const y = projection.y[index] ?? 0;
		// A ringed node's label clears the ring, not just the disc.
		const ringed = (styles.ring[index] ?? 0) > 0;
		const best = placeLabel(
			x,
			y,
			(projection.radius[index] ?? 0) + (ringed ? RING_REACH_PX : 0),
			box.width,
			{
				height,
				hold:
					priority < LABEL_SELECTED &&
					element.style.opacity !== "0" &&
					element.dataset.placed === "true",
				hovering,
				previous: element.dataset.side as LabelSide | undefined,
				width,
			},
			(rect, shift) => {
				const cost: SpotCost = {
					blocked: shift > CLAMP_TOLERANCE ? 1e6 : 0,
					covers: 0,
					crossings: 0,
				};
				for (const other of placed) {
					cost.blocked += overlapArea(
						rect,
						other,
						LABEL_SPACING_Y,
						LABEL_SPACING_X
					);
				}
				for (const band of chrome) {
					cost.blocked += overlapArea(rect, band, 0) > 0 ? 1e6 : 0;
				}
				// The label reads as belonging to whatever node sits nearest
				// its attachment point: the part of the box closest to its own
				// node (the middle of its top edge when it hangs below).
				const anchorX = Math.min(rect[2], Math.max(rect[0], x));
				const anchorY = Math.min(rect[3], Math.max(rect[1], y));
				const own = Math.hypot(anchorX - x, anchorY - y);
				for (const disc of discs) {
					// Covering a node reads worse than touching another label
					// (its own included: a label clamped from the edge must
					// not slide over its dot). A corner grazing the edge of a
					// disc's margin still reads clearly (the label has a halo);
					// only real overlap counts.
					const covered = overlapArea(rect, disc, 2, 4);
					if (covered > COVER_TOLERANCE) {
						cost.covers += covered * 2;
					}
					if (disc[4] === index) {
						continue;
					}
					// A label nearer another node than its own is misread.
					const otherX = (disc[0] + disc[2]) / 2;
					const otherY = (disc[1] + disc[3]) / 2;
					if (Math.hypot(anchorX - otherX, anchorY - otherY) < own - 2) {
						cost.covers += 400;
					}
				}
				// Glyph band only: a link grazing the box edge is fine.
				const glyphs: Rect = [rect[0], rect[1] + 2, rect[2], rect[3] - 2];
				for (const segment of segments) {
					if (segmentCrossesRect(segment, glyphs)) {
						cost.crossings += EDGE_COST;
					}
				}
				return cost;
			}
		);
		let show = best.cost.blocked === 0;
		if (primary) {
			show = true;
		} else if (!forced) {
			show = show && best.cost.covers === 0;
		}
		const next = show ? opacity.toFixed(2) : "0";
		if (element.style.opacity !== next) {
			element.style.opacity = next;
		}
		const placedState = show ? "true" : "false";
		if (element.dataset.placed !== placedState) {
			element.dataset.placed = placedState;
		}
		if (!show) {
			continue;
		}
		const rect = best.rect;
		placed.push(rect);
		if (element.dataset.side !== best.side) {
			element.dataset.side = best.side;
		}
		const emphasis = forced ? "true" : "false";
		if (element.dataset.forced !== emphasis) {
			element.dataset.forced = emphasis;
		}
		element.style.transform = `translate3d(${rect[0].toFixed(1)}px, ${rect[1].toFixed(1)}px, 0)`;
	}
}

export type Rect = [number, number, number, number];
type LabelSide =
	| "above"
	| "below"
	| "below-left"
	| "below-right"
	| "left"
	| "right";
/**
 * Under the node reads best (Obsidian's convention), so a label stays under
 * it, nudged sideways when crowded, then beside it, and flips above only as
 * a last resort.
 */
const SIDES: readonly LabelSide[] = [
	"below",
	"below-left",
	"below-right",
	"right",
	"left",
	"above",
];

/** Overlap area of two boxes, with `spacing` pixels of room around them. */
function overlapArea(
	rect: Rect,
	other: readonly number[],
	spacing: number,
	spacingX = 0
): number {
	const width =
		Math.min(rect[2] + spacingX, other[2] ?? 0) -
		Math.max(rect[0] - spacingX, other[0] ?? 0);
	const height =
		Math.min(rect[3] + spacing, other[3] ?? 0) -
		Math.max(rect[1] - spacing, other[1] ?? 0);
	return width > 0 && height > 0 ? width * height : 0;
}

/** A label's box (left, top, right, bottom) on one side of its node. */
export function labelRect(
	x: number,
	y: number,
	radius: number,
	width: number,
	side: LabelSide
): Rect {
	const half = width / 2;
	switch (side) {
		case "above": {
			const bottom = y - radius - LABEL_GAP;
			return [x - half, bottom - LABEL_HEIGHT, x + half, bottom];
		}
		case "right": {
			const left = x + radius + LABEL_GAP + 2;
			return [left, y - LABEL_HEIGHT / 2, left + width, y + LABEL_HEIGHT / 2];
		}
		case "left": {
			const right = x - radius - LABEL_GAP - 2;
			return [right - width, y - LABEL_HEIGHT / 2, right, y + LABEL_HEIGHT / 2];
		}
		case "below-left":
		case "below-right": {
			// Shift so the node still sits over the label's inner third.
			const shift = (side === "below-left" ? -1 : 1) * width * 0.32;
			const top = y + radius + LABEL_GAP;
			return [x - half + shift, top, x + half + shift, top + LABEL_HEIGHT];
		}
		default: {
			const top = y + radius + LABEL_GAP;
			return [x - half, top, x + half, top + LABEL_HEIGHT];
		}
	}
}

/** Slide a box inside the stage, keeping a gutter from every edge. */
function clampRect(rect: Rect, width: number, height: number): Rect {
	let dx = 0;
	let dy = 0;
	if (width > LABEL_GUTTER * 2 + rect[2] - rect[0]) {
		if (rect[0] < LABEL_GUTTER) {
			dx = LABEL_GUTTER - rect[0];
		} else if (rect[2] > width - LABEL_GUTTER) {
			dx = width - LABEL_GUTTER - rect[2];
		}
	}
	if (height > LABEL_GUTTER * 2 + LABEL_HEIGHT) {
		if (rect[1] < LABEL_GUTTER) {
			dy = LABEL_GUTTER - rect[1];
		} else if (rect[3] > height - LABEL_GUTTER) {
			dy = height - LABEL_GUTTER - rect[3];
		}
	}
	return [rect[0] + dx, rect[1] + dy, rect[2] + dx, rect[3] + dy];
}

interface Spot {
	cost: SpotCost;
	rect: Rect;
	side: LabelSide;
}

/**
 * The first side where the label touches nothing; failing that, the side
 * with the mildest problems (another label or the chrome worst, then a
 * covered node, then links running through it).
 */
function placeLabel(
	x: number,
	y: number,
	radius: number,
	width: number,
	stage: {
		height: number;
		/** The label is showing in `previous`: keep it there if still clear. */
		hold: boolean;
		/** A node is hovered: links lit by it do not move a held label. */
		hovering: boolean;
		previous: LabelSide | undefined;
		width: number;
	},
	costOf: (rect: Rect, shift: number) => SpotCost
): Spot {
	let best: Spot | null = null;
	const sides = SIDES;
	if (stage.hold && stage.previous && sides.includes(stage.previous)) {
		const raw = labelRect(x, y, radius, width, stage.previous);
		const rect = clampRect(raw, stage.width, stage.height);
		const shift = Math.abs(rect[0] - raw[0]) + Math.abs(rect[1] - raw[1]);
		const cost = costOf(rect, shift);
		if (
			cost.blocked === 0 &&
			cost.covers === 0 &&
			(stage.hovering || cost.crossings === 0)
		) {
			return { cost, rect, side: stage.previous };
		}
	}
	// Under the node first; then the side the label already had, so labels
	// do not hop between sides while the camera moves.
	const order =
		stage.previous && sides.includes(stage.previous)
			? [sides[0] ?? "below", stage.previous, ...sides.slice(1)]
			: sides;
	for (const side of order) {
		const raw = labelRect(x, y, radius, width, side);
		const rect = clampRect(raw, stage.width, stage.height);
		const shift = Math.abs(rect[0] - raw[0]) + Math.abs(rect[1] - raw[1]);
		const cost = costOf(rect, shift);
		if (spotScore(cost) === 0) {
			return { cost, rect, side };
		}
		if (!best || spotScore(cost) < spotScore(best.cost)) {
			best = { cost, rect, side };
		}
	}
	return (
		best ?? {
			cost: { blocked: 0, covers: 0, crossings: 0 },
			rect: clampRect(
				labelRect(x, y, radius, width, "below"),
				stage.width,
				stage.height
			),
			side: "below",
		}
	);
}

/**
 * Boxes of the chrome floating over the stage, relative to `stage`, padded a
 * little so labels keep clear of their edges. Chrome marked
 * `data-knowledge-chrome="band"` (the header) blocks its whole row.
 */
export function chromeObstacles(
	stage: HTMLElement | null,
	elements: readonly (HTMLElement | null)[]
): Rect[] | null {
	if (!stage) {
		return null;
	}
	const origin = stage.getBoundingClientRect();
	const boxes: Rect[] = [];
	for (const element of elements) {
		if (!element) {
			continue;
		}
		const box = element.getBoundingClientRect();
		if (box.width === 0 || box.height === 0) {
			continue;
		}
		const band = element.dataset.knowledgeChrome === "band";
		boxes.push([
			band ? Number.NEGATIVE_INFINITY : box.left - origin.left - 6,
			box.top - origin.top - 4,
			band ? Number.POSITIVE_INFINITY : box.right - origin.left + 6,
			box.bottom - origin.top + 4,
		]);
	}
	return boxes;
}

/**
 * The part of the stage the graph may use: clear of the header (top), the
 * legend and zoom controls (bottom) and the settings card (right).
 */
export interface FreeArea {
	bottom: number;
	left: number;
	right: number;
	top: number;
}

const AREA_TOP = 64;
const AREA_BOTTOM = 52;
const AREA_SIDE = 16;

export function freeArea(
	width: number,
	height: number,
	insetRight: number
): FreeArea {
	const inset = Math.min(insetRight, width * 0.5);
	return {
		bottom: Math.max(AREA_TOP + 40, height - AREA_BOTTOM),
		left: AREA_SIDE,
		right: Math.max(AREA_SIDE + 40, width - inset - AREA_SIDE),
		top: Math.min(AREA_TOP, height * 0.2),
	};
}

/** Horizontal room a label claims beside its node, capped for narrow stages. */
export function labelPad(width: number, area: FreeArea): number {
	return Math.min(width / 2, (area.right - area.left) * 0.18);
}

/** Below a node: the gap and one line of label. */
export const LABEL_BELOW = 24;

/** True when a node's projection sits inside the free area. */
export function inFreeArea(
	projection: Projection,
	index: number,
	area: FreeArea
): boolean {
	const x = projection.x[index] ?? 0;
	const y = projection.y[index] ?? 0;
	return (
		projection.visible[index] === 1 &&
		x >= area.left &&
		x <= area.right &&
		y >= area.top &&
		y <= area.bottom
	);
}

/** The front-most node under a point (with a small touch margin), if any. */
export function pickNode(
	layout: Layout,
	projection: Projection,
	x: number,
	y: number
): string | null {
	let best: string | null = null;
	let bestDepth = Number.POSITIVE_INFINITY;
	for (const [index, id] of layout.ids.entries()) {
		if (!projection.visible[index]) {
			continue;
		}
		const reach = Math.max(projection.radius[index] ?? 0, 5) + 3;
		const distance = Math.hypot(
			(projection.x[index] ?? 0) - x,
			(projection.y[index] ?? 0) - y
		);
		const depth = projection.depth[index] ?? 0;
		if (distance <= reach && depth < bestDepth) {
			best = id;
			bestDepth = depth;
		}
	}
	return best;
}

/** Ease `current` toward `target` per element (or snap). */
export function easeAlpha(
	current: Float32Array,
	target: Float32Array,
	amount: number
): boolean {
	let moving = false;
	for (let index = 0; index < target.length; index += 1) {
		const from = current[index] ?? 0;
		const to = target[index] ?? 0;
		const next = amount >= 1 ? to : from + (to - from) * amount;
		current[index] = Math.abs(next - to) < 0.002 ? to : next;
		if (current[index] !== to) {
			moving = true;
		}
	}
	return moving;
}

/** Props both renderers take. Mutable per-frame data travels by object. */
export interface KnowledgeRendererProps {
	cameraApi: { current: CameraApi | null };
	/** The selection when the renderer mounts: the camera eases to it. */
	focusId: string | null;
	forces: ForceSettings;
	/** Width (px) covered on the right by the settings panel; fits avoid it. */
	insetRight: number;
	labels: ReadonlyMap<string, HTMLElement>;
	layout: Layout;
	/** Link width in CSS pixels. */
	linkWidth: number;
	/** Boxes of the chrome over the stage, measured each frame. */
	obstacles: () => readonly Rect[] | null;
	/** Called when the renderer cannot draw (lost or failed GL context). */
	onLost?: () => void;
	/** Called once the first frame has been drawn (labels placed). */
	onReady?: () => void;
	palette: KnowledgePalette;
	paused: boolean;
	projection: Projection;
	quality: "high" | "low";
	reduced: boolean;
	styles: GraphStyles;
	textFade: number;
}

/** A node and its direct neighbours, by layout index. */
export function neighbourIndices(layout: Layout, index: number): Set<number> {
	const result = new Set([index]);
	const linkCount = layout.links.length / 2;
	for (let link = 0; link < linkCount; link += 1) {
		const source = layout.links[link * 2] ?? -1;
		const target = layout.links[link * 2 + 1] ?? -1;
		if (source === index) {
			result.add(target);
		} else if (target === index) {
			result.add(source);
		}
	}
	return result;
}

/** Breathing room around a focused neighbourhood (share of its fit). */
export const FOCUS_MARGIN = 1.3;

/** Disc radius relative to the layout radius, per renderer. */
export const DISC_SCALE = { flat: 0.74, scene: 0.45 } as const;
/**
 * The largest a disc may be drawn by an automatic fit (CSS pixels): a small
 * subgraph (local mode, a tiny workspace) keeps the global graph's node
 * scale instead of swelling to fill the stage.
 */
export const MAX_FIT_DISC_PX = 20;

// ---------------------------------------------------------------------------
// 3D camera framing (shared by the scene and its loading outline)
// ---------------------------------------------------------------------------

export const SCENE_FOV = 50;
export const SCENE_NEAR = 0.5;

function normalize(vector: Vec3): Vec3 {
	const length = Math.hypot(...vector) || 1;
	return [vector[0] / length, vector[1] / length, vector[2] / length];
}

export function dot(a: Vec3, b: Vec3): number {
	return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * The 3D view's opening direction: about 16 degrees of yaw and 20 of pitch,
 * so the graph reads as a volume before anyone drags it.
 */
export const INITIAL_DIRECTION: Vec3 = normalize([0.3, 0.38, 1]);

/** The camera's right, up and back axes for a view direction (y up). */
export interface Basis {
	back: Vec3;
	right: Vec3;
	up: Vec3;
}

export function basisOf(back: Vec3): Basis {
	const right = normalize([back[2], 0, -back[0]]);
	const up: Vec3 = [
		back[1] * right[2] - back[2] * right[1],
		back[2] * right[0] - back[0] * right[2],
		back[0] * right[1] - back[1] * right[0],
	];
	return { back, right, up };
}

export interface CameraFrame {
	area: FreeArea;
	focal: number;
	height: number;
	width: number;
}

/** Focal length (CSS pixels) of the scene camera for a stage height. */
export function focalLength(height: number, fov = SCENE_FOV): number {
	return height / 2 / Math.max(Math.tan((fov * Math.PI) / 360), 1e-3);
}

/**
 * The camera target that shows `point` at the centre of the free area from
 * `distance` away (the free area is off-centre when the settings card or the
 * header take room).
 */
export function anchor(
	point: Vec3,
	basis: Basis,
	frame: CameraFrame,
	distance: number
): Vec3 {
	const { area, focal, height, width } = frame;
	const sx = (((area.left + area.right) / 2 - width / 2) * distance) / focal;
	const sy = (((area.top + area.bottom) / 2 - height / 2) * distance) / focal;
	return [
		point[0] - basis.right[0] * sx + basis.up[0] * sy,
		point[1] - basis.right[1] * sx + basis.up[1] * sy,
		point[2] - basis.right[2] * sx + basis.up[2] * sy,
	];
}

/**
 * Fit every node, and the label under it, inside the free area: each axis
 * on its own (so a portrait stage fills its height), with room for the
 * widest labels at the sides and one label line below the lowest node. The
 * camera never comes so close that a disc passes MAX_FIT_DISC_PX.
 */
export function fitCamera(
	layout: Layout,
	basis: Basis,
	frame: CameraFrame,
	labels: ReadonlyMap<string, HTMLElement>,
	minRadius: number,
	subset: ReadonlySet<number> | null = null
): { center: Vec3; distance: number } {
	const count = layout.ids.length;
	const local = new Float32Array(count * 3);
	const included = (index: number) => subset === null || subset.has(index);
	let minX = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	let minZ = Number.POSITIVE_INFINITY;
	let maxZ = Number.NEGATIVE_INFINITY;
	for (let index = 0; index < count; index += 1) {
		const point: Vec3 = [
			layout.positions[index * 3] ?? 0,
			layout.positions[index * 3 + 1] ?? 0,
			layout.positions[index * 3 + 2] ?? 0,
		];
		const x = dot(point, basis.right);
		const y = dot(point, basis.up);
		const z = dot(point, basis.back);
		local[index * 3] = x;
		local[index * 3 + 1] = y;
		local[index * 3 + 2] = z;
		if (!included(index)) {
			continue;
		}
		minX = Math.min(minX, x);
		maxX = Math.max(maxX, x);
		minY = Math.min(minY, y);
		maxY = Math.max(maxY, y);
		minZ = Math.min(minZ, z);
		maxZ = Math.max(maxZ, z);
	}
	if (minX > maxX) {
		minX = 0;
		maxX = 0;
		minY = 0;
		maxY = 0;
		minZ = 0;
		maxZ = 0;
	}
	const mx = (minX + maxX) / 2;
	const my = (minY + maxY) / 2;
	const mz = (minZ + maxZ) / 2;
	const { area, focal } = frame;
	const halfW = (area.right - area.left) / 2;
	const halfH = (area.bottom - area.top) / 2;
	let distance = (minRadius * focal) / Math.max(1, Math.min(halfW, halfH));
	for (let index = 0; index < count; index += 1) {
		if (!included(index)) {
			continue;
		}
		const radius = (layout.radii[index] ?? 0) * DISC_SCALE.scene;
		const x = Math.abs((local[index * 3] ?? 0) - mx) + radius;
		const y = (local[index * 3 + 1] ?? 0) - my;
		const z = (local[index * 3 + 2] ?? 0) - mz;
		const pad = labelPad(labelWidth(labels.get(layout.ids[index] ?? "")), area);
		const roomX = Math.max(24, halfW - pad);
		const roomY = Math.max(24, halfH - (y < 0 ? LABEL_BELOW : 6));
		distance = Math.max(
			distance,
			z + (x * focal) / roomX,
			z + ((Math.abs(y) + radius) * focal) / roomY,
			// At the graph's middle depth, no disc outgrows the cap.
			(radius * focal) / MAX_FIT_DISC_PX
		);
	}
	const center: Vec3 = [0, 0, 0];
	for (let axis = 0; axis < 3; axis += 1) {
		center[axis] =
			basis.right[axis as 0] * mx +
			basis.up[axis as 0] * my +
			basis.back[axis as 0] * mz;
	}
	return { center, distance: distance + SCENE_NEAR };
}

/** A camera pose: where it looks, from which direction and how far. */
export interface CameraPose {
	direction: Vec3;
	distance: number;
	target: Vec3;
}

/**
 * The pose the 3D view opens with: the whole graph fitted from the opening
 * direction. The scene's first frame and the loading outline both use it,
 * so the outline sits exactly where the nodes first draw.
 */
export function openingPose(
	layout: Layout,
	stage: { height: number; insetRight: number; width: number },
	labels: ReadonlyMap<string, HTMLElement>,
	linkDistance: number
): CameraPose {
	const basis = basisOf(INITIAL_DIRECTION);
	const frame: CameraFrame = {
		area: freeArea(stage.width, stage.height, stage.insetRight),
		focal: focalLength(stage.height),
		height: stage.height,
		width: stage.width,
	};
	const fit = fitCamera(layout, basis, frame, labels, linkDistance * 1.6);
	return {
		direction: INITIAL_DIRECTION,
		distance: fit.distance,
		target: anchor(fit.center, basis, frame, fit.distance),
	};
}

/** Per node: screen x, y and disc radius (CSS pixels) from a pose. */
export function projectPose(
	layout: Layout,
	pose: CameraPose,
	stage: { height: number; width: number },
	nodeSize: number
): [number, number, number][] {
	const basis = basisOf(pose.direction);
	const focal = focalLength(stage.height);
	const eye: Vec3 = [
		pose.target[0] + pose.direction[0] * pose.distance,
		pose.target[1] + pose.direction[1] * pose.distance,
		pose.target[2] + pose.direction[2] * pose.distance,
	];
	const result: [number, number, number][] = [];
	for (let index = 0; index < layout.ids.length; index += 1) {
		const offset: Vec3 = [
			(layout.positions[index * 3] ?? 0) - eye[0],
			(layout.positions[index * 3 + 1] ?? 0) - eye[1],
			(layout.positions[index * 3 + 2] ?? 0) - eye[2],
		];
		const depth = Math.max(SCENE_NEAR, -dot(offset, basis.back));
		const radius =
			(layout.radii[index] ?? 2) *
			nodeSize *
			DISC_SCALE.scene *
			(focal / depth);
		result.push([
			stage.width / 2 + (dot(offset, basis.right) * focal) / depth,
			stage.height / 2 - (dot(offset, basis.up) * focal) / depth,
			radius,
		]);
	}
	return result;
}
