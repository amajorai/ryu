import {
	type InterfaceAgent,
	type InterfaceEvent,
	type InterfaceSnapshot,
	type InterfaceThread,
	localDayKey,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

/**
 * Journal view model. A conversation is an entry, filed on the local day of
 * its latest activity, the way Day One files an entry on the day it was
 * written. Everything here is pure so the renderer and tests share it.
 */

export type JournalView = "calendar" | "day" | "stats";

export interface JournalEntry {
	/** Every participating agent that the snapshot knows. */
	agents: InterfaceAgent[];
	at: Date;
	/** Local `YYYY-MM-DD`. */
	day: string;
	/** Project or team the thread is filed under, when it has one. */
	place: string | null;
	status: ThreadStatus;
	thread: InterfaceThread;
}

export interface JournalDay {
	entries: JournalEntry[];
	key: string;
}

export interface JournalMonth {
	days: JournalDay[];
	/** `YYYY-MM`. */
	key: string;
	label: string;
}

const MONTH_LABEL = new Intl.DateTimeFormat(undefined, {
	month: "long",
	year: "numeric",
});
const TIME_LABEL = new Intl.DateTimeFormat(undefined, {
	hour: "numeric",
	minute: "2-digit",
});
const WEEKDAY_SHORT = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const WEEKDAY_LONG = new Intl.DateTimeFormat(undefined, { weekday: "long" });
const WEEKDAY_NARROW = new Intl.DateTimeFormat(undefined, {
	weekday: "narrow",
});
const MONTH_SHORT = new Intl.DateTimeFormat(undefined, { month: "short" });
const FULL_DATE = new Intl.DateTimeFormat(undefined, {
	day: "numeric",
	month: "long",
	weekday: "long",
	year: "numeric",
});
const MEDIUM_DATE = new Intl.DateTimeFormat(undefined, {
	day: "numeric",
	month: "short",
	weekday: "short",
});

/** Parse a local `YYYY-MM-DD` key into local midnight. */
export function parseDayKey(key: string): Date {
	const [year = "1970", month = "1", day = "1"] = key.split("-");
	return new Date(Number(year), Number(month) - 1, Number(day));
}

export function shiftDayKey(key: string, days: number): string {
	const date = parseDayKey(key);
	date.setDate(date.getDate() + days);
	return localDayKey(date);
}

/** The same day `months` away, clamped to the end of a shorter month. */
export function shiftMonthKey(key: string, months: number): string {
	const date = parseDayKey(key);
	const target = new Date(date.getFullYear(), date.getMonth() + months, 1);
	const lastDay = new Date(
		target.getFullYear(),
		target.getMonth() + 1,
		0
	).getDate();
	target.setDate(Math.min(date.getDate(), lastDay));
	return localDayKey(target);
}

export function monthLabel(key: string): string {
	return MONTH_LABEL.format(parseDayKey(key));
}

export function timeLabel(date: Date): string {
	return TIME_LABEL.format(date);
}

export function fullDateLabel(key: string): string {
	return FULL_DATE.format(parseDayKey(key));
}

export function mediumDateLabel(key: string): string {
	return MEDIUM_DATE.format(parseDayKey(key));
}

export function weekdayShort(key: string): string {
	return WEEKDAY_SHORT.format(parseDayKey(key));
}

export function weekdayLong(key: string): string {
	return WEEKDAY_LONG.format(parseDayKey(key));
}

export function weekdayNarrow(date: Date): string {
	return WEEKDAY_NARROW.format(date);
}

export function monthShort(date: Date): string {
	return MONTH_SHORT.format(date);
}

/** Where a thread is filed: its project first, then its team. */
function placeOf(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread
): string | null {
	const groupId = thread.projectId ?? thread.teamId;
	if (!groupId) {
		return null;
	}
	return snapshot.groups.find((group) => group.id === groupId)?.name ?? null;
}

/** Every dated thread as an entry, newest first. */
export function buildJournalEntries(
	snapshot: InterfaceSnapshot
): JournalEntry[] {
	const agents = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
	const entries: JournalEntry[] = [];
	for (const thread of snapshot.threads) {
		const at = new Date(thread.updatedAt);
		if (Number.isNaN(at.getTime())) {
			continue;
		}
		entries.push({
			agents: thread.agentIds
				.map((id) => agents.get(id))
				.filter((agent) => agent !== undefined),
			at,
			day: localDayKey(at),
			place: placeOf(snapshot, thread),
			status: threadStatus(thread),
			thread,
		});
	}
	return entries.sort(
		(a, b) =>
			b.at.getTime() - a.at.getTime() || a.thread.id.localeCompare(b.thread.id)
	);
}

/** Case-insensitive match on title, latest message, agents, and place. */
export function filterJournalEntries(
	entries: JournalEntry[],
	query: string
): JournalEntry[] {
	const needle = query.trim().toLowerCase();
	if (!needle) {
		return entries;
	}
	return entries.filter((entry) => {
		const haystack = [
			entry.thread.title,
			entry.thread.lastMessage ?? "",
			entry.place ?? "",
			...entry.agents.map((agent) => agent.name),
		]
			.join("\n")
			.toLowerCase();
		return haystack.includes(needle);
	});
}

/** Entries (already newest first) keyed by local day. */
export function entriesByDay(
	entries: JournalEntry[]
): Map<string, JournalEntry[]> {
	const days = new Map<string, JournalEntry[]>();
	for (const entry of entries) {
		const list = days.get(entry.day);
		if (list) {
			list.push(entry);
		} else {
			days.set(entry.day, [entry]);
		}
	}
	return days;
}

/** The timeline: months, then days, then entries, all newest first. */
export function groupJournalMonths(entries: JournalEntry[]): JournalMonth[] {
	const months: JournalMonth[] = [];
	for (const [key, dayEntries] of entriesByDay(entries)) {
		const monthKey = key.slice(0, 7);
		let month = months.at(-1);
		if (month?.key !== monthKey) {
			month = { days: [], key: monthKey, label: monthLabel(key) };
			months.push(month);
		}
		month.days.push({ entries: dayEntries, key });
	}
	return months;
}

/**
 * Consecutive days with an entry, ending today. A streak survives until a
 * whole day passes without one, so it counts from yesterday when today is
 * still blank (Day One keeps the streak alive the same way).
 */
export function currentStreak(days: ReadonlySet<string>, today: Date): number {
	let key = localDayKey(today);
	if (!days.has(key)) {
		key = shiftDayKey(key, -1);
	}
	let streak = 0;
	while (days.has(key)) {
		streak += 1;
		key = shiftDayKey(key, -1);
	}
	return streak;
}

export function longestStreak(days: ReadonlySet<string>): number {
	let longest = 0;
	for (const key of days) {
		if (days.has(shiftDayKey(key, -1))) {
			continue;
		}
		let length = 0;
		let cursor = key;
		while (days.has(cursor)) {
			length += 1;
			cursor = shiftDayKey(cursor, 1);
		}
		longest = Math.max(longest, length);
	}
	return longest;
}

export interface OnThisDayGroup {
	entries: JournalEntry[];
	key: string;
	label: string;
}

const WEEKS_BACK = 3;
const MONTHS_BACK = 11;
const YEARS_BACK = 5;

function plural(count: number, unit: string): string {
	return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

/**
 * Earlier entries from the same date: the same weekday in recent weeks, the
 * same day of the month in earlier months, and the same date in earlier
 * years. Nearest first; dates without entries are skipped.
 */
export function onThisDay(
	byDay: ReadonlyMap<string, JournalEntry[]>,
	key: string
): OnThisDayGroup[] {
	const candidates: { key: string; label: string }[] = [];
	for (let weeks = 1; weeks <= WEEKS_BACK; weeks++) {
		candidates.push({
			key: shiftDayKey(key, -7 * weeks),
			label: plural(weeks, "week"),
		});
	}
	const day = parseDayKey(key).getDate();
	for (let months = 1; months <= MONTHS_BACK; months++) {
		const earlier = shiftMonthKey(key, -months);
		// A clamped date (Mar 31 to Feb 28) is not the same date.
		if (parseDayKey(earlier).getDate() === day) {
			candidates.push({ key: earlier, label: plural(months, "month") });
		}
	}
	for (let years = 1; years <= YEARS_BACK; years++) {
		const earlier = shiftMonthKey(key, -12 * years);
		if (parseDayKey(earlier).getDate() === day) {
			candidates.push({ key: earlier, label: plural(years, "year") });
		}
	}
	const seen = new Set<string>();
	const groups: OnThisDayGroup[] = [];
	for (const candidate of candidates) {
		const entries = byDay.get(candidate.key);
		if (!entries || seen.has(candidate.key)) {
			continue;
		}
		seen.add(candidate.key);
		groups.push({ ...candidate, entries });
	}
	return groups.sort((a, b) => b.key.localeCompare(a.key));
}

/** The Sunday-first week containing a day. */
export function weekOf(key: string): Date[] {
	const date = parseDayKey(key);
	const start = new Date(
		date.getFullYear(),
		date.getMonth(),
		date.getDate() - date.getDay()
	);
	return Array.from(
		{ length: 7 },
		(_, index) =>
			new Date(start.getFullYear(), start.getMonth(), start.getDate() + index)
	);
}

/** Whole Sunday-first weeks covering a day's month (four to six rows). */
export function monthWeeks(key: string): Date[][] {
	const date = parseDayKey(key);
	const first = new Date(date.getFullYear(), date.getMonth(), 1);
	const daysInMonth = new Date(
		date.getFullYear(),
		date.getMonth() + 1,
		0
	).getDate();
	const rows = Math.ceil((first.getDay() + daysInMonth) / 7);
	const weeks: Date[][] = [];
	for (let row = 0; row < rows; row++) {
		weeks.push(
			Array.from(
				{ length: 7 },
				(_, column) =>
					new Date(
						first.getFullYear(),
						first.getMonth(),
						1 - first.getDay() + row * 7 + column
					)
			)
		);
	}
	return weeks;
}

export function sameMonth(a: string, b: string): boolean {
	return a.slice(0, 7) === b.slice(0, 7);
}

export interface HeatCell {
	count: number;
	future: boolean;
	key: string;
	/** 0 (none) to 4 (busiest), relative to the busiest day. */
	level: 0 | 1 | 2 | 3 | 4;
}

export interface HeatColumn {
	cells: HeatCell[];
	/** Short month name on the first column of each month. */
	month: string | null;
}

export const HEATMAP_WEEKS = 53;

function heatLevel(count: number, max: number): HeatCell["level"] {
	if (count <= 0 || max <= 0) {
		return 0;
	}
	const ratio = count / max;
	if (ratio > 0.75) {
		return 4;
	}
	if (ratio > 0.5) {
		return 3;
	}
	if (ratio > 0.25) {
		return 2;
	}
	return 1;
}

/**
 * The month label over a heatmap column. The leading month is the same month
 * as the trailing one a year earlier, so it carries its year, and it is left
 * unlabeled when the grid only catches its tail (too few columns to hold it).
 */
function heatMonthLabel(
	firstDate: Date,
	leading: boolean,
	previousMonth: number
): string | null {
	if (leading) {
		return firstDate.getDate() > 7
			? null
			: `${monthShort(firstDate)} ${firstDate.getFullYear()}`;
	}
	return firstDate.getMonth() === previousMonth ? null : monthShort(firstDate);
}

/** A year of weeks ending with this one, Sunday at the top of each column. */
export function yearHeatmap(
	byDay: ReadonlyMap<string, JournalEntry[]>,
	today: Date
): HeatColumn[] {
	const todayKey = localDayKey(today);
	const lastSunday = weekOf(todayKey)[0] ?? today;
	let max = 0;
	for (const entries of byDay.values()) {
		max = Math.max(max, entries.length);
	}
	const columns: HeatColumn[] = [];
	let previousMonth = -1;
	for (let week = HEATMAP_WEEKS - 1; week >= 0; week--) {
		const cells: HeatCell[] = [];
		for (let weekday = 0; weekday < 7; weekday++) {
			const date = new Date(
				lastSunday.getFullYear(),
				lastSunday.getMonth(),
				lastSunday.getDate() - week * 7 + weekday
			);
			const key = localDayKey(date);
			const count = byDay.get(key)?.length ?? 0;
			cells.push({
				count,
				future: key > todayKey,
				key,
				level: heatLevel(count, max),
			});
		}
		const firstDate = parseDayKey(cells[0]?.key ?? todayKey);
		const month = firstDate.getMonth();
		columns.push({
			cells,
			month: heatMonthLabel(firstDate, columns.length === 0, previousMonth),
		});
		previousMonth = month;
	}
	return columns;
}

export interface JournalAgentShare {
	agent: InterfaceAgent;
	entries: number;
	messages: number;
}

export interface JournalStats {
	agents: JournalAgentShare[];
	currentStreak: number;
	daysJournaled: number;
	entries: number;
	longestStreak: number;
	messages: number;
	/** Entries in the last 365 days, which the heatmap shows. */
	thisYear: number;
}

export function journalStats(
	entries: JournalEntry[],
	today: Date
): JournalStats {
	const days = new Set(entries.map((entry) => entry.day));
	const yearAgo = shiftDayKey(localDayKey(today), -364);
	const shares = new Map<string, JournalAgentShare>();
	let messages = 0;
	for (const entry of entries) {
		messages += entry.thread.messageCount;
		for (const agent of entry.agents) {
			const share = shares.get(agent.id) ?? { agent, entries: 0, messages: 0 };
			share.entries += 1;
			share.messages += entry.thread.messageCount;
			shares.set(agent.id, share);
		}
	}
	return {
		agents: [...shares.values()].sort(
			(a, b) =>
				b.entries - a.entries ||
				b.messages - a.messages ||
				a.agent.name.localeCompare(b.agent.name)
		),
		currentStreak: currentStreak(days, today),
		daysJournaled: days.size,
		entries: entries.length,
		longestStreak: longestStreak(days),
		messages,
		thisYear: entries.filter((entry) => entry.day >= yearAgo).length,
	};
}

export interface EntryNeighbors {
	next: JournalEntry | null;
	position: number;
	previous: JournalEntry | null;
	total: number;
}

/**
 * Neighbors in timeline order (newest first): "previous" is the entry above
 * in the list (newer), "next" the one below (older).
 */
export function entryNeighbors(
	entries: JournalEntry[],
	threadId: string | null
): EntryNeighbors {
	const index = threadId
		? entries.findIndex((entry) => entry.thread.id === threadId)
		: -1;
	if (index === -1) {
		return { next: null, position: 0, previous: null, total: entries.length };
	}
	return {
		next: entries[index + 1] ?? null,
		position: index + 1,
		previous: entries[index - 1] ?? null,
		total: entries.length,
	};
}

/** Scheduled runs that start on a local day, in start order. */
export function eventsOnDay(
	events: InterfaceEvent[] | undefined,
	key: string
): InterfaceEvent[] {
	if (!events) {
		return [];
	}
	return events
		.filter((event) => {
			const start = new Date(event.start);
			return !Number.isNaN(start.getTime()) && localDayKey(start) === key;
		})
		.sort((a, b) => a.start.localeCompare(b.start));
}

/** The body line a journal row shows: the latest message, attributed. */
export function entryExcerpt(thread: InterfaceThread): string {
	const text = thread.lastMessage?.trim();
	if (!text) {
		return "No messages yet.";
	}
	return thread.lastMessageRole === "user" ? `You: ${text}` : text;
}

/** "Forge", "Atlas and Echo", "Atlas, Echo and 1 more". */
export function agentNames(agents: InterfaceAgent[]): string {
	const [first, second] = agents;
	if (!first) {
		return "No agent";
	}
	if (!second) {
		return first.name;
	}
	if (agents.length === 2) {
		return `${first.name} and ${second.name}`;
	}
	return `${first.name}, ${second.name} and ${agents.length - 2} more`;
}

export function entryTitle(thread: InterfaceThread): string {
	return thread.title.trim() || "Untitled entry";
}

export function countLabel(
	count: number,
	unit: string,
	units = `${unit}s`
): string {
	return `${count.toLocaleString()} ${count === 1 ? unit : units}`;
}
