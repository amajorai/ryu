import {
	type InterfaceAgent,
	type InterfaceEvent,
	type InterfaceGroup,
	type InterfaceSnapshot,
	type InterfaceThread,
	localDayKey,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

/**
 * Status page view model. Agents are the page's components, grouped by team;
 * a thread whose last run failed or was interrupted is an open incident, and
 * so is a scheduled run that failed and has not succeeded since. Everything
 * here is pure so the page and its tests read the same numbers.
 */

/** Days of history in each component's uptime strip. */
export const UPTIME_DAYS = 30;
/**
 * What the uptime strips are built from, said on the page. The snapshot holds
 * each thread's latest activity and latest run outcome only, so a failure that
 * a later retry replaced leaves no trace; scheduled runs carry real history.
 */
export const UPTIME_BASIS =
	"Conversations count once, on the day of their latest run and with its outcome. Scheduled runs keep their full history.";
/** Days listed under "Past incidents", today included. */
export const HISTORY_DAYS = 7;
/** A failed scheduled run stays an open incident this long without a retry. */
const OPEN_RUN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** How much of a day a partial failure costs in the uptime figure. */
const DEGRADED_DAY_WEIGHT = 0.3;

export type ComponentState = "degraded" | "operational" | "working";
export type DayLevel = "degraded" | "operational" | "outage";
export type OverallState = "degraded" | "operational" | "partial";
export type IncidentSeverity = "degraded" | "outage";

export const COMPONENT_STATE_LABELS: Record<ComponentState, string> = {
	degraded: "Degraded performance",
	operational: "Operational",
	working: "Working",
};

export const OVERALL_LABELS: Record<OverallState, string> = {
	degraded: "Degraded performance",
	operational: "All systems operational",
	partial: "Partial outage",
};

export const DAY_LEVEL_LABELS: Record<DayLevel, string> = {
	degraded: "Partial outage",
	operational: "No downtime recorded",
	outage: "Outage",
};

/** One day of one component's history. */
export interface UptimeDay {
	/** Threads with activity that day. */
	active: number;
	/** Local `YYYY-MM-DD`. */
	key: string;
	level: DayLevel;
	/** Titles of the failed or interrupted work that day, newest first. */
	problems: string[];
	/** Local midnight that starts the day. */
	start: number;
	/** Scheduled runs that finished cleanly that day. */
	successfulRuns: number;
}

export interface StatusComponent {
	agent: InterfaceAgent;
	/** Oldest first, ending today. */
	days: UptimeDay[];
	state: ComponentState;
	/** Share of the window without failures, 0 to 1. */
	uptime: number;
}

export interface StatusSection {
	components: StatusComponent[];
	/** The team, or null for components outside every team. */
	group: InterfaceGroup | null;
	state: ComponentState;
}

export interface StatusIncident {
	/** Names of the affected components (agents), empty when none. */
	affected: string[];
	agentIds: string[];
	/** RFC 3339 time the incident began (the failure). */
	at: string;
	/** The latest update, in the incident's own words when there are any. */
	body: string;
	id: string;
	kind: "run" | "thread";
	/** Present when the incident is resolved: when the next run succeeded. */
	resolvedAt: string | null;
	/** The routine's schedule phrase, for scheduled-run incidents. */
	schedule: string | null;
	severity: IncidentSeverity;
	/** The word that leads the latest update ("Failed", "Interrupted"...). */
	stage: string;
	/** The thread to open, for thread incidents. */
	threadId: string | null;
	title: string;
}

export interface StatusMaintenance {
	affected: string | null;
	count: number | null;
	id: string;
	schedule: string | null;
	start: string;
	title: string;
}

export interface StatusHistoryDay {
	incidents: StatusIncident[];
	key: string;
	start: number;
}

export interface StatusPage {
	history: StatusHistoryDay[];
	/** Open incidents, newest first. */
	incidents: StatusIncident[];
	maintenance: StatusMaintenance[];
	overall: OverallState;
	sections: StatusSection[];
}

const STATE_RANK: Record<ComponentState, number> = {
	degraded: 2,
	operational: 0,
	working: 1,
};

/** The more serious of component states (a group shows its worst member). */
export function worstState(states: readonly ComponentState[]): ComponentState {
	let worst: ComponentState = "operational";
	for (const state of states) {
		if (STATE_RANK[state] > STATE_RANK[worst]) {
			worst = state;
		}
	}
	return worst;
}

/** Local midnights for the `count` days ending today, oldest first. */
export function dayStarts(now: number, count: number): number[] {
	const today = new Date(now);
	const starts: number[] = [];
	for (let offset = count - 1; offset >= 0; offset -= 1) {
		starts.push(
			new Date(
				today.getFullYear(),
				today.getMonth(),
				today.getDate() - offset
			).getTime()
		);
	}
	return starts;
}

function dayKeyOf(iso: string): string | null {
	const time = Date.parse(iso);
	return Number.isNaN(time) ? null : localDayKey(new Date(time));
}

function routineKey(event: InterfaceEvent): string {
	return `${event.agentId ?? ""}\u0000${event.title}`;
}

/**
 * For each failed past run, the start of the next successful run of the same
 * routine (same title and agent), or null when it has not succeeded since.
 */
function runResolutions(events: readonly InterfaceEvent[]) {
	// `filter` returns a fresh array, so sorting it in place is safe; `toSorted`
	// is ES2023 and missing from the desktop's ES2022 lib and older webviews.
	const past = events
		.filter((event) => event.kind === "past" && event.outcome)
		.sort((a, b) => a.start.localeCompare(b.start));
	const resolved = new Map<string, string | null>();
	for (const [index, event] of past.entries()) {
		if (event.outcome !== "failure") {
			continue;
		}
		const key = routineKey(event);
		const next = past
			.slice(index + 1)
			.find(
				(later) => later.outcome === "success" && routineKey(later) === key
			);
		resolved.set(event.id, next?.start ?? null);
	}
	return resolved;
}

function agentNames(
	agents: ReadonlyMap<string, InterfaceAgent>,
	ids: readonly string[]
): string[] {
	const names: string[] = [];
	for (const id of ids) {
		const agent = agents.get(id);
		if (agent) {
			names.push(agent.name);
		}
	}
	return names;
}

function threadIncident(
	thread: InterfaceThread,
	agents: ReadonlyMap<string, InterfaceAgent>
): StatusIncident {
	const interrupted = thread.runState === "interrupted";
	const fallback = interrupted
		? "The run stopped before it finished."
		: "The last run failed before it finished.";
	return {
		affected: agentNames(agents, thread.agentIds),
		agentIds: thread.agentIds,
		at: thread.updatedAt,
		body: thread.lastMessage?.trim() || fallback,
		id: `thread:${thread.id}`,
		kind: "thread",
		resolvedAt: null,
		schedule: null,
		severity: interrupted ? "degraded" : "outage",
		stage: interrupted ? "Interrupted" : "Failed",
		threadId: thread.id,
		title: thread.title.trim() || "Untitled thread",
	};
}

function runIncident(
	event: InterfaceEvent,
	resolvedAt: string | null,
	agents: ReadonlyMap<string, InterfaceAgent>
): StatusIncident {
	const agentIds = event.agentId ? [event.agentId] : [];
	return {
		affected: agentNames(agents, agentIds),
		agentIds,
		at: event.start,
		body: resolvedAt
			? "The next scheduled run finished cleanly."
			: "The scheduled run did not finish, and it has not succeeded since.",
		id: `run:${event.id}`,
		kind: "run",
		resolvedAt,
		schedule: event.label,
		severity: "outage",
		stage: resolvedAt ? "Resolved" : "Failed",
		threadId: null,
		title: `${event.title} run failed`,
	};
}

function newestFirst(a: StatusIncident, b: StatusIncident): number {
	return b.at.localeCompare(a.at) || a.id.localeCompare(b.id);
}

interface DayTally {
	active: number;
	failures: number;
	interruptions: number;
	problems: { at: string; title: string }[];
	successfulRuns: number;
}

function emptyTally(): DayTally {
	return {
		active: 0,
		failures: 0,
		interruptions: 0,
		problems: [],
		successfulRuns: 0,
	};
}

function dayLevel(tally: DayTally): DayLevel {
	if (tally.failures > 0) {
		const healthy = tally.successfulRuns + tally.active;
		return healthy > 0 ? "degraded" : "outage";
	}
	return tally.interruptions > 0 ? "degraded" : "operational";
}

/**
 * Per agent, per day, what happened: threads touched and runs finished. A
 * thread counts once, on the day of its latest activity with its latest run
 * outcome (the snapshot has no per-thread run history); only scheduled runs
 * contribute past records. The page says so ({@link UPTIME_BASIS}).
 */
function tallyDays(snapshot: InterfaceSnapshot) {
	const tallies = new Map<string, Map<string, DayTally>>();
	const tallyFor = (agentId: string, key: string): DayTally => {
		let byDay = tallies.get(agentId);
		if (!byDay) {
			byDay = new Map();
			tallies.set(agentId, byDay);
		}
		let tally = byDay.get(key);
		if (!tally) {
			tally = emptyTally();
			byDay.set(key, tally);
		}
		return tally;
	};
	for (const thread of snapshot.threads) {
		const key = dayKeyOf(thread.updatedAt);
		if (!key) {
			continue;
		}
		const failed = thread.runState === "failed";
		const interrupted = thread.runState === "interrupted";
		for (const agentId of thread.agentIds) {
			const tally = tallyFor(agentId, key);
			if (failed && !thread.running) {
				tally.failures += 1;
				tally.problems.push({ at: thread.updatedAt, title: thread.title });
			} else if (interrupted && !thread.running) {
				tally.interruptions += 1;
				tally.problems.push({ at: thread.updatedAt, title: thread.title });
			} else {
				tally.active += 1;
			}
		}
	}
	for (const event of snapshot.events ?? []) {
		const key = dayKeyOf(event.start);
		if (!(key && event.kind === "past" && event.agentId)) {
			continue;
		}
		const tally = tallyFor(event.agentId, key);
		if (event.outcome === "failure") {
			tally.failures += 1;
			tally.problems.push({ at: event.start, title: `${event.title} run` });
		} else if (event.outcome === "success") {
			tally.successfulRuns += Math.max(1, event.count ?? 1);
		}
	}
	return tallies;
}

function uptimeDays(
	byDay: ReadonlyMap<string, DayTally> | undefined,
	starts: readonly number[]
): UptimeDay[] {
	return starts.map((start) => {
		const key = localDayKey(new Date(start));
		const tally = byDay?.get(key) ?? emptyTally();
		return {
			active: tally.active,
			key,
			level: dayLevel(tally),
			problems: [...tally.problems]
				.sort((a, b) => b.at.localeCompare(a.at))
				.map((problem) => problem.title.trim() || "Untitled thread"),
			start,
			successfulRuns: tally.successfulRuns,
		};
	});
}

/** Share of days without failures; a partial day costs a fraction. */
export function uptimeShare(days: readonly UptimeDay[]): number {
	if (days.length === 0) {
		return 1;
	}
	let lost = 0;
	for (const day of days) {
		if (day.level === "outage") {
			lost += 1;
		} else if (day.level === "degraded") {
			lost += DEGRADED_DAY_WEIGHT;
		}
	}
	return Math.max(0, (days.length - lost) / days.length);
}

/** "99.98" style: two decimals, dropping to none for a clean 100. */
export function formatUptime(share: number): string {
	const percent = Math.floor(share * 10_000) / 100;
	return percent >= 100 ? "100" : percent.toFixed(2);
}

function overallState(
	incidents: readonly StatusIncident[],
	degradedComponents: number
): OverallState {
	if (incidents.length === 0) {
		return "operational";
	}
	return degradedComponents >= 2 ? "partial" : "degraded";
}

/** Build the whole page from one snapshot at one moment. */
export function buildStatusPage(
	snapshot: InterfaceSnapshot,
	now: number
): StatusPage {
	const agents = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
	const events = snapshot.events ?? [];
	const resolutions = runResolutions(events);

	const threadIncidents = snapshot.threads
		.filter((thread) => threadStatus(thread) === "attention")
		.map((thread) => threadIncident(thread, agents));
	const runIncidents: StatusIncident[] = [];
	for (const event of events) {
		if (!resolutions.has(event.id)) {
			continue;
		}
		runIncidents.push(
			runIncident(event, resolutions.get(event.id) ?? null, agents)
		);
	}
	const allIncidents = [...threadIncidents, ...runIncidents].sort(newestFirst);
	const open = allIncidents.filter((incident) => {
		if (incident.resolvedAt) {
			return false;
		}
		if (incident.kind === "thread") {
			return true;
		}
		const started = Date.parse(incident.at);
		return !Number.isNaN(started) && now - started <= OPEN_RUN_WINDOW_MS;
	});

	const affected = new Set<string>();
	for (const incident of open) {
		for (const agentId of incident.agentIds) {
			affected.add(agentId);
		}
	}

	const starts = dayStarts(now, UPTIME_DAYS);
	const tallies = tallyDays(snapshot);
	const component = (agent: InterfaceAgent): StatusComponent => {
		const days = uptimeDays(tallies.get(agent.id), starts);
		let state: ComponentState = "operational";
		if (affected.has(agent.id)) {
			state = "degraded";
		} else if (agent.status === "working") {
			state = "working";
		}
		return { agent, days, state, uptime: uptimeShare(days) };
	};

	const placed = new Set<string>();
	const sections: StatusSection[] = [];
	for (const group of snapshot.groups) {
		if (group.kind !== "team") {
			continue;
		}
		const members: StatusComponent[] = [];
		for (const agentId of group.memberAgentIds) {
			const agent = agents.get(agentId);
			if (agent && !placed.has(agentId)) {
				placed.add(agentId);
				members.push(component(agent));
			}
		}
		if (members.length > 0) {
			sections.push({
				components: members,
				group,
				state: worstState(members.map((member) => member.state)),
			});
		}
	}
	const loose = snapshot.agents
		.filter((agent) => !placed.has(agent.id))
		.map(component);
	if (loose.length > 0) {
		sections.push({
			components: loose,
			group: null,
			state: worstState(loose.map((member) => member.state)),
		});
	}

	const maintenance: StatusMaintenance[] = events
		.filter((event) => {
			const start = Date.parse(event.start);
			return event.kind === "upcoming" && !Number.isNaN(start);
		})
		.sort((a, b) => a.start.localeCompare(b.start))
		.map((event) => ({
			affected: event.agentId
				? (agents.get(event.agentId)?.name ?? null)
				: null,
			count: event.count && event.count > 1 ? event.count : null,
			id: event.id,
			schedule: event.label,
			start: event.start,
			title: event.title,
		}));

	const history = dayStarts(now, HISTORY_DAYS)
		.reverse()
		.map((start) => {
			const key = localDayKey(new Date(start));
			return {
				incidents: allIncidents.filter(
					(incident) => dayKeyOf(incident.at) === key
				),
				key,
				start,
			};
		});

	return {
		history,
		incidents: open,
		maintenance,
		overall: overallState(open, affected.size),
		sections,
	};
}

/** Plain-language summary of one day, for the bar tooltip and its label. */
export function describeDay(day: UptimeDay): string {
	if (day.level === "operational") {
		return `${DAY_LEVEL_LABELS.operational} on this day.`;
	}
	const count = day.problems.length;
	return `${DAY_LEVEL_LABELS[day.level]}: ${count} ${count === 1 ? "failed run" : "failed runs"}.`;
}

/** What the day saw besides failures ("3 threads active, 1 scheduled run"). */
export function describeActivity(day: UptimeDay): string | null {
	const parts: string[] = [];
	if (day.active > 0) {
		parts.push(
			`${day.active} ${day.active === 1 ? "thread" : "threads"} active`
		);
	}
	if (day.successfulRuns > 0) {
		parts.push(
			`${day.successfulRuns} scheduled ${day.successfulRuns === 1 ? "run" : "runs"} succeeded`
		);
	}
	return parts.length > 0 ? parts.join(", ") : null;
}
