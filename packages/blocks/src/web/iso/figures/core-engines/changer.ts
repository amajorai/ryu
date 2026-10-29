import type { Phase } from "./model.ts";
import {
	CLEAR,
	DECK_SEAT,
	DECK_X,
	engineX,
	RACK_SEAT,
	TRAVEL,
} from "./view.ts";

/*
 * The changer: an unseen hand that swaps engine cartridges between the shelf and the
 * player. It follows `set_active_local_engine` (apps/core/src/sidecar/manager.rs:539):
 * the resident engine is taken out and put back on its slot first, and only then is
 * the requested one fetched and seated. One swap runs at a time; a pick made during a
 * swap waits for it to finish, as the real swap holds one lock throughout.
 */

export interface Step {
	act: "take" | "drop" | null;
	h: number;
	index: number;
	phase: Exclude<Phase, "loaded">;
	x: number;
}

export interface Changer {
	duration: number;
	dwell: number;
	elapsed: number;
	from: { x: number; h: number };
	h: number;
	holding: number | null;
	loaded: number | null;
	steps: Step[];
	x: number;
}

const ACROSS = 150;
const UPDOWN = 60;
const SETTLE = 0.16;
/** A take starts where the cartridge sits, so the unseen hand arrives at once. */
const TAKE = 0.001;
const DWELL = 0.22;

export function changerAt(loaded: number | null): Changer {
	return {
		x: DECK_X,
		h: DECK_SEAT,
		holding: null,
		loaded,
		steps: [],
		from: { x: DECK_X, h: DECK_SEAT },
		elapsed: 0,
		duration: 0,
		dwell: 0,
	};
}

/*
 * Nothing carries the cartridges on screen, so a take happens where the cartridge
 * already sits: it rises straight up, travels above the shelf, and comes down.
 */
const takeAt = (
	x: number,
	seat: number,
	index: number,
	phase: Step["phase"]
): Step[] => [
	{ x, h: seat, act: "take", index, phase },
	{ x, h: TRAVEL, act: null, index, phase },
];

const dropAt = (
	x: number,
	seat: number,
	index: number,
	phase: Step["phase"]
): Step[] => [
	{ x, h: TRAVEL, act: null, index, phase },
	{ x, h: seat, act: "drop", index, phase },
];

/** The route to unload `loaded` (if any) and load `target`. */
export function planSwap(loaded: number | null, target: number): Step[] {
	if (loaded === target) {
		return [];
	}
	const steps: Step[] = [];
	if (loaded !== null) {
		steps.push(
			...takeAt(DECK_X, DECK_SEAT, loaded, "unloading"),
			...dropAt(engineX(loaded), RACK_SEAT, loaded, "unloading")
		);
	}
	steps.push(
		...takeAt(engineX(target), RACK_SEAT, target, "loading"),
		...dropAt(DECK_X, DECK_SEAT, target, "loading")
	);
	return steps;
}

export function begin(changer: Changer, steps: Step[]) {
	changer.steps = steps;
	changer.elapsed = 0;
	changer.duration = 0;
	changer.dwell = 0;
}

const smoother = (t: number) => {
	const u = Math.min(1, Math.max(0, t));
	return u * u * u * (u * (u * 6 - 15) + 10);
};

function durationOf(from: { x: number; h: number }, to: Step) {
	if (to.act === "take") {
		return TAKE;
	}
	return (
		SETTLE + Math.abs(to.x - from.x) / ACROSS + Math.abs(to.h - from.h) / UPDOWN
	);
}

function arrive(changer: Changer, step: Step) {
	changer.x = step.x;
	changer.h = step.h;
	if (step.act === "take") {
		changer.holding = step.index;
		if (step.x === DECK_X) {
			changer.loaded = null;
		}
	}
	if (step.act === "drop") {
		if (step.x === DECK_X) {
			changer.loaded = step.index;
		}
		changer.holding = null;
	}
}

/** Advances the changer by `dt` seconds. Returns true while it still has work. */
export function advance(changer: Changer, dt: number, calm: boolean): boolean {
	if (calm) {
		for (const step of changer.steps) {
			arrive(changer, step);
		}
		changer.steps = [];
		return false;
	}
	let left = dt;
	while (left > 0 && changer.steps.length > 0) {
		const step = changer.steps[0];
		if (!step) {
			break;
		}
		if (changer.duration === 0) {
			changer.from = { x: changer.x, h: changer.h };
			changer.duration = durationOf(changer.from, step);
			changer.elapsed = 0;
		}
		if (changer.elapsed < changer.duration) {
			const used = Math.min(left, changer.duration - changer.elapsed);
			changer.elapsed += used;
			left -= used;
			const share = smoother(changer.elapsed / changer.duration);
			changer.x = changer.from.x + (step.x - changer.from.x) * share;
			changer.h = changer.from.h + (step.h - changer.from.h) * share;
			if (changer.elapsed < changer.duration) {
				break;
			}
			arrive(changer, step);
			changer.dwell = step.act ? DWELL : 0;
		}
		const rest = Math.min(left, changer.dwell);
		changer.dwell -= rest;
		left -= rest;
		if (changer.dwell > 0) {
			break;
		}
		changer.steps.shift();
		changer.duration = 0;
	}
	return changer.steps.length > 0;
}

export function phaseOf(changer: Changer): { phase: Phase; moving: number } {
	const step = changer.steps[0];
	if (!step) {
		return { phase: "loaded", moving: changer.loaded ?? 0 };
	}
	return { phase: step.phase, moving: step.index };
}

export interface Layout {
	/** Slots whose cartridge is drawn elsewhere (in the player or moving). */
	away: number[];
	/** The cartridge drawn by the moving layer, at a world offset from the player seat. */
	carried: { index: number; dx: number; dz: number } | null;
	/** A shelf cartridge lifted inside its own slot, and by how much. */
	lifted: { index: number; dz: number } | null;
}

/**
 * Which copy of a cartridge to draw. Inside the shelf, below the tops of its
 * neighbours, a cartridge is drawn in its own slot so the nearer ones still cover
 * it; above them, and anywhere over the player, it is drawn by the moving layer.
 */
export function layoutOf(changer: Changer): Layout {
	const away: number[] = [];
	let lifted: Layout["lifted"] = null;
	let carried: Layout["carried"] = null;
	if (changer.loaded !== null) {
		away.push(changer.loaded);
		carried = { index: changer.loaded, dx: 0, dz: 0 };
	}
	const held = changer.holding;
	if (held !== null) {
		const inSlot =
			Math.abs(changer.x - engineX(held)) < 0.01 && changer.h < CLEAR;
		if (inSlot) {
			lifted = { index: held, dz: changer.h - RACK_SEAT };
		} else {
			away.push(held);
			carried = {
				index: held,
				dx: changer.x - DECK_X,
				dz: changer.h - DECK_SEAT,
			};
		}
	}
	return { lifted, carried, away };
}
