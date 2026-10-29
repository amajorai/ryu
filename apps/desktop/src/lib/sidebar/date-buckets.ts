import type { ViewSourceRow } from "@ryu/app-host/views";
import { z } from "zod";

// apps/desktop/src/lib/sidebar/date-buckets.ts
//
// The sidebar's ChatGPT-style date buckets, as a primitive ANY list can use.
//
// This started life as three module-private helpers inside `AppSidebar.tsx`,
// hardcoded to `Conversation` and reachable only from the Chats section. That made
// "group by date" a property of one list rather than of the sidebar, so every other
// list that grew rows over time — a project's chats, a space's pages, the Uploads
// space's files, an app-registered section's feed — had no way to opt in short of
// copying the bucketing. Hence the generic `stampOf` accessor: the buckets know
// nothing about what they hold, and a caller supplies the one field that carries
// time (`updatedAt` for a chat, `createdAt` for a space document, whatever an app's
// feed names it).
//
// Deliberately dependency-free and pure: `startOfToday` is a REQUIRED argument
// rather than a `startOfTodayMs()` call inside, because the boundary depends on the
// user's chosen display zone and the caller is what re-reads it (see
// `useTimezoneRevision`). Keeping the clock outside is also what makes this unit
// testable without faking a zone.

/** The dated buckets, coarsening as they recede. */
export type DatedBucketKey =
	| "today"
	| "yesterday"
	| "last-week"
	| "last-month"
	| "last-year"
	| "older";

/**
 * The bucket for rows whose timestamp could not be read at all.
 *
 * It exists so an unstampable row is *stated* rather than fabricated. The
 * alternative was letting {@link toEpoch} coerce an absent stamp to `0` and drop
 * the row into "Older" — a silent lie that reads as "this is from years ago" for
 * what is usually a feed that simply does not carry a date. Only ever appended, and
 * only when non-empty, so a well-stamped list never sees it.
 */
export const UNDATED_BUCKET_KEY = "undated";

export type DateBucketKey = DatedBucketKey | typeof UNDATED_BUCKET_KEY;

/** The dated buckets in their natural (chronological) order. */
export const DATE_BUCKETS: readonly { key: DatedBucketKey; label: string }[] = [
	{ key: "today", label: "Today" },
	{ key: "yesterday", label: "Yesterday" },
	{ key: "last-week", label: "Last week" },
	{ key: "last-month", label: "Last month" },
	{ key: "last-year", label: "Last year" },
	{ key: "older", label: "Older" },
];

const dateBucketLabelsSchema = z.object({
	today: z.string(),
	yesterday: z.string(),
	"last-week": z.string(),
	"last-month": z.string(),
	"last-year": z.string(),
	older: z.string(),
	undated: z.string(),
});
export const DATE_BUCKET_LABELS = dateBucketLabelsSchema.parse({
	...Object.fromEntries(
		DATE_BUCKETS.map((bucket) => [bucket.key, bucket.label])
	),
	[UNDATED_BUCKET_KEY]: "Undated",
});
const nativeEpochSchema = z.union([
	z.number(),
	z.nan(),
	z.literal(Number.POSITIVE_INFINITY),
	z.literal(Number.NEGATIVE_INFINITY),
]);
const timestampSchema = z.union([nativeEpochSchema, z.string()]);

export const DAY_MS = 86_400_000;

/** Display-zone civil starts; rolling windows count dates, not 24-hour spans. */
export interface DateBucketCivilStarts {
	yesterday: number;
	lastWeek: number;
	lastMonth: number;
	lastYear: number;
}

/** Normalize a timestamp (epoch ms, ISO string, or absent) to a comparable epoch. */
export function toEpoch(value: number | string | null | undefined): number {
	if (value == null) {
		return 0;
	}
	const text = z.string().safeParse(value);
	if (!text.success) {
		return nativeEpochSchema.parse(value);
	}
	const parsed = Date.parse(text.data);
	return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * The epoch a raw stamp carries, or `null` when it carries none.
 *
 * The distinction {@link toEpoch} cannot make: `0` is both "absent" and "1970", and
 * the buckets need to tell those apart to keep {@link UNDATED_BUCKET_KEY} honest.
 * A non-positive epoch is treated as absent — no row in this app predates the epoch.
 */
export function stampEpoch(
	value: number | string | null | undefined,
): number | null {
	if (value == null || value === "") {
		return null;
	}
	const epoch = toEpoch(value);
	return epoch > 0 ? epoch : null;
}

/** Which dated bucket a timestamp falls into, relative to the start of today. */
export function dateBucketKey(
	ts: number,
	startOfToday: number,
	civilStarts?: DateBucketCivilStarts,
): DatedBucketKey {
	if (ts >= startOfToday) {
		return "today";
	}
	if (ts >= (civilStarts?.yesterday ?? startOfToday - DAY_MS)) {
		return "yesterday";
	}
	if (ts >= (civilStarts?.lastWeek ?? startOfToday - 7 * DAY_MS)) {
		return "last-week";
	}
	if (ts >= (civilStarts?.lastMonth ?? startOfToday - 30 * DAY_MS)) {
		return "last-month";
	}
	if (ts >= (civilStarts?.lastYear ?? startOfToday - 365 * DAY_MS)) {
		return "last-year";
	}
	return "older";
}

/** One non-empty bucket of rows, with the label the sub-section header shows. */
export interface DateBucket<T> {
	items: T[];
	key: DateBucketKey;
	label: string;
}

/**
 * Bucket any rows by the timestamp `stampOf` reads off them.
 *
 * Returns only the NON-EMPTY buckets, in chronological (Today → Older → Undated)
 * order, each sorted most-recent-first. Rows `stampOf` cannot date keep their
 * incoming order in the trailing {@link UNDATED_BUCKET_KEY} bucket.
 *
 * `startOfToday` is midnight in the *display* zone (`startOfTodayMs()`), not the
 * machine's — otherwise a row reading 09:00 in the chosen zone can land under
 * "Yesterday".
 */
export function bucketByDate<T>(
	items: readonly T[],
	stampOf: (item: T) => number | string | null | undefined,
	startOfToday: number,
	civilStarts?: DateBucketCivilStarts,
): DateBucket<T>[] {
	const byKey = new Map<DateBucketKey, { epoch: number; item: T }[]>();
	const undated: T[] = [];
	for (const item of items) {
		const epoch = stampEpoch(stampOf(item));
		if (epoch === null) {
			undated.push(item);
			continue;
		}
		const key = dateBucketKey(epoch, startOfToday, civilStarts);
		const existing = byKey.get(key);
		if (existing) {
			existing.push({ epoch, item });
		} else {
			byKey.set(key, [{ epoch, item }]);
		}
	}
	const out: DateBucket<T>[] = [];
	for (const { key, label } of DATE_BUCKETS) {
		const bucket = byKey.get(key);
		if (bucket && bucket.length > 0) {
			bucket.sort((a, b) => b.epoch - a.epoch);
			out.push({ items: bucket.map((entry) => entry.item), key, label });
		}
	}
	if (undated.length > 0) {
		out.push({
			items: undated,
			key: UNDATED_BUCKET_KEY,
			label: DATE_BUCKET_LABELS[UNDATED_BUCKET_KEY],
		});
	}
	return out;
}

/**
 * The response-row keys a contributed section's feed is probed for when its spec
 * declares no explicit `dateKey`.
 *
 * The point of a heuristic here rather than a required field: date grouping is a
 * SHELL preference the user turns on once, and a section that silently opts out
 * because its manifest predates the feature reads as the feature being broken. Every
 * key here is a name Core itself already serves on its list endpoints, so the probe
 * either finds a real stamp or finds nothing and the section stays flat — it never
 * guesses at an unrelated field.
 */
export const CONTRIBUTED_DATE_KEYS: readonly string[] = [
	"updatedAt",
	"updated_at",
	"createdAt",
	"created_at",
	"lastMessageAt",
	"last_message_at",
	"timestamp",
	"date",
];

/**
 * Read a row's timestamp for date grouping: the spec's declared `dateKey` when it
 * has one, else the first {@link CONTRIBUTED_DATE_KEYS} member the row actually
 * carries. `null` = this row cannot be dated (see {@link UNDATED_BUCKET_KEY}).
 */
export function rowStamp(row: ViewSourceRow, dateKey?: string): number | null {
	const read = (key: string): number | null => {
		const value = timestampSchema.safeParse(row[key]);
		return value.success ? stampEpoch(value.data) : null;
	};
	if (dateKey) {
		return read(dateKey);
	}
	for (const key of CONTRIBUTED_DATE_KEYS) {
		const epoch = read(key);
		if (epoch !== null) {
			return epoch;
		}
	}
	return null;
}
