import {
	APPROVAL,
	CONDITION,
	INPUT,
	NODE_COUNT,
	OUTPUT,
	PATH,
	WEBHOOK,
} from "./model.ts";

/**
 * A pure, slowed simulation of one run moving through the executor, stepped by the live
 * component as a quiet loop. It follows the model's rules (one node at a time, a
 * checkpoint after each node, the untaken branch skipped, the run held at the approval
 * gate until it is approved) but its timings are the figure's, not Core's. The figure
 * approves the gate itself after a short wait.
 */

export type Phase =
	| "spawn"
	| "run"
	| "check"
	| "roll"
	| "await"
	| "release"
	| "done";

export interface Sim {
	/** The node the marble is at, or leaving. */
	at: number;
	/** Completed nodes: the checkpoints on disk. */
	completed: boolean[];
	phase: Phase;
	/** The webhook branch has been pruned. */
	skipped: boolean;
	t: number;
	/** The node the marble is rolling to. */
	to: number;
}

/** Seconds each phase lasts in the figure: slow, so the loop reads as ambient. */
export const DURATION = {
	spawn: 0.9,
	run: 1.1,
	check: 0.5,
	await: 2.2,
	release: 0.6,
	done: 3.2,
} as const;

export function newSim(): Sim {
	return {
		phase: "spawn",
		t: 0,
		at: INPUT,
		to: INPUT,
		completed: Array.from({ length: NODE_COUNT }, () => false),
		skipped: false,
	};
}

/** A run that has finished, for the rest pose and reduced motion. */
export function finishedSim(): Sim {
	const sim = newSim();
	for (const node of PATH) {
		sim.completed[node] = true;
	}
	sim.skipped = true;
	sim.phase = "done";
	sim.at = OUTPUT;
	sim.to = OUTPUT;
	return sim;
}

const nextOnPath = (node: number) => {
	const index = PATH.indexOf(node);
	return PATH[index + 1] ?? node;
};

function enter(sim: Sim, phase: Phase) {
	sim.phase = phase;
	sim.t = 0;
}

/**
 * Advance by `dt` seconds. `rollTime(from, to)` is how long the roll between them takes.
 * Returns true when the run has finished and held its last frame long enough to start over.
 */
export function step(
	sim: Sim,
	dt: number,
	rollTime: (from: number, to: number) => number
) {
	sim.t += dt;
	switch (sim.phase) {
		case "spawn":
			if (sim.t >= DURATION.spawn) {
				enter(sim, "run");
			}
			return false;
		case "run":
			if (sim.t >= DURATION.run) {
				if (sim.at === APPROVAL) {
					enter(sim, "await");
					return false;
				}
				enter(sim, "check");
				sim.completed[sim.at] = true;
				if (sim.at === CONDITION) {
					sim.skipped = true;
				}
			}
			return false;
		case "await":
			if (sim.t >= DURATION.await) {
				// Approving flips the gate to Completed and persists it before the run goes on.
				sim.completed[APPROVAL] = true;
				enter(sim, "release");
			}
			return false;
		case "release":
			if (sim.t >= DURATION.release) {
				enter(sim, "check");
			}
			return false;
		case "check":
			if (sim.t >= DURATION.check) {
				if (sim.at === OUTPUT) {
					enter(sim, "done");
					return false;
				}
				sim.to = nextOnPath(sim.at);
				enter(sim, "roll");
			}
			return false;
		case "roll":
			if (sim.t >= rollTime(sim.at, sim.to)) {
				sim.at = sim.to;
				enter(sim, "run");
			}
			return false;
		default:
			return sim.t >= DURATION.done;
	}
}

/** A node's state, for the value text when the reader picks a node. */
export function statusOf(sim: Sim, node: number): string {
	if (node === WEBHOOK && sim.skipped) {
		return "skipped";
	}
	if (sim.completed[node]) {
		return "completed, checkpoint saved";
	}
	const here = sim.at === node && sim.phase !== "roll";
	if (here && sim.phase === "await") {
		return "awaiting input";
	}
	if (here) {
		return "running";
	}
	return "pending";
}
