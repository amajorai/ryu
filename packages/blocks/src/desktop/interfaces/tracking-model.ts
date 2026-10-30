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
import { nextCollection } from "./tracking-model-copy.ts";
import { STAGE_STEP } from "./tracking-model-stages.ts";
import { clockTime, dayLabel } from "./tracking-model-time.ts";

export {
	exceptionReason,
	expectedLine,
	type HistoryEntry,
	type HistoryGroup,
	type HistoryTone,
	nextCollection,
	scheduleApplies,
	scheduleLabel,
	trackingHistory,
} from "./tracking-model-copy.ts";
export {
	type CourierRoutine,
	courierRoutines,
} from "./tracking-model-routines.ts";
export { isMoving } from "./tracking-model-stages.ts";
export {
	clockTime,
	dayLabel,
	dayPhrase,
	relativeAge,
} from "./tracking-model-time.ts";

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
