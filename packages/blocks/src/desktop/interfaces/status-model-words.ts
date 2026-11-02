import { translate as tr } from "@ryu/i18n/lite";
import type { LiteralMessage } from "@ryu/i18n/react";
import type { UptimeDay } from "./status-model.ts";

/** A day level's label in the UI language. */
export function dayLevelLabel(
	level: UptimeDay["level"],
	tl: LiteralMessage = tr
): string {
	switch (level) {
		case "degraded":
			return tl("Partial outage");
		case "outage":
			return tl("Outage");
		default:
			return tl("No downtime recorded");
	}
}

/** Plain-language summary of one day, for the bar tooltip and its label. */
export function describeDay(day: UptimeDay, tl: LiteralMessage): string {
	if (day.level === "operational") {
		return tl("No downtime recorded on this day.");
	}
	return tl(
		"{level}: {count, plural, one {# failed run} other {# failed runs}}.",
		{
			count: day.problems.length,
			level: dayLevelLabel(day.level, tl),
		}
	);
}

/** What the day saw besides failures ("3 threads active, 1 scheduled run"). */
export function describeActivity(
	day: UptimeDay,
	tl: LiteralMessage = tr
): string | null {
	const parts: string[] = [];
	if (day.active > 0) {
		parts.push(
			tl("{count, plural, one {# thread active} other {# threads active}}", {
				count: day.active,
			})
		);
	}
	if (day.successfulRuns > 0) {
		parts.push(
			tl(
				"{count, plural, one {# scheduled run succeeded} other {# scheduled runs succeeded}}",
				{ count: day.successfulRuns }
			)
		);
	}
	return parts.length > 0 ? parts.join(", ") : null;
}
