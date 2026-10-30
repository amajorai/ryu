import {
	type InterfaceAgentAct,
	type InterfaceAsk,
	waitBand,
} from "@ryuhq/protocol/interfaces";
import type { FarmField } from "./farm-model.ts";

/** An estimate's growth snaps to twelfths, so it re-grows a crop now and then, not every tick. */
const GROWTH_STEPS = 12;

/**
 * A working act's focus-crop growth (0..1): a plan's exact steps, or an
 * estimate snapped to twelfths (its `done` moves every second); else null.
 */
export function actGrowth(act: InterfaceAgentAct): number | null {
	const progress = act.progress;
	if (!(act.threadId && progress && progress.total > 0)) {
		return null;
	}
	const share = progress.done / progress.total;
	return progress.kind === "estimate"
		? Math.round(share * GROWTH_STEPS) / GROWTH_STEPS
		: share;
}

/** Fallen fruit for a reply waiting by its wait band (0 fresh to 3 stale). */
const FALLEN: Record<ReturnType<typeof waitBand>, number> = {
	expiring: 3,
	fresh: 0,
	long: 2,
	stale: 3,
	unknown: 0,
	waiting: 1,
};

/** How over-ripe each unread reply's crop is, by thread id. */
export function overripeReplies(
	asks: readonly InterfaceAsk[] | undefined,
	nowMs: number
): Map<string, number> {
	const fallen = new Map<string, number>();
	for (const ask of asks ?? []) {
		if (ask.kind !== "reply" || !ask.threadId) {
			continue;
		}
		const band = waitBand(
			ask.since ? Date.parse(ask.since) : null,
			nowMs,
			ask.expiresAt ? Date.parse(ask.expiresAt) : null
		);
		fallen.set(ask.threadId, FALLEN[band]);
	}
	return fallen;
}

/**
 * The fields with each working farmer's focus crop grown to its plan's
 * steps (`growth`: exact steps, or the kit's estimate, since a guess still
 * grows the crop; a run with no progress at all keeps its own height),
 * and each unread reply's crop over-ripened by how long it has waited.
 */
export function growFocusCrops(
	fields: readonly FarmField[],
	acts: ReadonlyMap<string, InterfaceAgentAct>,
	overripe: ReadonlyMap<string, number> = new Map()
): FarmField[] {
	const growth = new Map<string, number>();
	for (const act of acts.values()) {
		const value = actGrowth(act);
		if (act.threadId && value !== null) {
			growth.set(act.threadId, value);
		}
	}
	if (growth.size === 0 && overripe.size === 0) {
		return [...fields];
	}
	return fields.map((field) => ({
		...field,
		plots: field.plots.map((plot) => {
			const grow = <T extends { thread: { id: string } }>(crop: T) => {
				const value = growth.get(crop.thread.id);
				const fallen = overripe.get(crop.thread.id);
				return {
					...crop,
					...(value === undefined ? {} : { growth: value }),
					...(fallen ? { overripe: fallen } : {}),
				};
			};
			return {
				...plot,
				crops: plot.crops.map(grow),
				planted: plot.planted.map((entry) => ({
					...entry,
					crop: grow(entry.crop),
				})),
			};
		}),
	}));
}
