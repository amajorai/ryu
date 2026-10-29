// apps/desktop/src/lib/timezone.ts
//
// The desktop's view of the shared display time zone.
//
// The STORE, the formatters, `startOfTodayMs` and `useTimezoneRevision` now
// live in `@ryu/ui/lib/timezone.ts` and are re-exported wholesale below. They
// moved because `@ryu/blocks` — which owns the chat transcript — can import
// `@ryu/ui` but not `apps/desktop`, so a store that lived only here was
// unreachable from the surface that renders the most timestamps in the product.
// It is one store, one formatter cache and one listener set either way; this
// file is not a second copy.
//
// What stays here is the PICKER-only surface: the ~450-entry option list and
// its labels, which nothing outside Appearance → "Date & time" needs.
//
// Every existing importer keeps importing from here unchanged, and
// `./timezone.test.ts` deliberately exercises the whole surface through this
// path so an incomplete re-export fails a test rather than a random screen.
//
// React binding: `useTimezoneRevision` (re-exported below, also available from
// @/src/hooks/useTimezone.ts alongside the `useTimezone` setter pair).

import { SYSTEM_TIMEZONE, systemTimeZone } from "@ryu/ui/lib/timezone.ts";

export * from "@ryu/ui/lib/timezone.ts";

// --- the option list -------------------------------------------------------

export interface TimezoneOption {
	/** `"(GMT+01:00) Europe/London"`. */
	label: string;
	/** Minutes east of UTC, used only to sort the list. */
	offsetMinutes: number;
	/** `"system"` or an IANA zone id — this is what gets persisted. */
	value: string;
}

// Hoisted: building this inside the map would recompile the pattern ~450 times.
const GMT_OFFSET_RE = /GMT([+-])(\d{1,2})(?::(\d{2}))?/;

const MINUTES_IN_HOUR = 60;

/** Enough of a list to keep the picker usable if `supportedValuesOf` is absent. */
const FALLBACK_ZONES = [
	"UTC",
	"America/Los_Angeles",
	"America/New_York",
	"Europe/London",
	"Europe/Berlin",
	"Asia/Dubai",
	"Asia/Kolkata",
	"Asia/Singapore",
	"Asia/Tokyo",
	"Australia/Sydney",
];

function supportedZones(): string[] {
	try {
		const values = Intl.supportedValuesOf?.("timeZone");
		return values && values.length > 0 ? [...values] : FALLBACK_ZONES;
	} catch {
		return FALLBACK_ZONES;
	}
}

/** `"GMT+01:00"` for a zone right now, or `"GMT+00:00"` if it can't be read. */
export function zoneOffsetLabel(
	timeZone: string,
	now: Date = new Date(),
): string {
	try {
		const parts = new Intl.DateTimeFormat("en-US", {
			timeZone,
			timeZoneName: "shortOffset",
		}).formatToParts(now);
		const raw = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
		const match = GMT_OFFSET_RE.exec(raw);
		if (!match) {
			// A bare "GMT" means exactly UTC.
			return "GMT+00:00";
		}
		const hours = match[2].padStart(2, "0");
		const minutes = match[3] ?? "00";
		return `GMT${match[1]}${hours}:${minutes}`;
	} catch {
		return "GMT+00:00";
	}
}

function offsetMinutesOf(label: string): number {
	const match = GMT_OFFSET_RE.exec(label);
	if (!match) {
		return 0;
	}
	const sign = match[1] === "-" ? -1 : 1;
	const hours = Number.parseInt(match[2], 10) || 0;
	const minutes = Number.parseInt(match[3] ?? "0", 10) || 0;
	return sign * (hours * MINUTES_IN_HOUR + minutes);
}

/**
 * Every selectable zone, offset-labelled and sorted west-to-east, with
 * "System" pinned first.
 */
function buildTimezoneOptions(at: number): TimezoneOption[] {
	const now = new Date(at);
	const zones = supportedZones()
		.map((zone) => {
			const offset = zoneOffsetLabel(zone, now);
			return {
				value: zone,
				label: `(${offset}) ${zone.replace(/_/g, " ")}`,
				offsetMinutes: offsetMinutesOf(offset),
			};
		})
		.sort(
			(a, b) =>
				a.offsetMinutes - b.offsetMinutes || a.value.localeCompare(b.value),
		);

	return [
		{
			value: SYSTEM_TIMEZONE,
			label: `System (${systemTimeZone().replace(/_/g, " ")})`,
			offsetMinutes: Number.NEGATIVE_INFINITY,
		},
		...zones,
	];
}

const MS_PER_MINUTE = 60_000;

let optionsCache: TimezoneOption[] | null = null;
let optionsBuiltOnMinute = -1;

/**
 * The picker's items — ~450 entries built once and reused, never per render.
 *
 * Offset transitions can happen within a UTC day. Refresh once per minute so
 * the next call after a minute boundary recomputes current offsets. Rerenders
 * within the minute reuse the list; historical transitions
 * with second precision can retain the earlier offset for the rest of that minute.
 */
export function timezoneOptions(now: number = Date.now()): TimezoneOption[] {
	const minute = Math.floor(now / MS_PER_MINUTE);
	if (!optionsCache || minute !== optionsBuiltOnMinute) {
		optionsCache = buildTimezoneOptions(now);
		optionsBuiltOnMinute = minute;
	}
	return optionsCache;
}

/** The label shown for a stored preference, even if it is no longer supported. */
export function timezoneLabel(value: string): string {
	const hit = timezoneOptions().find((o) => o.value === value);
	return hit ? hit.label : value;
}
