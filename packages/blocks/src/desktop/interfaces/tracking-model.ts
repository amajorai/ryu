import {
	type InterfaceAgent,
	type InterfaceEvent,
	type InterfaceSnapshot,
	type InterfaceThread,
	localDayKey,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { agentById, compactAge } from "./interface-renderer.ts";

/**
 * Tracking view model. A conversation is a parcel: you place the order (send
 * a message), the courier (agent) picks it up and carries it, and it is
 * delivered when the agent replies. Pure functions only, so the stepper,
 * list, and history agree and can be tested without a DOM.
 */

const MINUTE = 60_000;

/**
 * A live run whose newest message is the agent's own and landed within this
 * window reads as "Out for delivery": the agent is actively writing, so a
 * reply is close. Your own message also bumps the thread, so it never counts.
 * It is an inference from timing, and the page says so.
 */
export const OUT_FOR_DELIVERY_WINDOW_MS = 2 * MINUTE;

export type TrackingStage =
	| "label"
	| "awaiting"
	| "transit"
	| "out"
	| "delivered"
	| "exception";

export type TrackingTab = "all" | "delivered" | "exceptions" | "on-the-way";

export const TRACKING_TABS: readonly { id: TrackingTab; label: string }[] = [
	{ id: "on-the-way", label: "On the way" },
	{ id: "delivered", label: "Delivered" },
	{ id: "exceptions", label: "Exceptions" },
	{ id: "all", label: "All" },
];

/** The classic five scans, left to right. */
export const TRACKING_STEPS = [
	"Order placed",
	"Picked up",
	"In transit",
	"Out for delivery",
	"Delivered",
] as const;

export const TRACKING_STAGE_LABELS: Record<TrackingStage, string> = {
	awaiting: "Awaiting pickup",
	delivered: "Delivered",
	exception: "Delivery exception",
	label: "Label created",
	out: "Out for delivery",
	transit: "In transit",
};

/** Index of the step the parcel is on (or last reached) for each stage. */
const STAGE_STEP: Record<TrackingStage, number> = {
	awaiting: 1,
	delivered: 4,
	// A failed run stops the parcel mid-route, where the courier was carrying it.
	exception: 2,
	label: 0,
	out: 3,
	transit: 2,
};

export type StepState = "current" | "done" | "exception" | "upcoming";

export function trackingStage(
	thread: InterfaceThread,
	now: number
): TrackingStage {
	const status = threadStatus(thread);
	return stageForStatus(status, thread, now);
}

function stageForStatus(
	status: ThreadStatus,
	thread: InterfaceThread,
	now: number
): TrackingStage {
	switch (status) {
		case "working": {
			if (thread.lastMessageRole !== "assistant") {
				return "transit";
			}
			const updated = Date.parse(thread.updatedAt);
			const recent =
				!Number.isNaN(updated) && now - updated <= OUT_FOR_DELIVERY_WINDOW_MS;
			return recent ? "out" : "transit";
		}
		case "attention":
			return "exception";
		case "your-turn":
			return "delivered";
		case "waiting":
			return "awaiting";
		default:
			return "label";
	}
}

export function stageStep(stage: TrackingStage): number {
	return STAGE_STEP[stage];
}

/** Per-step state for the stepper. Delivered marks every step done. */
export function stepStates(stage: TrackingStage): StepState[] {
	const current = STAGE_STEP[stage];
	return TRACKING_STEPS.map((_, index) => {
		if (stage === "delivered" || index < current) {
			return "done";
		}
		if (index === current) {
			return stage === "exception" ? "exception" : "current";
		}
		return "upcoming";
	});
}

/**
 * The tab a stage lives in. A label with no courier is not moving anywhere,
 * so it is only listed under All.
 */
export function trackingTab(
	stage: TrackingStage
): Exclude<TrackingTab, "all"> | null {
	if (stage === "delivered") {
		return "delivered";
	}
	if (stage === "exception") {
		return "exceptions";
	}
	if (stage === "label") {
		return null;
	}
	return "on-the-way";
}

/** True when the courier is moving the parcel right now. */
export function isMoving(stage: TrackingStage): boolean {
	return stage === "transit" || stage === "out";
}

/**
 * A stable, carrier-style tracking number for a thread: "RY" and ten digits
 * in groups of four, four, and two. The last digit is a mod-10 check digit,
 * so the number is the same for a thread on every render and every device.
 */
export function trackingNumber(threadId: string): string {
	let hash = 2_166_136_261;
	for (const char of threadId) {
		hash ^= char.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 16_777_619) >>> 0;
	}
	let second = hash;
	for (const char of [...threadId].reverse()) {
		second =
			Math.imul(second ^ (char.codePointAt(0) ?? 0), 2_654_435_761) >>> 0;
	}
	const body = `${String(hash % 100_000).padStart(5, "0")}${String(
		second % 10_000
	).padStart(4, "0")}`;
	let sum = 0;
	for (const [index, digit] of [...body].entries()) {
		const value = Number(digit);
		sum += index % 2 === 0 ? value * 3 : value;
	}
	const digits = `${body}${(10 - (sum % 10)) % 10}`;
	return `RY ${digits.slice(0, 4)} ${digits.slice(4, 8)} ${digits.slice(8)}`;
}

/** Digits-and-letters key for matching a typed tracking number. */
export function trackingKey(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export interface TrackingParcel {
	/** Every agent on the thread, the first being the courier. */
	agents: InterfaceAgent[];
	courier: InterfaceAgent | undefined;
	number: string;
	/** Team or project the thread is filed under, if any. */
	service: string | null;
	serviceKind: "project" | "team" | null;
	stage: TrackingStage;
	thread: InterfaceThread;
}

function byUpdated(a: TrackingParcel, b: TrackingParcel): number {
	return (
		b.thread.updatedAt.localeCompare(a.thread.updatedAt) ||
		a.thread.id.localeCompare(b.thread.id)
	);
}

export function buildParcels(
	snapshot: InterfaceSnapshot,
	now: number
): TrackingParcel[] {
	const groups = new Map(snapshot.groups.map((group) => [group.id, group]));
	const parcels: TrackingParcel[] = [];
	for (const thread of snapshot.threads) {
		const agents: InterfaceAgent[] = [];
		for (const agentId of thread.agentIds) {
			const agent = agentById(snapshot, agentId);
			if (agent) {
				agents.push(agent);
			}
		}
		const groupId = thread.projectId ?? thread.teamId;
		const group = groupId ? groups.get(groupId) : undefined;
		const stage = trackingStage(thread, now);
		parcels.push({
			agents,
			courier: agents[0],
			number: trackingNumber(thread.id),
			service: group?.name ?? null,
			serviceKind: group?.kind ?? null,
			// Nobody can pick up a parcel with no courier: the label is all there is.
			stage: agents.length === 0 && stage === "awaiting" ? "label" : stage,
			thread,
		});
	}
	return parcels.sort(byUpdated);
}

export function parcelsForTab(
	parcels: readonly TrackingParcel[],
	tab: TrackingTab
): TrackingParcel[] {
	return tab === "all"
		? [...parcels]
		: parcels.filter((parcel) => trackingTab(parcel.stage) === tab);
}

export function tabCounts(
	parcels: readonly TrackingParcel[]
): Record<TrackingTab, number> {
	const counts: Record<TrackingTab, number> = {
		all: parcels.length,
		delivered: 0,
		exceptions: 0,
		"on-the-way": 0,
	};
	for (const parcel of parcels) {
		const tab = trackingTab(parcel.stage);
		if (tab) {
			counts[tab] += 1;
		}
	}
	return counts;
}

/** Match a search against tracking number, item title, courier, or service. */
export function matchesQuery(parcel: TrackingParcel, query: string): boolean {
	const trimmed = query.trim().toLowerCase();
	if (!trimmed) {
		return true;
	}
	const key = trackingKey(trimmed);
	if (key && trackingKey(parcel.number).includes(key)) {
		return true;
	}
	const haystack = [
		parcel.thread.title,
		parcel.service ?? "",
		...parcel.agents.map((agent) => agent.name),
	]
		.join(" ")
		.toLowerCase();
	return haystack.includes(trimmed);
}

/** The tab to open on: where the active thread lives, else On the way. */
export function defaultTab(
	parcels: readonly TrackingParcel[],
	activeThreadId: string | null
): TrackingTab {
	const active = parcels.find((parcel) => parcel.thread.id === activeThreadId);
	if (active) {
		return trackingTab(active.stage) ?? "all";
	}
	if (parcels.some((parcel) => trackingTab(parcel.stage) === "on-the-way")) {
		return "on-the-way";
	}
	return "all";
}

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

export function clockTime(date: Date): string {
	return date.toLocaleTimeString(undefined, {
		hour: "numeric",
		minute: "2-digit",
	});
}

/** "Today", "Yesterday", "Tomorrow", or "Mon 12 Oct". */
export function dayLabel(date: Date, now: number): string {
	const key = localDayKey(date);
	const today = new Date(now);
	if (key === localDayKey(today)) {
		return "Today";
	}
	const yesterday = new Date(now);
	yesterday.setDate(today.getDate() - 1);
	if (key === localDayKey(yesterday)) {
		return "Yesterday";
	}
	const tomorrow = new Date(now);
	tomorrow.setDate(today.getDate() + 1);
	if (key === localDayKey(tomorrow)) {
		return "Tomorrow";
	}
	return date.toLocaleDateString(undefined, {
		day: "numeric",
		month: "short",
		weekday: "short",
	});
}

/** dayLabel for mid-sentence use: "today", "yesterday", or "on Sat, Oct 17". */
export function dayPhrase(date: Date, now: number): string {
	const label = dayLabel(date, now);
	return ["Today", "Tomorrow", "Yesterday"].includes(label)
		? label.toLowerCase()
		: `on ${label}`;
}

/** "3 min ago", "2 hr ago", "4 days ago": the long form of compactAge. */
export function relativeAge(iso: string, now: number): string {
	const compact = compactAge(iso, now);
	if (!compact) {
		return "";
	}
	if (compact === "now") {
		return "just now";
	}
	const value = Number.parseInt(compact, 10);
	const unit = compact.slice(String(value).length);
	const names: Record<string, [string, string]> = {
		d: ["day", "days"],
		h: ["hr", "hr"],
		m: ["min", "min"],
		s: ["sec", "sec"],
		w: ["wk", "wk"],
	};
	const [one, many] = names[unit] ?? ["", ""];
	return `${value} ${value === 1 ? one : many} ago`;
}

/** "5m ago", or "just now" when the update is under a minute old. */
function agoText(iso: string, now: number): string {
	const age = compactAge(iso, now);
	if (!age) {
		return "";
	}
	return age === "now" ? "just now" : `${age} ago`;
}

/**
 * The right-hand line on a list row, in the reference's ETA column: when it
 * arrived, when it is expected, or when the courier is next due.
 */
export function rowWhen(
	parcel: TrackingParcel,
	now: number,
	events: readonly InterfaceEvent[] = []
): string {
	const ago = agoText(parcel.thread.updatedAt, now);
	switch (parcel.stage) {
		case "delivered":
			return ago ? `Delivered ${ago}` : "Delivered";
		case "out":
			return "Arriving soon";
		case "transit":
			return ago ? `Moved ${ago}` : "Moving";
		case "exception":
			return ago ? `Held ${ago}` : "Held";
		case "awaiting": {
			const next = nextCollection(parcel, events, now);
			if (next) {
				const start = new Date(next.start);
				const today = localDayKey(start) === localDayKey(new Date(now));
				return `Pickup ${today ? clockTime(start) : dayLabel(start, now)} est.`;
			}
			return ago ? `Sent ${ago}` : "Sent";
		}
		default:
			return ago ? `Created ${ago}` : "";
	}
}

// ---------------------------------------------------------------------------
// Tracking page copy
// ---------------------------------------------------------------------------

function courierName(parcel: TrackingParcel): string {
	return parcel.courier?.name ?? "No courier";
}

/**
 * True for stages where the courier's own schedule bears on this parcel:
 * before pickup and while it is still being carried.
 */
export function scheduleApplies(stage: TrackingStage): boolean {
	return stage === "awaiting" || isMoving(stage);
}

/** The courier's next projected routine, if the host shares schedules. */
export function nextCollection(
	parcel: TrackingParcel,
	events: readonly InterfaceEvent[],
	now: number
): InterfaceEvent | undefined {
	const courierId = parcel.courier?.id;
	if (!courierId) {
		return undefined;
	}
	let next: InterfaceEvent | undefined;
	for (const event of events) {
		if (event.kind !== "upcoming" || event.agentId !== courierId) {
			continue;
		}
		const start = Date.parse(event.start);
		if (Number.isNaN(start) || start < now) {
			continue;
		}
		if (!next || start < Date.parse(next.start)) {
			next = event;
		}
	}
	return next;
}

/**
 * The "expected" line under the headline. Only known times are printed as
 * times; anything inferred says "est." or speaks in terms of what is known.
 */
export function expectedLine(
	parcel: TrackingParcel,
	events: readonly InterfaceEvent[],
	now: number
): string {
	const updated = new Date(parcel.thread.updatedAt);
	const valid = !Number.isNaN(updated.getTime());
	const name = courierName(parcel);
	switch (parcel.stage) {
		case "delivered":
			return valid
				? `Delivered ${dayPhrase(updated, now)} at ${clockTime(updated)} by ${name}`
				: `Delivered by ${name}`;
		case "out":
			return `Expected shortly · estimated from ${name}'s activity`;
		case "transit":
			return `Expected when ${name} finishes the current run`;
		case "exception":
			return valid
				? `Held in transit · last scan ${relativeAge(parcel.thread.updatedAt, now)}`
				: "Held in transit";
		case "awaiting": {
			const next = nextCollection(parcel, events, now);
			if (next) {
				const start = new Date(next.start);
				return `Estimated pickup ${dayPhrase(start, now)} at ${clockTime(start)}, when ${name}'s next routine runs`;
			}
			return `Waiting for ${name} to pick it up`;
		}
		default:
			return parcel.thread.lastMessageRole
				? "No courier assigned. Add an agent to the conversation to send it."
				: "Nothing has been sent yet";
	}
}

/** The short reason shown in the exception notice. */
export function exceptionReason(parcel: TrackingParcel): string {
	return parcel.thread.runState === "interrupted"
		? "Last run was interrupted"
		: "Last run failed";
}

const SCHEDULE_TIME = /\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b/i;

/**
 * A routine's schedule phrase ("Weekdays at 9 AM"), kept only when it agrees
 * with the run's time, so a history row never prints two different times.
 * Phrases with no clock time ("Hourly") always agree.
 */
export function scheduleLabel(
	label: string | null | undefined,
	at: Date
): string | null {
	const phrase = label?.trim();
	if (!phrase) {
		return null;
	}
	const match = SCHEDULE_TIME.exec(phrase);
	if (!match) {
		return phrase;
	}
	if (Number.isNaN(at.getTime())) {
		return null;
	}
	const hour12 = Number(match[1]) % 12;
	const hour = (match[3] ?? "").toLowerCase() === "p" ? hour12 + 12 : hour12;
	const minute = Number(match[2] ?? "0");
	return at.getHours() === hour && at.getMinutes() === minute ? phrase : null;
}

export type HistoryTone = "default" | "exception" | "scheduled" | "success";

export interface HistoryEntry {
	/** RFC 3339 time when known; null for earlier scans with no recorded time. */
	at: string | null;
	detail: string | null;
	/** True when the time is projected from a schedule, not recorded. */
	estimated: boolean;
	id: string;
	/** Where the scan happened, when it adds something: a routine's schedule. */
	location: string | null;
	title: string;
	tone: HistoryTone;
}

export interface HistoryGroup {
	entries: HistoryEntry[];
	id: string;
	label: string;
}

/**
 * The latest message as scan detail. Only the courier's own words describe
 * the courier's activity; your message is quoted as yours, and only where
 * the scan is about it.
 */
function latestDetail(parcel: TrackingParcel): string | null {
	const { lastMessage, lastMessageRole } = parcel.thread;
	if (!lastMessage) {
		return null;
	}
	if (lastMessageRole === "assistant") {
		return lastMessage;
	}
	if (lastMessageRole === "user" && parcel.stage === "awaiting") {
		return `You: ${lastMessage}`;
	}
	return null;
}

function latestScan(parcel: TrackingParcel): HistoryEntry {
	const name = courierName(parcel);
	const base = {
		at: parcel.thread.updatedAt,
		detail: latestDetail(parcel),
		estimated: false,
		id: "latest",
		location: null,
	};
	switch (parcel.stage) {
		case "delivered":
			return { ...base, title: `Delivered: ${name} replied`, tone: "success" };
		case "out":
			return {
				...base,
				title: `Out for delivery: ${name} is writing back`,
				tone: "default",
			};
		case "transit":
			return {
				...base,
				title: `In transit: ${name} is working`,
				tone: "default",
			};
		case "exception":
			return {
				...base,
				title:
					parcel.thread.runState === "interrupted"
						? "Exception: run interrupted"
						: "Exception: run failed",
				tone: "exception",
			};
		case "awaiting":
			return {
				...base,
				title: "Order placed: you sent a message",
				tone: "default",
			};
		default:
			return {
				...base,
				detail: parcel.thread.lastMessage
					? `You: ${parcel.thread.lastMessage}`
					: null,
				title: "Label created: no courier assigned",
				tone: "default",
			};
	}
}

/**
 * Tracking history, newest first, grouped by day. Only the latest activity
 * carries a recorded time, and the courier's next routine an estimated one;
 * the earlier scans the stage implies are listed under "Earlier" untimed.
 */
export function trackingHistory(
	parcel: TrackingParcel,
	events: readonly InterfaceEvent[],
	now: number
): HistoryGroup[] {
	const timed: HistoryEntry[] = [latestScan(parcel)];
	const groups: HistoryGroup[] = [];
	// Routines belong to the courier, not the parcel: only the next one is
	// shown, and only while it can still affect when this parcel moves.
	const next = scheduleApplies(parcel.stage)
		? nextCollection(parcel, events, now)
		: undefined;
	if (next) {
		const start = new Date(next.start);
		groups.push({
			entries: [
				{
					at: next.start,
					detail: scheduleLabel(next.label, start),
					estimated: true,
					id: `event-${next.id}`,
					location: null,
					title: `${courierName(parcel)}'s next routine · ${next.title}`,
					tone: "scheduled",
				},
			],
			id: "upcoming",
			label: `Upcoming · ${dayLabel(start, now)}`,
		});
	}
	timed.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));

	for (const entry of timed) {
		const date = new Date(entry.at ?? "");
		if (Number.isNaN(date.getTime())) {
			continue;
		}
		const id = localDayKey(date);
		const group = groups.find((item) => item.id === id);
		if (group) {
			group.entries.push(entry);
		} else {
			groups.push({ entries: [entry], id, label: dayLabel(date, now) });
		}
	}

	const earlier = earlierScans(parcel);
	if (earlier.length > 0) {
		groups.push({
			entries: earlier,
			id: "earlier",
			label: "Earlier, time not recorded",
		});
	}
	return groups;
}

/** Steps the stage implies happened before the latest activity. */
function earlierScans(parcel: TrackingParcel): HistoryEntry[] {
	const step = STAGE_STEP[parcel.stage];
	const name = courierName(parcel);
	const location = null;
	const entries: HistoryEntry[] = [];
	if (step >= 2 || parcel.stage === "delivered") {
		entries.push({
			at: null,
			detail: null,
			estimated: false,
			id: "picked-up",
			location,
			title: `Picked up by ${name}`,
			tone: "default",
		});
	}
	if (parcel.stage !== "awaiting" && parcel.stage !== "label") {
		entries.push({
			at: null,
			detail: null,
			estimated: false,
			id: "order-placed",
			location,
			title: "Order placed: you sent a message",
			tone: "default",
		});
	}
	return entries;
}

export interface CourierRoutine {
	/** RFC 3339 start: recorded for past runs, projected for the next one. */
	at: string;
	estimated: boolean;
	failed: boolean;
	id: string;
	title: string;
}

/**
 * The courier's own routines, kept apart from the parcel's scans: the next
 * projected run and the two most recent ones.
 */
export function courierRoutines(
	parcel: TrackingParcel,
	events: readonly InterfaceEvent[],
	now: number
): CourierRoutine[] {
	const courierId = parcel.courier?.id;
	if (!courierId) {
		return [];
	}
	const routines: CourierRoutine[] = [];
	// Where the next routine bears on this parcel, the history already shows it.
	const next = scheduleApplies(parcel.stage)
		? undefined
		: nextCollection(parcel, events, now);
	if (next) {
		routines.push({
			at: next.start,
			estimated: true,
			failed: false,
			id: next.id,
			title: next.title,
		});
	}
	const past = events
		.filter(
			(event) =>
				event.kind === "past" &&
				event.agentId === courierId &&
				Date.parse(event.start) <= now
		)
		.sort((a, b) => b.start.localeCompare(a.start))
		.slice(0, 2);
	for (const event of past) {
		routines.push({
			at: event.start,
			estimated: false,
			failed: event.outcome === "failure",
			id: event.id,
			title: event.title,
		});
	}
	return routines;
}
