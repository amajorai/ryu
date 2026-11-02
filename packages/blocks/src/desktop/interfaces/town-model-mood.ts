import {
	type InterfaceAsk,
	type InterfaceThread,
	waitBand,
} from "@ryuhq/protocol/interfaces";

/** Activity (summed weights) at which a district reads as fully busy. */
export const ACTIVITY_FULL = 3;

/** Steps of the activity view, like a city builder's data-view bins. */
export const HEAT_STEPS = 4;

/**
 * Heat for each district: spread over the min to max of the districts on
 * the map in `HEAT_STEPS` bins, so a busier district always reads warmer,
 * and capped by how busy the busiest one is against `full` so a sleepy
 * town never glows. Near-equal districts keep their absolute level, and a
 * district with no activity is always zero.
 */
export function heatLevels(values: number[], full: number): number[] {
	if (values.length === 0) {
		return [];
	}
	const max = Math.max(...values);
	const min = Math.min(...values);
	const absolute = values.map((value) =>
		Math.min(1, Math.max(0, value) / full)
	);
	if (max - min < full * 0.05) {
		return absolute;
	}
	const top = Math.min(1, max / full);
	return values.map((value) => {
		// A district with no activity stays cold however busy its neighbours.
		if (value <= 0) {
			return 0;
		}
		const step =
			Math.round(((value - min) / (max - min)) * HEAT_STEPS) / HEAT_STEPS;
		return top * (0.12 + 0.88 * step);
	});
}

/** The lowest "needs you" level a district with anything waiting shows. */
export const NEEDS_FLOOR = 0.4;

/**
 * "Needs you" for a district against the one with most waiting: zero when
 * settled, and never fainter than `NEEDS_FLOOR` once anything is waiting,
 * so one petition always reads apart from none.
 */
export function needsLevel(value: number, max: number): number {
	if (value <= 0 || max <= 0) {
		return 0;
	}
	return NEEDS_FLOOR + (1 - NEEDS_FLOOR) * (value / max);
}

/** How fresh a conversation is, for the activity view: a live run counts most. */
export function activityWeight(thread: InterfaceThread, now: number): number {
	if (thread.running) {
		return 2;
	}
	const age = now - Date.parse(thread.updatedAt);
	if (Number.isNaN(age)) {
		return 0;
	}
	const hour = 3_600_000;
	if (age < hour) {
		return 0.8;
	}
	if (age < 24 * hour) {
		return 0.5;
	}
	if (age < 7 * 24 * hour) {
		return 0.2;
	}
	return 0.05;
}

/** Happiness: 100 with nothing waiting, falling with backlog and failures. */
export function happiness(
	population: number,
	yourTurn: number,
	attention: number
): number {
	if (population === 0) {
		return 100;
	}
	const load = (yourTurn + attention * 2) / (population + 4);
	return Math.round(100 * Math.min(1, Math.max(0, 1 - load)));
}

/** How much one blocking ask weighs on the town, by how long it has waited. */
const ASK_WEIGHT: Record<ReturnType<typeof waitBand>, number> = {
	expiring: 12,
	fresh: 3,
	long: 10,
	stale: 15,
	unknown: 5,
	waiting: 6,
};

/**
 * Happiness with the act layer: 100 with nothing blocking, falling with
 * every blocking ask, more the longer it has waited (its wait band).
 */
export function actHappiness(
	asks: readonly InterfaceAsk[] | undefined,
	nowMs: number
): number {
	let load = 0;
	for (const ask of asks ?? []) {
		if (!ask.blocking) {
			continue;
		}
		const band = waitBand(
			ask.since ? Date.parse(ask.since) : null,
			nowMs,
			ask.expiresAt ? Date.parse(ask.expiresAt) : null
		);
		load += ASK_WEIGHT[band];
	}
	return Math.max(0, 100 - load);
}
