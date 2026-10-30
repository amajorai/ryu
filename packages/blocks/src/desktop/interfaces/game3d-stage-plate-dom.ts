import {
	type FitBox,
	fitBoxes,
	type PlateBox,
	plateFitBox,
} from "./game3d-plates.ts";
import type { IsoInsets, IsoPlateFit } from "./game3d-stage-framing.ts";

/** A portrait stage's zoom on to its plates, on top of the fitted view. */
export interface ContentFit {
	right: number;
	scale: number;
	up: number;
}

export const NO_CONTENT: ContentFit = { right: 0, scale: 1, up: 0 };
/** The furthest a portrait stage zooms on to its plates. */
const MAX_CONTENT_ZOOM = 1.8;
/** World units kept around the plates: sides, above, and below (bodies). */
export const CONTENT_PAD: Required<IsoPlateFit> = {
	above: 0.5,
	below: 2.4,
	max: MAX_CONTENT_ZOOM,
	side: 0.8,
};
export const CONTENT_WAIT_MS = 150;
export const CONTENT_TRIES = 60;
export const CONTENT_FRAMES = 3;
/** Under reduced motion, plates must not have mounted for this long before the fit. */
export const CONTENT_QUIET_MS = 450;

/**
 * How far to zoom and pan so the stage's plates (where the agents and the
 * things to press are) fill the room between the insets: `null` until
 * there are plates to measure.
 */
/**
 * The content fit that frames the plates, measured under the camera now in
 * use, which already carries the content fit `applied` (the result is
 * absolute, so a measure that runs before a reset reaches the camera still
 * lands on the same fit).
 */
export function plateFit(
	stage: Element,
	canvas: DOMRect,
	insets: IsoInsets,
	zoom: number,
	pad: Required<IsoPlateFit>,
	applied: ContentFit = NO_CONTENT,
	/** Maps plate centres (canvas px) into another camera's view first. */
	toView?: (points: [number, number][]) => [number, number][]
): ContentFit | null {
	holdPlateRoots(stage);
	const boxes: FitBox[] = [];
	for (const plate of stagePlates(stage)) {
		const own = plate.getBoundingClientRect();
		if (plate.offsetParent === null || own.width === 0) {
			continue;
		}
		// drei's root sits on the anchor the camera projects; a plate hung to
		// a side or a row up keeps a px offset from it that zoom must not scale.
		const root = plateRoot(plate)?.getBoundingClientRect();
		boxes.push(
			plateFitBox({
				anchor: root ? [root.left, root.top] : null,
				canvas,
				nudge: nudgeOf(plate),
				plate: own,
				reach: plateRect(plate),
			})
		);
	}
	return fitBoxes(
		boxes,
		{ height: canvas.height, insets, width: canvas.width },
		zoom,
		pad,
		applied,
		toView
	);
}

/** How often (ms) plates re-part while the scene moves. */
export const DECLUTTER_MS = 240;

/** The element to nudge for a plate: drei's centring wrapper, or itself. */
export function plateHolder(plate: HTMLElement): HTMLElement {
	const parent = plate.parentElement;
	if (parent?.style.transform.startsWith("translate3d(-50%")) {
		return parent;
	}
	return plate;
}

export const nudged = new WeakMap<HTMLElement, readonly [number, number]>();

/**
 * Runs `measure` with every plate's nudge removed, then restores them, all
 * in one task (no paint between). Only for instant nudges (reduced motion):
 * an animated nudge would start sliding.
 */
export function withoutNudges<T>(stage: Element, measure: () => T): T {
	const saved: [HTMLElement, string, readonly [number, number] | undefined][] =
		[];
	for (const plate of stagePlates(stage)) {
		for (const target of [plate, plate.parentElement]) {
			if (target && (target.style.translate || nudged.has(target))) {
				saved.push([target, target.style.translate, nudged.get(target)]);
				// No slide: a leftover transition would report the old nudge.
				target.style.transition = "none";
				target.style.translate = "";
				nudged.delete(target);
			}
		}
	}
	try {
		return measure();
	} finally {
		for (const [target, translate, nudge] of saved) {
			target.style.translate = translate;
			if (nudge) {
				nudged.set(target, nudge);
			}
		}
	}
}

/** A `translate` value's x and y in px ("none" and "" read as 0). */
function translateOf(value: string | undefined): [number, number] {
	const [x = "0", y = "0"] = !value || value === "none" ? [] : value.split(" ");
	return [Number.parseFloat(x) || 0, Number.parseFloat(y) || 0];
}

/** Whether any plate's nudge is still sliding toward where it was set. */
export function nudgeSliding(stage: Element): boolean {
	for (const plate of stagePlates(stage)) {
		const holder = plateHolder(plate);
		const target = nudged.get(holder);
		if (!target) {
			continue;
		}
		const [x, y] = translateOf(getComputedStyle(holder).translate);
		if (Math.abs(x - target[0]) > 0.5 || Math.abs(y - target[1]) > 0.5) {
			return true;
		}
	}
	return false;
}

/** An agent's name plate where it rests (its nudge taken out), in px. */
export interface NamedPlate {
	agent: string;
	bottom: number;
	height: number;
	left: number;
	width: number;
}

/**
 * Every villager figure in `stage` as a fixed PlateBox. From the head and
 * feet probes (`data-act-figure`, `data-figure-edge`) where the kit marks
 * them: head to feet tall, a little over a quarter of that wide (at least
 * 24px). An agent with a name plate (`data-act-agent`) but no probes (a
 * game's own creatures or cars) gets the checker's estimate: the plate's
 * width, from its bottom down 2.5 plate heights.
 */
export function figureBoxes(
	stage: Element,
	named: readonly NamedPlate[] = []
): PlateBox[] {
	const edges = new Map<string, { feet?: DOMRect; head?: DOMRect }>();
	for (const probe of stage.querySelectorAll<HTMLElement>(
		"[data-act-figure][data-figure-edge]"
	)) {
		// Its own drei root: hold it still too, so it measures where drei put it.
		const root = plateRoot(probe);
		if (root && root.style.transition !== "none") {
			root.style.transition = "none";
		}
		const id = probe.dataset.actFigure ?? "";
		const edge = probe.dataset.figureEdge;
		const entry = edges.get(id) ?? {};
		if (edge === "head" || edge === "feet") {
			entry[edge] = probe.getBoundingClientRect();
		}
		edges.set(id, entry);
	}
	const boxes: PlateBox[] = [];
	for (const plate of named) {
		if (!plate.agent || edges.has(plate.agent)) {
			continue;
		}
		const tall = plate.height * 2.5;
		boxes.push({
			figure: true,
			height: tall,
			width: plate.width,
			x: plate.left + plate.width / 2,
			y: plate.bottom + tall / 2,
		});
	}
	for (const { feet, head } of edges.values()) {
		if (!(feet && head)) {
			continue;
		}
		const tall = Math.max(8, feet.top - head.top);
		boxes.push({
			figure: true,
			height: tall,
			width: Math.max(24, tall * 0.56),
			x: (head.left + feet.left) / 2,
			y: head.top + tall / 2,
		});
	}
	return boxes;
}

/** The stage's HUD insets (px), from `data-iso-insets` ("top right bottom left"). */
export function stageInsets(stage: Element): IsoInsets {
	const [top = 0, right = 0, bottom = 0, left = 0] = (
		stage.getAttribute("data-iso-insets") ?? ""
	)
		.split(" ")
		.map(Number)
		.map((value) => (Number.isFinite(value) ? value : 0));
	return { bottom, left, right, top };
}

/** The nudge on a plate now: on the plate itself and/or drei's wrapper. */
export function nudgeOf(plate: HTMLElement): [number, number] {
	const own = nudged.get(plate) ?? [0, 0];
	const holder = plateHolder(plate);
	const wrap = holder === plate ? [0, 0] : (nudged.get(holder) ?? [0, 0]);
	return [own[0] + (wrap[0] ?? 0), own[1] + (wrap[1] ?? 0)];
}

/**
 * A plate's box including its speech bubble, which hangs outside the plate
 * (absolutely placed) and moves with it.
 */
export function plateRect(plate: HTMLElement): DOMRect {
	const rect = plate.getBoundingClientRect();
	const bubble = plate
		.querySelector("[data-life-bubble]")
		?.getBoundingClientRect();
	if (!bubble || bubble.width === 0 || rect.width === 0) {
		return rect;
	}
	const left = Math.min(rect.left, bubble.left);
	const top = Math.min(rect.top, bubble.top);
	return new DOMRect(
		left,
		top,
		Math.max(rect.right, bubble.right) - left,
		Math.max(rect.bottom, bubble.bottom) - top
	);
}

/**
 * drei's Html root for a plate: the element whose `translate3d(x, y, 0)`
 * puts the plate's anchor where the camera projects it. `null` for a plate
 * outside drei.
 */
export function plateRoot(plate: HTMLElement): HTMLElement | null {
	let root: HTMLElement | null = plate;
	for (let depth = 0; root && depth < 4; depth++) {
		if (
			root.style.transform.startsWith("translate3d(") &&
			!root.style.transform.startsWith("translate3d(-50%")
		) {
			return root;
		}
		root = root.parentElement;
	}
	return null;
}

/**
 * Stops drei's Html roots from transitioning. The reduced-motion catch-all
 * gives every element a 0.01ms transition, which ends only on the browser's
 * next rendered frame: until then a root measures where the previous camera
 * put it, so a demand canvas would report (and part) plates at a stale spot
 * and see them jump a frame later. Without a transition the root is where
 * drei put it as soon as drei writes it.
 */
export function holdPlateRoots(stage: Element) {
	for (const plate of stagePlates(stage)) {
		const root = plateRoot(plate);
		if (root && root.style.transition !== "none") {
			root.style.transition = "none";
		}
	}
}

/**
 * What plate separation parts: kit plates, and any game-owned you-spot
 * overlay (a queue plate that is not a kit plate still keeps YOU_SPOT_GAP).
 */
const PLATE_OR_YOU_SPOT =
	"[data-iso-target], [data-iso-plate], [data-you-spot]";

/**
 * The plates separation, the content fit and the no-nudge measure all work
 * on (one list, so they never disagree): every kit plate and you-spot,
 * except a queue overlay inside a plate, which moves with that plate.
 */
export function stagePlates(stage: Element): HTMLElement[] {
	return [...stage.querySelectorAll<HTMLElement>(PLATE_OR_YOU_SPOT)].filter(
		(plate) => !plate.parentElement?.closest(PLATE_OR_YOU_SPOT)
	);
}

/** Separation passes after a change, until nothing moves (a static frame). */
export const SETTLE_PASSES = 6;
/**
 * Reduced motion: settles retried (CONTENT_WAIT_MS apart) while plates still
 * move, before the stage reads `data-iso-fit="unsettled"`.
 */
export const SETTLE_RETRIES = 40;

/**
 * The stage's fit status, for checks and screenshots to wait on: `pending`
 * (rendered from the start), `done` once a frame with the final camera is
 * drawn and its plates have parted (reduced motion: a pass moved nothing),
 * `unsettled` if they never stop, `none` with no WebGL.
 */
export function markFit(
	stage: Element | null | undefined,
	status: "done" | "pending" | "unsettled"
) {
	if (stage instanceof HTMLElement && stage.dataset.isoFit !== status) {
		stage.dataset.isoFit = status;
	}
}
