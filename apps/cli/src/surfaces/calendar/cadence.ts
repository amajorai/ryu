// The Calendar agenda's cadence column, split from `index.tsx` so it can be
// tested without loading the surface router.

import type { ScheduledJob } from "@ryuhq/core-client/schedules";
import { everyIntervalLabel } from "../schedule-labels.ts";

/** A job's cadence; an empty expression shows the same placeholder as Tasks. */
export function cadenceLabel(job: ScheduledJob): string {
	const { schedule } = job;
	if (schedule.kind === "cron") {
		return schedule.expr.length > 0 ? schedule.expr : "—";
	}
	return schedule.interval.length > 0
		? everyIntervalLabel(schedule.interval)
		: "—";
}
