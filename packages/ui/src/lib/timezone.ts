// packages/ui/src/lib/timezone.ts
//
// The CORE of the one shared, persisted display time zone every wall-clock
// timestamp in the product renders through. The stored value is either the
// sentinel `"system"` (follow the machine's zone — the default) or an IANA zone
// id like `"Europe/London"`.
//
// Why this half lives in `@ryu/ui` and not in the desktop app: the chat
// transcript is `@ryu/blocks`, which depends on `@ryu/ui` but NOT on
// `apps/desktop`. Leaving the store there meant the transcript could not reach
// it and kept hardcoding `en-GB` with no `timeZone` — the exact drift this
// module exists to prevent. This is a SPLIT, not a move: the picker-only
// surface (`timezoneOptions`, `zoneOffsetLabel`, `timezoneLabel` and their ~450
// entries) stays in `apps/desktop/src/lib/timezone.ts`, which re-exports
// everything here. There is still exactly one store, one formatter cache and
// one listener set.
//
// Everything that shows a date or a clock time should go through the formatters
// here instead of calling `toLocaleDateString` / `toLocaleTimeString` directly,
// so switching the setting moves every surface at once. Relative ages
// (`compactAge` in the desktop's ./time.ts) are zone-independent and stay as
// they are — but day *bucketing* is not, which is why `startOfTodayMs()` lives
// here too.

import { useSyncExternalStore } from "react";
import { z } from "zod";

const calendarStringSchema = z.string();

/** localStorage key holding `"system"` or an IANA zone id. */
export const TIMEZONE_KEY = "ryu:timezone";

/** Host-projected effective IANA zone for null-origin Companion documents. */
export const TIMEZONE_TOKEN = "--ryu-timezone";

/** Host-projected locale used for the same date/time display conventions. */
export const LOCALE_TOKEN = "--ryu-locale";

/** Same-document signal used by preference writers that cannot rely on storage events. */
export const TIMEZONE_CHANGE_EVENT = "ryu:timezone-change";

/** Default: follow the machine's zone. */
export const DEFAULT_TIMEZONE = "system";

/** The sentinel meaning "whatever the OS says". */
export const SYSTEM_TIMEZONE = "system";

const listeners = new Set<() => void>();

let cached: string | null = null;
// A local CSS mirror must not become an external host preference after clear().
let selfPublishedTimezone: string | null = null;

function storedTimezone(): string | null {
	try {
		return localStorage.getItem(TIMEZONE_KEY);
	} catch {
		return null;
	}
}

function documentToken(name: string): string | null {
	if (globalThis.document === undefined) {
		return null;
	}
	try {
		const value = getComputedStyle(document.documentElement)
			.getPropertyValue(name)
			.trim();
		return value.length > 0 ? value : null;
	} catch {
		return null;
	}
}

function hostedTimezone(): string | null {
	const value = documentToken(TIMEZONE_TOKEN);
	return value && value !== SYSTEM_TIMEZONE ? value : null;
}

function embeddedDocument(): boolean {
	return globalThis.window !== undefined && window.parent !== window;
}

function effectiveTimezoneToken(preference: string): string {
	if (preference !== SYSTEM_TIMEZONE) {
		return preference;
	}
	return systemTimeZone();
}

/** Mirror the current effective zone onto the local root for bridge observers. */
function syncDocumentTimezoneToken(preference?: string): void {
	if (globalThis.document === undefined) {
		return;
	}
	const value = preference ?? storedTimezone() ?? DEFAULT_TIMEZONE;
	try {
		const effective = effectiveTimezoneToken(value);
		document.documentElement.style.setProperty(TIMEZONE_TOKEN, effective);
		selfPublishedTimezone = effective;
	} catch {
		// DOM projection is best-effort; the local preference remains authoritative.
	}
}

/** The stored preference: `"system"` or an IANA zone id. */
export function getTimezonePreference(): string {
	const stored = storedTimezone();
	const host = hostedTimezone();
	// Desktop keeps the user-facing `"system"` sentinel in its own localStorage,
	// while Island and null-origin frames have no local preference store. Prefer
	// the host projection in those isolated documents without changing Desktop's
	// picker value from `"system"` to the machine's resolved IANA zone.
	if (
		host &&
		(embeddedDocument() || (stored === null && host !== selfPublishedTimezone))
	) {
		return host;
	}
	if (cached !== null) {
		return cached;
	}
	cached = stored || DEFAULT_TIMEZONE;
	return cached;
}

/**
 * The zone to hand `Intl`: `undefined` for "system" so the runtime picks, an
 * IANA id otherwise.
 */
export function resolveTimeZone(): string | undefined {
	const pref = getTimezonePreference();
	return pref === SYSTEM_TIMEZONE ? undefined : pref;
}

/** The machine's own zone, e.g. `"Europe/London"`. Falls back to `"UTC"`. */
export function systemTimeZone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
}

/** The zone timestamps are actually rendered in right now. */
export function effectiveTimeZone(): string {
	return resolveTimeZone() ?? systemTimeZone();
}

/** Subscribe to preference changes (including from a second desktop window). */
export function subscribeTimezone(cb: () => void): () => void {
	listeners.add(cb);
	let last = getTimezonePreference();
	const notifyIfChanged = () => {
		const next = getTimezonePreference();
		if (next === last) {
			return;
		}
		last = next;
		formatterCache.clear();
		cb();
	};
	const onStorage = (e: StorageEvent) => {
		try {
			if (e.storageArea !== localStorage) {
				return;
			}
		} catch {
			return;
		}
		if (e.key === TIMEZONE_KEY || e.key === null) {
			cached = null;
			syncDocumentTimezoneToken(storedTimezone() ?? DEFAULT_TIMEZONE);
			notifyIfChanged();
			window.dispatchEvent(new Event(TIMEZONE_CHANGE_EVENT));
		}
	};
	window.addEventListener("storage", onStorage);
	const observer =
		globalThis.document !== undefined &&
		globalThis.MutationObserver !== undefined
			? new MutationObserver(notifyIfChanged)
			: null;
	observer?.observe(document.documentElement, {
		attributes: true,
		attributeFilter: ["style"],
	});
	return () => {
		listeners.delete(cb);
		window.removeEventListener("storage", onStorage);
		observer?.disconnect();
	};
}

/** Write the display time zone and notify every consumer. */
export function setTimezonePreference(value: string): void {
	cached = value;
	try {
		localStorage.setItem(TIMEZONE_KEY, value);
	} catch {
		// Non-fatal: persistence is best-effort.
	}
	syncDocumentTimezoneToken(value);
	formatterCache.clear();
	for (const cb of listeners) {
		cb();
	}
	if (globalThis.window !== undefined) {
		window.dispatchEvent(new Event(TIMEZONE_CHANGE_EVENT));
	}
}

/** Reset the display zone to "system". Used by Appearance → Reset to defaults. */
export function resetTimezone(): void {
	setTimezonePreference(DEFAULT_TIMEZONE);
}

// --- React binding ---------------------------------------------------------

/**
 * Subscribe to zone changes without caring what the zone is — for components
 * that only render formatted timestamps and just need to repaint.
 *
 * It is also the dependency to list on any memo whose OUTPUT depends on where
 * midnight falls (day bucketing, date grouping): those recompute a boundary,
 * not just a label, so a subscription alone would leave a stale grouping on
 * screen.
 *
 * Lives beside the store rather than in a hooks file so `@ryu/blocks` can reach
 * it — the transcript needs the revision, and it cannot import `apps/desktop`.
 */
export function useTimezoneRevision(): string {
	return useSyncExternalStore(
		subscribeTimezone,
		getTimezonePreference,
		() => DEFAULT_TIMEZONE
	);
}

// --- formatting ------------------------------------------------------------

export type DateLike = Date | number | string;

/**
 * `Intl.DateTimeFormat` construction is expensive and these formatters run in
 * list renders, so instances are memoized per option-set. The cache is cleared
 * whenever the zone changes.
 */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

/** Selected document locale; undefined preserves the browser default. */
export function getDisplayLocale(): string | undefined {
	const rawLocale = documentToken(LOCALE_TOKEN);
	return rawLocale && rawLocale !== "system" ? rawLocale : undefined;
}

/** Observe the host locale projection, including isolated Companion documents. */
function subscribeDisplayLocale(notify: () => void): () => void {
	if (
		globalThis.document === undefined ||
		globalThis.MutationObserver === undefined
	) {
		return () => {};
	}
	let previous = getDisplayLocale();
	const observer = new MutationObserver(() => {
		const next = getDisplayLocale();
		if (next === previous) {
			return;
		}
		previous = next;
		notify();
	});
	observer.observe(document.documentElement, {
		attributes: true,
		attributeFilter: ["style"],
	});
	return () => observer.disconnect();
}

/** Repaint calendar values when the selected host language changes. */
export function useDisplayLocale(): string | undefined {
	return useSyncExternalStore(
		subscribeDisplayLocale,
		getDisplayLocale,
		() => undefined
	);
}

function formatterFor(
	options: Intl.DateTimeFormatOptions,
	timeZone = resolveTimeZone()
): Intl.DateTimeFormat {
	const locale = getDisplayLocale();
	// A native formatter captures the default zone when it is constructed.
	// System clocks must stop reusing it after the runtime's zone changes.
	const zoneKey = timeZone ?? `system:${systemTimeZone()}`;
	const key = `${locale ?? ""}|${zoneKey}|${JSON.stringify(options)}`;
	const hit = formatterCache.get(key);
	if (hit) {
		return hit;
	}
	// `undefined` locale = the user's locale, matching the `toLocale*String`
	// calls this replaces.
	const made = new Intl.DateTimeFormat(locale ?? undefined, {
		...options,
		timeZone,
	});
	formatterCache.set(key, made);
	return made;
}

function toDate(value: DateLike): Date | null {
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

function formatInZone(
	value: DateLike,
	options: Intl.DateTimeFormatOptions,
	timeZone: string | undefined
): string {
	const date = toDate(value);
	if (!date) {
		return "";
	}
	try {
		return formatterFor(options, timeZone).format(date);
	} catch {
		// An unsupported zone id (stale preference, exotic runtime) must never
		// blank a timestamp — fall back to the machine's zone.
		try {
			return new Intl.DateTimeFormat(undefined, options).format(date);
		} catch {
			return new Intl.DateTimeFormat(undefined).format(date);
		}
	}
}

function format(value: DateLike, options: Intl.DateTimeFormatOptions): string {
	return formatInZone(value, options, resolveTimeZone());
}

/** Date only, in the display zone. Drop-in for `toLocaleDateString`. */
export function formatDate(
	value: DateLike,
	options: Intl.DateTimeFormatOptions = { dateStyle: "medium" }
): string {
	// Some locale patterns render a standalone year+day as an awkward `2026 (day:
	// 26)` because there is no month to anchor the date. Callers that deliberately
	// omit the month for a compact range still need a readable calendar date.
	const dateOptions =
		options.day !== undefined &&
		options.year !== undefined &&
		options.month === undefined &&
		options.dateStyle === undefined
			? { ...options, month: "short" as const }
			: options;
	// Date-only fields are calendar values, not instants. Anchor them at noon UTC
	// and format in UTC so a display zone cannot move `2026-01-15` to the prior day.
	const calendarString = calendarStringSchema.safeParse(value);
	if (
		calendarString.success &&
		/^\d{4}-\d{2}-\d{2}$/.test(calendarString.data)
	) {
		return formatInZone(`${value}T12:00:00.000Z`, dateOptions, "UTC");
	}
	return format(value, dateOptions);
}

/** Clock time only, in the display zone. Drop-in for `toLocaleTimeString`. */
export function formatTime(
	value: DateLike,
	options: Intl.DateTimeFormatOptions = { timeStyle: "medium" }
): string {
	return format(value, options);
}

/** Format a clock-hour label with the host locale's 12/24-hour convention. */
export function formatHourLabel(
	hour: number,
	options: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" }
): string {
	const bounded = Math.max(0, Math.min(23, Math.trunc(hour)));
	return formatInZone(new Date(Date.UTC(2000, 0, 1, bounded)), options, "UTC");
}

/** Date + time, in the display zone. Drop-in for `toLocaleString`. */
export function formatDateTime(
	value: DateLike,
	options: Intl.DateTimeFormatOptions = {
		dateStyle: "medium",
		timeStyle: "medium",
	}
): string {
	return format(value, options);
}

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
