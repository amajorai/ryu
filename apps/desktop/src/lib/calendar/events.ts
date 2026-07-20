// apps/desktop/src/lib/calendar/events.ts
//
// Turns the scheduled jobs returned by Core (`useSchedules`) into dated calendar
// events for the Calendar page. Two sources feed the calendar:
//
//   • Past runs    — real executions from `job.history` (Core keeps up to 50 per
//                    job), each carrying a success/failure outcome.
//   • Upcoming runs — projected fire times computed from the job's schedule:
//                    cron expressions via `cron-parser` (UTC, matching Core's
//                    scheduler), fixed intervals via simple stepping.
//
// Cron and intervals are evaluated in UTC because Core's scheduler runs in UTC
// (the create dialog labels its hour picker "UTC"). The resulting `Date`s are
// absolute instants; the calendar renders them in the user's local zone.
//
// High-frequency schedules (sub-hourly intervals, or cron expressions that fire
// many times a day) would flood a month grid with thousands of cells, so those
// are collapsed into one aggregate marker per day carrying a run count instead
// of one event per fire.

import { CronExpressionParser } from "cron-parser";
import type {
	ExecOutcome,
	Schedule,
	ScheduledJob,
} from "@/src/lib/api/schedules.ts";

export type CalendarEventKind = "past" | "upcoming";

export interface CalendarEvent {
	/** Agent id for agent-target jobs (workflow jobs have none). */
	agentId?: string;
	/**
	 * When set, this event stands in for `aggregateCount` collapsed runs in a
	 * single day (used for high-frequency schedules to keep the grid readable).
	 */
	aggregateCount?: number;
	/** Error message for a failed past run, if any. */
	error?: string | null;
	/** Stable id, unique within a render. */
	id: string;
	jobId: string;
	jobName: string;
	kind: CalendarEventKind;
	/** Present only for past runs. */
	outcome?: ExecOutcome;
	/** Human schedule phrase, e.g. "Daily at 9 AM". */
	scheduleLabel: string;
	/** When the run happened (past) or is projected to happen (upcoming). */
	start: Date;
	/** True when the run belongs to an internal Core maintenance job. */
	system?: boolean;
	/** Workflow id for workflow-target jobs (agent jobs have none). */
	workflowId?: string;
	/**
	 * Resolved workflow name for workflow-target jobs, when a name map is
	 * supplied to {@link buildCalendarEvents}. Falls back to undefined (the
	 * display then shows a generic "workflow" label).
	 */
	workflowName?: string;
}

// ── Target identification ────────────────────────────────────────────────────

interface TargetInfo {
	agentId?: string;
	system?: boolean;
	workflowId?: string;
	workflowName?: string;
}

/**
 * Derive the display target of a job's runs: a system marker for Core's
 * internal maintenance jobs, the agent id for agent jobs, or the workflow id
 * (plus its resolved name, when `workflowNames` supplies one) for workflow
 * jobs.
 */
function targetInfo(
	job: ScheduledJob,
	workflowNames?: Map<string, string>
): TargetInfo {
	if (job.system) {
		return { system: true };
	}
	if (job.target.type === "workflow") {
		const workflowId = job.target.workflowId;
		return { workflowId, workflowName: workflowNames?.get(workflowId) };
	}
	return { agentId: job.target.agentId };
}

// ── Schedule formatting ──────────────────────────────────────────────────────

const DAYS_OF_WEEK = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
];

const DAILY_CRON = /^0 (\d+) \* \* \*$/;
const WEEKLY_CRON = /^0 (\d+) \* \* (\d)$/;

function formatHour(h: number): string {
	if (h === 0) {
		return "12 AM";
	}
	if (h === 12) {
		return "12 PM";
	}
	return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

/** Human-readable phrase for a job's schedule, shared with the automations list. */
export function describeSchedule(schedule: Schedule): string {
	if (schedule.kind === "every") {
		const map: Record<string, string> = {
			"5m": "Every 5 minutes",
			"10m": "Every 10 minutes",
			"15m": "Every 15 minutes",
			"30m": "Every 30 minutes",
			"1h": "Every hour",
			"3600": "Every hour",
		};
		return map[schedule.interval] ?? `Every ${schedule.interval}`;
	}
	const expr = schedule.expr.trim();
	const daily = DAILY_CRON.exec(expr);
	if (daily) {
		return `Daily at ${formatHour(Number(daily[1]))}`;
	}
	const weekly = WEEKLY_CRON.exec(expr);
	if (weekly) {
		const day = DAYS_OF_WEEK[Number(weekly[2])] ?? weekly[2];
		return `Weekly on ${day} at ${formatHour(Number(weekly[1]))}`;
	}
	return `cron: ${expr}`;
}

// ── Interval parsing ─────────────────────────────────────────────────────────

const INTERVAL_RE = /^(\d+)\s*(s|m|h|d)?$/;

/** Parse Core's humantime-ish intervals ("5m", "30s", "1h", or bare seconds). */
function parseIntervalSeconds(interval: string): number | null {
	const match = INTERVAL_RE.exec(interval.trim());
	if (!match) {
		return null;
	}
	const value = Number(match[1]);
	if (!Number.isFinite(value) || value <= 0) {
		return null;
	}
	switch (match[2]) {
		case "s":
		case undefined:
			return value;
		case "m":
			return value * 60;
		case "h":
			return value * 3600;
		case "d":
			return value * 86_400;
		default:
			return null;
	}
}

// ── Occurrence projection ────────────────────────────────────────────────────

// Anything that would fire more than this many times within the window is
// collapsed to a per-day count rather than rendered as individual events.
const HIGH_FREQUENCY_SECONDS = 3600; // sub-hourly intervals aggregate
const MAX_OCCURRENCES_PER_JOB = 500; // hard cap so a "* * * * *" cron can't run away

const MS_PER_DAY = 86_400_000;

function dayKey(d: Date): string {
	return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function startOfLocalDay(d: Date): Date {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Projected fire times for an interval job within [windowStart, windowEnd). */
function intervalOccurrences(
	job: ScheduledJob,
	stepSeconds: number,
	windowStart: Date,
	windowEnd: Date,
	workflowNames?: Map<string, string>
): CalendarEvent[] {
	const stepMs = stepSeconds * 1000;
	const anchorIso = job.lastRunAt ?? job.createdAt;
	const anchorMs = new Date(anchorIso).getTime();
	const startMs = windowStart.getTime();
	const endMs = windowEnd.getTime();
	const label = describeSchedule(job.schedule);
	const target = targetInfo(job, workflowNames);

	// First occurrence at or after the window start, aligned to the anchor.
	const base = Number.isFinite(anchorMs) ? anchorMs : startMs;
	let firstMs = base;
	if (firstMs < startMs) {
		const steps = Math.ceil((startMs - firstMs) / stepMs);
		firstMs += steps * stepMs;
	}

	// High-frequency: one aggregate marker per day with a count.
	if (stepSeconds < HIGH_FREQUENCY_SECONDS) {
		const events: CalendarEvent[] = [];
		for (
			let cursor = startOfLocalDay(windowStart).getTime();
			cursor < endMs;
			cursor += MS_PER_DAY
		) {
			const dayStart = Math.max(cursor, firstMs);
			const dayEnd = cursor + MS_PER_DAY;
			if (dayStart >= dayEnd) {
				continue;
			}
			const count = Math.floor((dayEnd - 1 - dayStart) / stepMs) + 1;
			if (count <= 0) {
				continue;
			}
			const noonOfDay = new Date(cursor + MS_PER_DAY / 2);
			events.push({
				id: `${job.id}-agg-${cursor}`,
				jobId: job.id,
				jobName: job.name,
				start: noonOfDay,
				kind: "upcoming",
				...target,
				scheduleLabel: label,
				aggregateCount: count,
			});
		}
		return events;
	}

	const events: CalendarEvent[] = [];
	for (
		let ms = firstMs;
		ms < endMs && events.length < MAX_OCCURRENCES_PER_JOB;
		ms += stepMs
	) {
		events.push({
			id: `${job.id}-${ms}`,
			jobId: job.id,
			jobName: job.name,
			start: new Date(ms),
			kind: "upcoming",
			...target,
			scheduleLabel: label,
		});
	}
	return events;
}

/** Projected fire times for a cron job within [windowStart, windowEnd). */
function cronOccurrences(
	job: ScheduledJob,
	expr: string,
	windowStart: Date,
	windowEnd: Date,
	workflowNames?: Map<string, string>
): CalendarEvent[] {
	const label = describeSchedule(job.schedule);
	const target = targetInfo(job, workflowNames);
	let fires: Date[];
	try {
		const iter = CronExpressionParser.parse(expr, {
			currentDate: windowStart,
			endDate: windowEnd,
			tz: "UTC",
		});
		fires = iter.take(MAX_OCCURRENCES_PER_JOB).map((d) => d.toDate());
	} catch {
		// Unparseable cron — surface nothing rather than crashing the calendar.
		return [];
	}

	// Collapse to a per-day count when a cron fires many times in one day.
	const perDay = new Map<string, Date[]>();
	for (const fire of fires) {
		const key = dayKey(fire);
		const bucket = perDay.get(key);
		if (bucket) {
			bucket.push(fire);
		} else {
			perDay.set(key, [fire]);
		}
	}

	const events: CalendarEvent[] = [];
	for (const [, dayFires] of perDay) {
		if (dayFires.length > 6) {
			const noon = startOfLocalDay(dayFires[0]);
			noon.setHours(12);
			events.push({
				id: `${job.id}-cronagg-${dayKey(dayFires[0])}`,
				jobId: job.id,
				jobName: job.name,
				start: noon,
				kind: "upcoming",
				...target,
				scheduleLabel: label,
				aggregateCount: dayFires.length,
			});
			continue;
		}
		for (const fire of dayFires) {
			events.push({
				id: `${job.id}-${fire.getTime()}`,
				jobId: job.id,
				jobName: job.name,
				start: fire,
				kind: "upcoming",
				...target,
				scheduleLabel: label,
			});
		}
	}
	return events;
}

/** Past runs from a job's recorded history that fall within the window. */
function pastOccurrences(
	job: ScheduledJob,
	windowStart: Date,
	windowEnd: Date,
	workflowNames?: Map<string, string>
): CalendarEvent[] {
	const label = describeSchedule(job.schedule);
	const target = targetInfo(job, workflowNames);
	const startMs = windowStart.getTime();
	const endMs = windowEnd.getTime();
	const events: CalendarEvent[] = [];
	for (const record of job.history) {
		const when = new Date(record.startedAt);
		const ms = when.getTime();
		if (!Number.isFinite(ms) || ms < startMs || ms >= endMs) {
			continue;
		}
		events.push({
			id: `${job.id}-run-${record.startedAt}`,
			jobId: job.id,
			jobName: job.name,
			start: when,
			kind: "past",
			outcome: record.outcome,
			error: record.error,
			...target,
			scheduleLabel: label,
		});
	}
	return events;
}

/**
 * Build the full set of calendar events for the given jobs within
 * `[windowStart, windowEnd)`. Past runs come from history; upcoming runs are
 * projected from each job's (enabled) schedule.
 *
 * `workflowNames` is an optional id→name map used to label workflow-target
 * jobs with their human name instead of an opaque `wf_…` id. It is optional so
 * the projection stays a pure function callers can use without loading the
 * workflow list.
 */
export function buildCalendarEvents(
	jobs: ScheduledJob[],
	windowStart: Date,
	windowEnd: Date,
	workflowNames?: Map<string, string>
): CalendarEvent[] {
	const events: CalendarEvent[] = [];
	for (const job of jobs) {
		events.push(...pastOccurrences(job, windowStart, windowEnd, workflowNames));

		// Only project future runs for enabled jobs — a disabled job won't fire.
		if (!job.enabled) {
			continue;
		}
		if (job.schedule.kind === "cron") {
			events.push(
				...cronOccurrences(
					job,
					job.schedule.expr,
					windowStart,
					windowEnd,
					workflowNames
				)
			);
		} else {
			const seconds = parseIntervalSeconds(job.schedule.interval);
			if (seconds) {
				events.push(
					...intervalOccurrences(
						job,
						seconds,
						windowStart,
						windowEnd,
						workflowNames
					)
				);
			}
		}
	}
	events.sort((a, b) => a.start.getTime() - b.start.getTime());
	return events;
}

/** Group events by local calendar day for grid rendering. */
export function groupEventsByDay(
	events: CalendarEvent[]
): Map<string, CalendarEvent[]> {
	const map = new Map<string, CalendarEvent[]>();
	for (const event of events) {
		const key = dayKey(event.start);
		const bucket = map.get(key);
		if (bucket) {
			bucket.push(event);
		} else {
			map.set(key, [event]);
		}
	}
	return map;
}

/** Day key for a Date — exported so the grid keys cells the same way. */
export function eventDayKey(d: Date): string {
	return dayKey(d);
}
