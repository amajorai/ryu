import { ACTIVITY_HOURS, HOUR_MS } from "./mission-control-model-types.ts";

export function timeOf(iso: string | null | undefined): number {
	if (!iso) {
		return Number.NaN;
	}
	return Date.parse(iso);
}

/** Local start of the hour containing `now`. */
export function hourStart(now: number): number {
	const date = new Date(now);
	date.setMinutes(0, 0, 0);
	return date.getTime();
}

/** Hour starts for the trailing window, oldest first, ending with this hour. */
export function hourlyStarts(now: number, hours = ACTIVITY_HOURS): number[] {
	const current = hourStart(now);
	const starts: number[] = [];
	for (let offset = hours - 1; offset >= 0; offset -= 1) {
		starts.push(current - offset * HOUR_MS);
	}
	return starts;
}

/**
 * Which hourly bucket a timestamp falls in, or -1 outside the window. Small
 * clock skew into the future counts as the current hour.
 */
export function hourIndex(starts: readonly number[], at: number): number {
	const first = starts[0];
	if (first === undefined || Number.isNaN(at) || at < first) {
		return -1;
	}
	const last = starts.length - 1;
	return Math.min(last, Math.floor((at - first) / HOUR_MS));
}

export function hourlyCounts(
	starts: readonly number[],
	times: Iterable<number>
): number[] {
	const counts = starts.map(() => 0);
	for (const at of times) {
		const index = hourIndex(starts, at);
		if (index >= 0) {
			counts[index] = (counts[index] ?? 0) + 1;
		}
	}
	return counts;
}
