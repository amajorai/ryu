import {
	type InterfaceAgent,
	type InterfaceEvent,
	type InterfaceSnapshot,
	type InterfaceThread,
	resolveAgentHandle,
	THREAD_STATUS_ORDER,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { initials } from "./interface-renderer.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Agents on the inner ring before a second, outer ring opens. */
export const INNER_RING_CAPACITY = 8;
/** Rows a panel keeps before it says how many more there are. */
export const PANEL_ROW_LIMIT = 12;

export interface HoloAgent {
	agent: InterfaceAgent;
	/** Threads whose last run failed or was interrupted. */
	failed: number;
	id: string;
	initials: string;
	/** Newest thread the agent is on, for "Open latest". */
	latestThreadId: string | null;
	name: string;
	/** Threads of this agent that need the user (attention or your turn). */
	needsYou: number;
	status: InterfaceAgent["status"];
	threadCount: number;
	/** Live runs among this agent's threads. */
	workingThreads: number;
}

export interface HoloThread {
	agentNames: string[];
	id: string;
	status: ThreadStatus;
	thread: InterfaceThread;
	title: string;
}

export interface HoloTotals {
	agents: number;
	attention: number;
	quiet: number;
	threads: number;
	/** Scheduled runs in the next 24 hours; a routine that repeats counts each run. */
	upcoming24h: number;
	waiting: number;
	working: number;
	workingAgents: number;
	yourTurn: number;
}

export interface HoloPulse {
	/** 0..1 brightness of the core. */
	intensity: number;
	/** Seconds per pulse: slow when idle, quicker as more agents work. */
	period: number;
}

export interface HologramView {
	agents: HoloAgent[];
	/** Thread counts per status, in {@link THREAD_STATUS_ORDER}. */
	distribution: { count: number; status: ThreadStatus }[];
	/** Most recent activity across all threads, epoch ms (null when none). */
	lastUpdate: number | null;
	/** Largest thread count of any agent, for ring segments. */
	maxThreads: number;
	/** Threads that need the user: attention first, then your turn. */
	priority: HoloThread[];
	pulse: HoloPulse;
	/** Scheduled runs that already happened, newest first. */
	recent: InterfaceEvent[];
	/** Upcoming scheduled runs, soonest first. */
	schedule: InterfaceEvent[];
	totals: HoloTotals;
	/** Threads with a live run, newest first. */
	working: HoloThread[];
}

function byRecency(a: InterfaceThread, b: InterfaceThread): number {
	return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

/** A thread title that is never blank. */
export function holoThreadTitle(thread: InterfaceThread): string {
	return thread.title.trim() || "Untitled thread";
}

function toHoloThread(
	thread: InterfaceThread,
	names: Map<string, string>
): HoloThread {
	return {
		agentNames: thread.agentIds
			.map((id) => names.get(id))
			.filter((name): name is string => name !== undefined),
		id: thread.id,
		status: threadStatus(thread),
		thread,
		title: holoThreadTitle(thread),
	};
}

/** Core pulse from how many agents are working out of all of them. */
export function corePulse(
	workingAgents: number,
	agentCount: number
): HoloPulse {
	if (workingAgents <= 0 || agentCount <= 0) {
		return { intensity: 0.35, period: 4.8 };
	}
	const share = Math.min(1, workingAgents / agentCount);
	return {
		intensity: Math.round((0.6 + 0.4 * share) * 100) / 100,
		period: Math.round((2.8 - 1.6 * share) * 10) / 10,
	};
}

function eventRuns(event: InterfaceEvent): number {
	return Math.max(1, event.count ?? 1);
}

export function buildHologram(
	snapshot: InterfaceSnapshot,
	now: number
): HologramView {
	const names = new Map(snapshot.agents.map((agent) => [agent.id, agent.name]));
	const sorted = [...snapshot.threads].sort(byRecency);
	const threads = sorted.map((thread) => toHoloThread(thread, names));
	const counts = new Map<ThreadStatus, number>();
	for (const item of threads) {
		counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
	}

	const agents = snapshot.agents.map((agent): HoloAgent => {
		const own = threads.filter((item) =>
			item.thread.agentIds.includes(agent.id)
		);
		return {
			agent,
			failed: own.filter((item) => item.status === "attention").length,
			id: agent.id,
			initials: initials(agent.name),
			latestThreadId: own[0]?.id ?? null,
			name: agent.name,
			needsYou: own.filter(
				(item) => item.status === "attention" || item.status === "your-turn"
			).length,
			status: agent.status,
			threadCount: own.length,
			workingThreads: own.filter((item) => item.status === "working").length,
		};
	});

	const rank = (status: ThreadStatus) => THREAD_STATUS_ORDER.indexOf(status);
	const priority = threads
		.filter(
			(item) => item.status === "attention" || item.status === "your-turn"
		)
		.sort((a, b) => rank(a.status) - rank(b.status));
	const working = threads.filter((item) => item.status === "working");

	const schedule = (snapshot.events ?? [])
		.filter((event) => {
			const start = Date.parse(event.start);
			return (
				event.kind === "upcoming" &&
				!Number.isNaN(start) &&
				start >= now - MINUTE
			);
		})
		.sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
	const recent = (snapshot.events ?? [])
		.filter(
			(event) => event.kind === "past" && !Number.isNaN(Date.parse(event.start))
		)
		.sort((a, b) => b.start.localeCompare(a.start) || a.id.localeCompare(b.id));
	let upcoming24h = 0;
	for (const event of schedule) {
		if (Date.parse(event.start) - now <= DAY) {
			upcoming24h += eventRuns(event);
		}
	}

	const workingAgents = snapshot.agents.filter(
		(agent) => agent.status === "working"
	).length;
	const newest = sorted[0] ? Date.parse(sorted[0].updatedAt) : Number.NaN;

	return {
		agents,
		distribution: THREAD_STATUS_ORDER.map((status) => ({
			count: counts.get(status) ?? 0,
			status,
		})),
		lastUpdate: Number.isNaN(newest) ? null : newest,
		maxThreads: Math.max(1, ...agents.map((agent) => agent.threadCount)),
		priority,
		pulse: corePulse(workingAgents, snapshot.agents.length),
		recent,
		schedule,
		totals: {
			agents: snapshot.agents.length,
			attention: counts.get("attention") ?? 0,
			quiet: counts.get("quiet") ?? 0,
			threads: snapshot.threads.length,
			upcoming24h,
			waiting: counts.get("waiting") ?? 0,
			working: counts.get("working") ?? 0,
			workingAgents,
			yourTurn: counts.get("your-turn") ?? 0,
		},
		working,
	};
}

/** Threads one agent is on, in priority then recency order. */
export function agentThreads(
	snapshot: InterfaceSnapshot,
	agentId: string
): HoloThread[] {
	const names = new Map(snapshot.agents.map((agent) => [agent.id, agent.name]));
	const rank = (status: ThreadStatus) => THREAD_STATUS_ORDER.indexOf(status);
	return snapshot.threads
		.filter((thread) => thread.agentIds.includes(agentId))
		.sort(byRecency)
		.map((thread) => toHoloThread(thread, names))
		.sort((a, b) => rank(a.status) - rank(b.status));
}

export function greeting(hour: number): string {
	if (hour < 5) {
		return "Working late";
	}
	if (hour < 12) {
		return "Good morning";
	}
	if (hour < 17) {
		return "Good afternoon";
	}
	return "Good evening";
}

const plural = (count: number, one: string, many: string) =>
	`${count} ${count === 1 ? one : many}`;

/** The briefing line, built from real counts and the local hour. */
export function briefing(totals: HoloTotals, hour: number): string {
	const hello = greeting(hour);
	if (totals.agents === 0 && totals.threads === 0) {
		return `${hello}. No agents are set up yet.`;
	}
	const working =
		totals.workingAgents === 0
			? "No agents working"
			: `${plural(totals.workingAgents, "agent", "agents")} working`;
	const needsYou = totals.attention + totals.yourTurn;
	const attention =
		needsYou === 0
			? "nothing needs your attention"
			: `${plural(needsYou, "item needs", "items need")} your attention`;
	return `${hello}. ${working}, ${attention}.`;
}

export interface RingSlot {
	/** Degrees clockwise from 12 o'clock, before the ring's spin. */
	angle: number;
	id: string;
	ring: 0 | 1;
}

/**
 * Places agents on one ring, or two when there are more than
 * {@link INNER_RING_CAPACITY}. The outer ring is offset by half a step so its
 * nodes sit between the inner ones.
 */
export function ringSlots(ids: readonly string[]): RingSlot[] {
	const inner =
		ids.length > INNER_RING_CAPACITY
			? ids.slice(0, Math.ceil(ids.length / 2.4))
			: ids;
	const outer = ids.slice(inner.length);
	const place = (list: readonly string[], ring: 0 | 1): RingSlot[] => {
		const step = 360 / Math.max(1, list.length);
		const offset = ring === 1 ? step / 2 : 0;
		return list.map((id, index) => ({
			angle: Math.round((offset + step * index) * 100) / 100,
			id,
			ring,
		}));
	};
	return [...place(inner, 0), ...place(outer, 1)];
}

/** A point on a circle, angle in degrees clockwise from 12 o'clock. */
export function polar(angle: number, radius: number): { x: number; y: number } {
	const radians = ((angle - 90) * Math.PI) / 180;
	return {
		x: Math.round(Math.cos(radians) * radius * 100) / 100,
		y: Math.round(Math.sin(radians) * radius * 100) / 100,
	};
}

/** Normalizes degrees to [0, 360). */
export function normalizeAngle(angle: number): number {
	return ((angle % 360) + 360) % 360;
}

export interface MenuLayoutInput {
	/** The box the menu must stay inside (the orbit). */
	box: { height: number; width: number };
	/** Clear space kept between an item and the box edge. */
	inset?: number;
	/** Item sizes, in menu order. */
	items: readonly { height: number; width: number }[];
	/**
	 * The node's own label under it, from the node centre; items keep clear
	 * of it.
	 */
	keepOut?: { bottom: number; left: number; right: number; top: number };
	/** Node centre inside the box. */
	nodeX: number;
	nodeY: number;
	/** Direction from the core to the node, degrees clockwise from 12 o'clock. */
	outward: number;
	/** Radius of the arc the items' near edges sit on, around the node. */
	radius: number;
}

export interface MenuItemPlacement {
	/** The item's direction from the node, degrees clockwise from 12 o'clock. */
	angle: number;
	/** The item's top-left corner, from the node centre. */
	left: number;
	/** Distance from the node centre to the arc point the item is anchored to. */
	reach: number;
	top: number;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/** Angles between neighbouring items, tried narrowest first. */
export const MENU_STEPS = [44, 56, 68] as const;
const MENU_ITEM_GAP = 4;

interface Rect {
	bottom: number;
	left: number;
	right: number;
	top: number;
}

const overlaps = (a: Rect, b: Rect, gap: number) =>
	a.left < b.right + gap &&
	b.left < a.right + gap &&
	a.top < b.bottom + gap &&
	b.top < a.bottom + gap;

/** Rays this close to vertical centre their item on the ray. */
const CENTRED_RAY = 0.35;

/**
 * One item on the fan, anchored where its ray meets the arc: on the right
 * the item starts there, on the left it ends there, and straight up or down
 * it is centred over or under it. Every item hugs the same arc, whatever
 * its width.
 */
function placeOnRay(
	angle: number,
	size: { height: number; width: number },
	radius: number
): MenuItemPlacement {
	const unit = polar(angle, 1);
	const point = polar(angle, radius);
	let left = point.x - size.width / 2;
	let top = unit.y > 0 ? point.y : point.y - size.height;
	if (unit.x > CENTRED_RAY) {
		left = point.x;
		top = point.y - size.height / 2;
	} else if (unit.x < -CENTRED_RAY) {
		left = point.x - size.width;
		top = point.y - size.height / 2;
	}
	return {
		angle: round2(normalizeAngle(angle)),
		left: round2(left),
		reach: radius,
		top: round2(top),
	};
}

/**
 * The items fanned around the node at equal angular steps, centred on
 * `centre`, assigned in reading order: top to bottom when the fan opens to
 * a side, left to right when it opens up or down.
 */
export function fanAround(
	items: MenuLayoutInput["items"],
	centre: number,
	step: number,
	radius: number
): MenuItemPlacement[] {
	const middle = (items.length - 1) / 2;
	const angles = items.map((_, index) => centre + (index - middle) * step);
	const sideways = Math.abs(polar(centre, 1).x) > 0.7;
	const key = (angle: number) => {
		const point = polar(angle, 1);
		return sideways ? point.y : point.x;
	};
	const ordered = [...angles].sort((a, b) => key(a) - key(b));
	return items.map((item, index) =>
		placeOnRay(ordered[index] ?? centre, item, radius)
	);
}

/**
 * Lays the radial menu out around the node: the items fan out on one arc,
 * toward the core first (where the deck is open), turning a step at a time
 * either way until one fits, widening the fan when items would crowd. A layout
 * must stay inside the box and off the node's label.
 */
export function radialMenuLayout(input: MenuLayoutInput): MenuItemPlacement[] {
	const { box, items, keepOut, nodeX, nodeY, outward, radius } = input;
	const inset = input.inset ?? 4;
	const fits = (placements: MenuItemPlacement[]) => {
		const rects = placements.map((place, index) => {
			const size = items[index] ?? { height: 0, width: 0 };
			return {
				bottom: place.top + size.height,
				left: place.left,
				right: place.left + size.width,
				top: place.top,
			};
		});
		for (const [index, rect] of rects.entries()) {
			if (
				nodeX + rect.left < inset ||
				nodeY + rect.top < inset ||
				nodeX + rect.right > box.width - inset ||
				nodeY + rect.bottom > box.height - inset
			) {
				return false;
			}
			if (keepOut && overlaps(rect, keepOut, 0)) {
				return false;
			}
			for (const other of rects.slice(index + 1)) {
				if (overlaps(rect, other, MENU_ITEM_GAP)) {
					return false;
				}
			}
		}
		return true;
	};
	const inward = outward + 180;
	// Straight toward the core, then turning 15 degrees at a time either way
	// until the fan points straight out.
	const centres = [inward];
	for (let turn = 15; turn <= 180; turn += 15) {
		centres.push(inward - turn, inward + turn);
	}
	for (const centre of centres) {
		for (const step of MENU_STEPS) {
			const placements = fanAround(items, centre, step, radius);
			if (fits(placements)) {
				return placements;
			}
		}
	}
	return fanAround(items, inward, MENU_STEPS[0], radius);
}

/**
 * A routine's cadence, shortened for a narrow row: "Every Monday at 9 AM"
 * reads "Every Monday 9 AM".
 */
export function shortCadence(label: string): string {
	return label.replace(/\s+at\s+(?=\d)/i, " ").trim();
}

/**
 * Time since a live run's last signal as a running clock: "04:12", or
 * "1:02:03" past the hour.
 */
export function elapsedClock(updatedAt: string, now: number): string {
	const since = Date.parse(updatedAt);
	const seconds = Number.isNaN(since)
		? 0
		: Math.max(0, Math.floor((now - since) / 1000));
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const rest = seconds % 60;
	const mmss = `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
	return hours > 0 ? `${hours}:${mmss}` : mmss;
}

export interface ParsedCommand {
	agentId: string | null;
	prompt: string;
}

/**
 * A command bar entry: a leading `@handle` picks the agent, the rest is the
 * prompt. An unknown handle stays in the prompt as typed.
 */
export function parseCommand(
	snapshot: InterfaceSnapshot,
	text: string
): ParsedCommand {
	const trimmed = text.trim();
	const match = /^@(\S+)\s*([\s\S]*)$/.exec(trimmed);
	if (match) {
		const agent = resolveAgentHandle(snapshot, match[1] ?? "");
		if (agent) {
			return { agentId: agent.id, prompt: (match[2] ?? "").trim() };
		}
	}
	return { agentId: null, prompt: trimmed };
}

const pad = (value: number) => String(value).padStart(2, "0");

/** 24-hour local clock, "19:42" or "19:42:07". */
export function clock(time: number, seconds = false): string {
	const date = new Date(time);
	const base = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
	return seconds ? `${base}:${pad(date.getSeconds())}` : base;
}

const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;
const MONTHS = [
	"JAN",
	"FEB",
	"MAR",
	"APR",
	"MAY",
	"JUN",
	"JUL",
	"AUG",
	"SEP",
	"OCT",
	"NOV",
	"DEC",
] as const;

/** "WED 14 OCT" in local time. */
export function dateStamp(time: number): string {
	const date = new Date(time);
	return `${WEEKDAYS[date.getDay()]} ${pad(date.getDate())} ${MONTHS[date.getMonth()]}`;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTH_NAMES = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
] as const;

/**
 * Which day a time falls on, relative to now: "Today", a weekday within the
 * week either side ("Thu"), or a date beyond that ("23 Oct").
 */
export function dayTag(time: number, now: number): string {
	const date = new Date(time);
	const startOf = (value: Date) =>
		new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
	const days = Math.round((startOf(date) - startOf(new Date(now))) / DAY);
	if (days === 0) {
		return "Today";
	}
	if (Math.abs(days) < 7) {
		return DAY_NAMES[date.getDay()] ?? "";
	}
	return `${date.getDate()} ${MONTH_NAMES[date.getMonth()]}`;
}

/** "in 40m", "in 3h", "in 2d" (or "now") until an upcoming start. */
export function countdown(iso: string, now: number): string {
	const start = Date.parse(iso);
	if (Number.isNaN(start)) {
		return "";
	}
	const minutes = Math.round((start - now) / MINUTE);
	if (minutes < 1) {
		return "now";
	}
	if (minutes < 60) {
		return `in ${minutes}m`;
	}
	const hours = Math.round(minutes / 60);
	if (hours < 48) {
		return `in ${hours}h`;
	}
	return `in ${Math.round(hours / 24)}d`;
}

/** Short status phrase for a thread's meta line. */
export function statusPhrase(thread: InterfaceThread): string {
	const status = threadStatus(thread);
	if (status === "attention") {
		return thread.runState === "interrupted" ? "Run interrupted" : "Run failed";
	}
	if (status === "your-turn") {
		return "Your turn";
	}
	if (status === "working") {
		return "Running";
	}
	if (status === "waiting") {
		return "Waiting on agent";
	}
	return "Not started";
}
