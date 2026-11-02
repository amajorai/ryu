// packages/ui/src/lib/timezone-days.ts
//
// Day boundaries in the shared display zone: where midnight falls for day
// bucketing and date grouping. Split from `timezone.ts`, which re-exports
// everything here, so there is still one zone store and one import path.

import { resolveTimeZone } from "./timezone.ts";

// --- day boundaries --------------------------------------------------------

const MS_PER_DAY = 86_400_000;
const CIVIL_DAY_CACHE_LIMIT = 256;
const civilDayStarts = new Map<string, number>();
const civilFormatters = new Map<string, Intl.DateTimeFormat>();

interface CivilFields {
	day: number;
	hour: number;
	minute: number;
	month: number;
	second: number;
	year: number;
}

function civilFormatter(timeZone: string): Intl.DateTimeFormat {
	let formatter = civilFormatters.get(timeZone);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat("en-US", {
			timeZone,
			calendar: "iso8601",
			numberingSystem: "latn",
			era: "short",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hourCycle: "h23",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
		civilFormatters.set(timeZone, formatter);
	}
	return formatter;
}

function civilFields(formatter: Intl.DateTimeFormat, at: number): CivilFields {
	const parts = formatter.formatToParts(new Date(at));
	const read = (type: string) =>
		Number(parts.find((part) => part.type === type)?.value);
	const fields: CivilFields = {
		year: read("year"),
		month: read("month"),
		day: read("day"),
		hour: read("hour") % 24,
		minute: read("minute"),
		second: read("second"),
	};
	const era = parts.find((part) => part.type === "era")?.value;
	if (era) {
		return era === "BC" ? { ...fields, year: 1 - fields.year } : fields;
	}
	// JavaScriptCore (Bun, WKWebView) omits the era for the ISO-8601 calendar,
	// so 1 BC and 1 AD both read as year 1. A wall clock stays within a day of
	// its instant while the two era readings are a year or more apart: keep the
	// reading nearer the instant.
	const beforeChrist = { ...fields, year: 1 - fields.year };
	return Math.abs(civilEpoch(beforeChrist) - at) <
		Math.abs(civilEpoch(fields) - at)
		? beforeChrist
		: fields;
}

function civilEpoch(fields: CivilFields): number {
	const date = new Date(0);
	date.setUTCFullYear(fields.year, fields.month - 1, fields.day);
	date.setUTCHours(fields.hour, fields.minute, fields.second, 0);
	return date.getTime();
}

/** First valid instant on or after a civil date, choosing the first repeated midnight. */
function civilDayBoundary(
	timeZone: string,
	year: number,
	month: number,
	day: number
): number {
	const key = `${timeZone}:${year}:${month}:${day}`;
	const cached = civilDayStarts.get(key);
	if (cached !== undefined) {
		return cached;
	}
	const formatter = civilFormatter(timeZone);
	const target = { year, month, day, hour: 0, minute: 0, second: 0 };
	const midnight = civilEpoch(target);
	const offsets = new Set<number>();
	// Named IANA offsets around the requested day provide both sides of a
	// transition; validate possible instants rather than assuming civil-date
	// ordering across a historical date-line rollback.
	for (const delta of [-2, -1, 0, 1, 2]) {
		const probe = midnight + delta * MS_PER_DAY;
		offsets.add(civilEpoch(civilFields(formatter, probe)) - probe);
	}
	const candidates = [...offsets]
		.map((offset) => midnight - offset)
		.sort((a, b) => a - b);
	const valid = candidates.filter((at) => {
		const local = civilFields(formatter, at);
		return (
			local.year === year &&
			local.month === month &&
			local.day === day &&
			local.hour === 0 &&
			local.minute === 0 &&
			local.second === 0
		);
	});
	let start: number;
	const firstValid = valid[0];
	if (firstValid === undefined) {
		// No valid midnight means an offset gap. Search only its offset-derived
		// candidate bracket, not an entire multi-day civil-date sequence.
		const firstCandidate = candidates[0];
		const lastCandidate = candidates.at(-1);
		if (firstCandidate === undefined || lastCandidate === undefined) {
			throw new RangeError("Civil midnight candidates unavailable");
		}
		let lower = firstCandidate;
		let upper = lastCandidate;
		const wallDate = (at: number) => {
			const local = civilFields(formatter, at);
			return civilEpoch({ ...local, hour: 0, minute: 0, second: 0 });
		};
		if (!(wallDate(lower) < midnight && wallDate(upper) >= midnight)) {
			throw new RangeError("Civil midnight gap bracket unavailable");
		}
		while (upper - lower > 1) {
			const middle = lower + Math.floor((upper - lower) / 2);
			if (wallDate(middle) < midnight) {
				lower = middle;
			} else {
				upper = middle;
			}
		}
		start = upper;
	} else {
		start = firstValid;
	}
	if (civilDayStarts.size >= CIVIL_DAY_CACHE_LIMIT) {
		const oldest = civilDayStarts.keys().next().value;
		if (oldest !== undefined) {
			civilDayStarts.delete(oldest);
		}
	}
	civilDayStarts.set(key, start);
	return start;
}

/**
 * Start of the selected civil day, or a number of civil dates before it.
 * Repeated dates use their earliest midnight; a wholly skipped date resolves
 * to the first instant of the following valid date.
 */
export function startOfDisplayDayMs(
	now: number = Date.now(),
	daysBefore = 0
): number {
	if (!Number.isSafeInteger(daysBefore) || daysBefore < 0) {
		throw new RangeError("Civil days must be a nonnegative integer");
	}
	const timeZone = resolveTimeZone();
	if (!timeZone) {
		const local = new Date(now);
		local.setDate(local.getDate() - daysBefore);
		local.setHours(0, 0, 0, 0);
		return local.getTime();
	}
	try {
		const local = civilFields(civilFormatter(timeZone), now);
		const date = new Date(
			civilEpoch({ ...local, hour: 0, minute: 0, second: 0 })
		);
		date.setUTCDate(date.getUTCDate() - daysBefore);
		return civilDayBoundary(
			timeZone,
			date.getUTCFullYear(),
			date.getUTCMonth() + 1,
			date.getUTCDate()
		);
	} catch {
		const local = new Date(now);
		local.setDate(local.getDate() - daysBefore);
		local.setHours(0, 0, 0, 0);
		return local.getTime();
	}
}

/** A civil date and time of day, as a clock in some zone reads them. */
export interface DisplayWallClock {
	/** Day of the month, 1 to 31. */
	day: number;
	/** Hour of the day, 0 to 23 (midnight is 0, never 24). */
	hour: number;
	minute: number;
	/** Month of the year, 1 to 12 (not the zero-based `Date` month). */
	month: number;
	second: number;
	year: number;
}

function machineWallClock(at: number): DisplayWallClock {
	const local = new Date(at);
	return {
		year: local.getFullYear(),
		month: local.getMonth() + 1,
		day: local.getDate(),
		hour: local.getHours(),
		minute: local.getMinutes(),
		second: local.getSeconds(),
	};
}

/**
 * The civil date and time of day a clock in the selected display zone shows
 * at an instant. A view that files a run under a day, or places it at an hour,
 * reads this rather than the `Date` getters, which answer in the machine's
 * zone. With the preference on "system", or a zone the runtime rejects, it is
 * the machine's own clock.
 */
export function displayWallClock(value: Date | number): DisplayWallClock {
	const at = typeof value === "number" ? value : value.getTime();
	const timeZone = resolveTimeZone();
	if (timeZone) {
		try {
			return civilFields(civilFormatter(timeZone), at);
		} catch {
			// An unsupported zone or an invalid instant reads like startOfDisplayDayMs.
		}
	}
	return machineWallClock(at);
}

/**
 * First instant of a civil date (`month` is 1 to 12) in the selected display
 * zone, so a view that draws a day column can ask where that day begins and
 * ends. A repeated midnight resolves to its earlier instant, and a wholly
 * skipped date to the first instant of the next valid one. With the
 * preference on "system" it is the machine's own local midnight.
 */
export function startOfDisplayCivilDayMs(
	year: number,
	month: number,
	day: number
): number {
	const timeZone = resolveTimeZone();
	if (timeZone) {
		try {
			return civilDayBoundary(timeZone, year, month, day);
		} catch {
			// An unsupported zone falls back to the machine's midnight.
		}
	}
	const local = new Date(0);
	local.setFullYear(year, month - 1, day);
	local.setHours(0, 0, 0, 0);
	return local.getTime();
}

/** Earliest instant of today's civil date in the selected display zone. */
export function startOfTodayMs(now: number = Date.now()): number {
	return startOfDisplayDayMs(now);
}

/** Next nominal display civil date boundary; never assumes a 24-hour day. */
export function nextDisplayDayBoundaryMs(now: number = Date.now()): number {
	const timeZone = resolveTimeZone();
	if (!timeZone) {
		const local = new Date(now);
		local.setDate(local.getDate() + 1);
		local.setHours(0, 0, 0, 0);
		return local.getTime();
	}
	const local = civilFields(civilFormatter(timeZone), now);
	const date = new Date(
		civilEpoch({ ...local, hour: 0, minute: 0, second: 0 })
	);
	date.setUTCDate(date.getUTCDate() + 1);
	return civilDayBoundary(
		timeZone,
		date.getUTCFullYear(),
		date.getUTCMonth() + 1,
		date.getUTCDate()
	);
}
