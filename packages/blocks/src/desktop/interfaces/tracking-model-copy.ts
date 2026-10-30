import { type InterfaceEvent, localDayKey } from "@ryuhq/protocol/interfaces";
import type { TrackingParcel, TrackingStage } from "./tracking-model.ts";
import { isMoving, STAGE_STEP } from "./tracking-model-stages.ts";
import {
	clockTime,
	dayLabel,
	dayPhrase,
	relativeAge,
} from "./tracking-model-time.ts";

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
