// apps/desktop/src/lib/calendar/schedule-label.ts
//
// The human phrase for a scheduled job's schedule ("Daily at 9 AM"), shared by
// the Calendar, Agenda, Routines and Run history. `events.ts` re-exports it.
// Weekday names and hours come from Intl in the UI locale, never English
// tables, so "Weekly on Monday at 9 AM" reads "月曜日" / "9時" under Japanese.

import { dateFormatter } from "@ryu/i18n/format-intl";
import type { LiteralMessage } from "@ryu/i18n/react";
import { formatHourLabel, getDisplayLocale } from "@ryu/ui/lib/timezone.ts";
import type { Schedule } from "@/src/lib/api/schedules.ts";

// ── Schedule formatting ──────────────────────────────────────────────────────

const DAILY_CRON = /^0 (\d+) \* \* \*$/;
const WEEKLY_CRON = /^0 (\d+) \* \* (\d)$/;
/** A cron hour as the UI locale writes it ("9 AM", "9時", "9 Uhr"). */
const HOUR_ONLY: Intl.DateTimeFormatOptions = { hour: "numeric" };

/**
 * A cron weekday (0 = Sunday) in the UI locale, or the raw text when out of
 * range. 2 January 2000 was a Sunday; UTC keeps that date fixed in every zone.
 */
function cronWeekdayLabel(raw: string): string {
	const day = Number(raw);
	if (!Number.isInteger(day) || day < 0 || day > 6) {
		return raw;
	}
	return dateFormatter(getDisplayLocale(), {
		timeZone: "UTC",
		weekday: "long",
	}).format(new Date(Date.UTC(2000, 0, 2 + day)));
}

/** Human-readable phrase for a job's schedule, shared with the automations list. */
export function describeSchedule(
	schedule: Schedule,
	tl: LiteralMessage
): string {
	if (schedule.kind === "every") {
		const labels = new Map([
			["5m", tl("Every 5 minutes")],
			["10m", tl("Every 10 minutes")],
			["15m", tl("Every 15 minutes")],
			["30m", tl("Every 30 minutes")],
			["1h", tl("Every hour")],
			["3600", tl("Every hour")],
		]);
		return labels.get(schedule.interval) ?? tl("Every {interval}", schedule);
	}
	const expr = schedule.expr.trim();
	const daily = DAILY_CRON.exec(expr);
	if (daily) {
		return tl("Daily at {time}", {
			time: formatHourLabel(Number(daily[1]), HOUR_ONLY),
		});
	}
	const weekly = WEEKLY_CRON.exec(expr);
	if (weekly) {
		const day = cronWeekdayLabel(weekly[2]);
		return tl("Weekly on {day} at {time}", {
			day,
			time: formatHourLabel(Number(weekly[1]), HOUR_ONLY),
		});
	}
	return `cron: ${expr}`;
}
