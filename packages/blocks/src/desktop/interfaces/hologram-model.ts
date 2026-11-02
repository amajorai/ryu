import { translate as tr } from "@ryu/i18n/lite";
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

export {
	fanAround,
	MENU_STEPS,
	type MenuItemPlacement,
	type MenuLayoutInput,
	normalizeAngle,
	polar,
	type RingSlot,
	radialMenuLayout,
	ringSlots,
} from "./hologram-model-ring.ts";

export {
	clock,
	countdown,
	dateStamp,
	dayTag,
	statusPhrase,
} from "./hologram-model-time.ts";

export const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

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
	return thread.title.trim() || tr("Untitled thread");
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
		return tr("Working late");
	}
	if (hour < 12) {
		return tr("Good morning");
	}
	if (hour < 17) {
		return tr("Good afternoon");
	}
	return tr("Good evening");
}

/** The briefing line, built from real counts and the local hour. */
export function briefing(totals: HoloTotals, hour: number): string {
	const hello = greeting(hour);
	if (totals.agents === 0 && totals.threads === 0) {
		return tr("{hello}. No agents are set up yet.", { hello });
	}
	return tr(
		"{hello}. {working, plural, =0 {No agents working} one {# agent working} other {# agents working}}, {needsYou, plural, =0 {nothing needs your attention} one {# item needs your attention} other {# items need your attention}}.",
		{
			hello,
			needsYou: totals.attention + totals.yourTurn,
			working: totals.workingAgents,
		}
	);
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
