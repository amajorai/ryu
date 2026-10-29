import {
	type InterfaceAgent,
	type InterfaceEvent,
	type InterfaceGroup,
	type InterfaceSnapshot,
	type InterfaceThread,
	localDayKey,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { agentById } from "./interface-renderer.ts";

/** The three places Panels can show: Home, the persistent Chat, Projects. */
export type PanelsView = "chat" | "home" | "projects";

export const PANELS_VIEWS: readonly PanelsView[] = ["home", "chat", "projects"];

export const PANELS_VIEW_LABELS: Record<PanelsView, string> = {
	chat: "Chat",
	home: "Home",
	projects: "Projects",
};

export function isPanelsView(value: unknown): value is PanelsView {
	return PANELS_VIEWS.some((view) => view === value);
}

// ---------------------------------------------------------------------------
// Sky: where the sun or moon sits for the local time of day
// ---------------------------------------------------------------------------

export type SkyPhase = "dawn" | "day" | "dusk" | "night";

export interface SkyState {
	/** Height above the horizon, 0 (on it) to 1 (overhead). */
	altitude: number;
	body: "moon" | "sun";
	phase: SkyPhase;
	/** Position along its arc, 0 (rising, left) to 1 (setting, right). */
	progress: number;
}

const SUNRISE_HOUR = 6;
const SUNSET_HOUR = 19;
const DAY_HOURS = SUNSET_HOUR - SUNRISE_HOUR;
const NIGHT_HOURS = 24 - DAY_HOURS;

function hourOf(date: Date): number {
	return date.getHours() + date.getMinutes() / 60;
}

export function skyPhase(date: Date): SkyPhase {
	const hour = hourOf(date);
	if (hour >= 5 && hour < 8) {
		return "dawn";
	}
	if (hour >= 8 && hour < 17) {
		return "day";
	}
	if (hour >= 17 && hour < 20) {
		return "dusk";
	}
	return "night";
}

/** The sun crosses the sky from 6:00 to 19:00; the moon has the rest. */
export function skyAt(date: Date): SkyState {
	const hour = hourOf(date);
	const daytime = hour >= SUNRISE_HOUR && hour < SUNSET_HOUR;
	const progress = daytime
		? (hour - SUNRISE_HOUR) / DAY_HOURS
		: (((hour - SUNSET_HOUR + 24) % 24) / NIGHT_HOURS) % 1;
	return {
		// A parabola, so the body sits exactly on the drawn (quadratic) arc.
		altitude: 4 * progress * (1 - progress),
		body: daytime ? "sun" : "moon",
		phase: skyPhase(date),
		progress,
	};
}

/**
 * The greeting over the sky. Evening runs to 2 AM, the usual end of a late
 * evening; between then and 5 AM the page says "Good night" instead.
 */
export function panelsGreeting(date: Date): string {
	const hour = date.getHours();
	if (hour >= 2 && hour < 5) {
		return "Good night";
	}
	if (hour >= 5 && hour < 12) {
		return "Good morning";
	}
	if (hour >= 12 && hour < 17) {
		return "Good afternoon";
	}
	return "Good evening";
}

// ---------------------------------------------------------------------------
// Shared lookups
// ---------------------------------------------------------------------------

export function byRecency(a: InterfaceThread, b: InterfaceThread): number {
	return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

export function threadAgents(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread
): InterfaceAgent[] {
	return thread.agentIds
		.map((id) => agentById(snapshot, id))
		.filter((agent): agent is InterfaceAgent => agent !== undefined);
}

export function groupById(
	snapshot: InterfaceSnapshot,
	id: string | null
): InterfaceGroup | undefined {
	return id ? snapshot.groups.find((group) => group.id === id) : undefined;
}

/**
 * Who a thread is "with", in a sentence: the team for a team thread with more
 * than one agent, otherwise its lead agent.
 */
export function threadCounterpart(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread
): string | null {
	const team = groupById(snapshot, thread.teamId);
	if (team && thread.agentIds.length > 1) {
		return team.name;
	}
	return threadAgents(snapshot, thread)[0]?.name ?? team?.name ?? null;
}

export function recentThreads(
	snapshot: InterfaceSnapshot,
	limit: number
): InterfaceThread[] {
	return [...snapshot.threads].sort(byRecency).slice(0, limit);
}

/** The newest thread this agent is part of. */
export function latestThreadFor(
	snapshot: InterfaceSnapshot,
	agentId: string
): InterfaceThread | undefined {
	return [...snapshot.threads]
		.filter((thread) => thread.agentIds.includes(agentId))
		.sort(byRecency)[0];
}

/**
 * The first full sentence of a message, so a one-line detail never stops
 * mid-thought. Falls back to the whole (trimmed) text when it has no break.
 */
export function firstSentence(text: string): string {
	const line = text.trim().split("\n")[0]?.trim() ?? "";
	const match = line.match(/^(.+?[.!?])(?=\s|$)/);
	return match?.[1] ?? line;
}

/** One line for a thread's newest message, or a plain fallback. */
export function threadExcerpt(thread: InterfaceThread): string {
	const line = thread.lastMessage?.trim();
	if (!line) {
		return "No messages yet";
	}
	return thread.lastMessageRole === "user" ? `You: ${line}` : line;
}

export function lowerFirst(text: string): string {
	return text ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

function trimSentence(text: string): string {
	return text.trim().replace(/[.!?]+$/, "");
}

// ---------------------------------------------------------------------------
// Action cards: one-tap suggestions where the verb is the button
// ---------------------------------------------------------------------------

export type PanelsActionKind = "ask" | "follow-up" | "reply" | "retry";

/** What tapping an action does: open a thread, or start one with an agent. */
export type PanelsTarget =
	| { agentId: string; kind: "start" }
	| { kind: "open"; threadId: string };

export interface PanelsAction {
	agentId: string | null;
	/** Supporting line under the sentence: the newest message or a role. */
	detail: string | null;
	id: string;
	kind: PanelsActionKind;
	/** The words after the verb, before the subject ("to Atlas about"). */
	rest: string;
	/** The full sentence, used as the button's accessible name. */
	sentence: string;
	status: ThreadStatus | null;
	/** Emphasised object of the sentence, usually the thread title. */
	subject: string | null;
	target: PanelsTarget;
	/** RFC 3339 time the suggestion is about, for an age stamp. */
	updatedAt: string | null;
	verb: string;
}

const ACTION_LIMIT = 4;

/**
 * How many suggestions each status may contribute, most urgent first. Live
 * runs are left out: the Working now panel right below already lists them.
 * Threads waiting on an agent come last, after asks: the user has nothing to
 * do there, so they only fill a row that would otherwise stay short.
 */
const ACTION_QUOTA: [ThreadStatus, number][] = [
	["attention", 2],
	["your-turn", 2],
];
const WAITING_QUOTA = 1;

function possessive(name: string): string {
	return name.endsWith("s") ? `${name}'` : `${name}'s`;
}

function threadAction(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread,
	status: ThreadStatus
): PanelsAction | null {
	const who = threadCounterpart(snapshot, thread);
	const lead = threadAgents(snapshot, thread)[0];
	let verb: string;
	let rest: string;
	let kind: PanelsActionKind;
	if (status === "attention") {
		kind = "retry";
		verb = "Retry";
		rest = who ? `${possessive(who)} failed run on` : "the failed run on";
	} else if (status === "your-turn") {
		kind = "reply";
		verb = "Reply";
		rest = who ? `to ${who} about` : "about";
	} else if (status === "waiting") {
		if (!who) {
			return null;
		}
		kind = "follow-up";
		verb = "Follow up";
		rest = `with ${who} on`;
	} else {
		return null;
	}
	const subject = trimSentence(thread.title);
	return {
		agentId: lead?.id ?? null,
		detail: thread.lastMessage
			? firstSentence(thread.lastMessage) || null
			: null,
		id: `thread:${thread.id}`,
		kind,
		rest,
		sentence: `${verb} ${rest} ${subject}`,
		status,
		subject,
		target: { kind: "open", threadId: thread.id },
		updatedAt: thread.updatedAt,
		verb,
	};
}

function askAction(agent: InterfaceAgent): PanelsAction {
	const topic = trimSentence(agent.description);
	const rest = topic ? `${agent.name} about ${lowerFirst(topic)}` : agent.name;
	return {
		agentId: agent.id,
		detail: null,
		id: `agent:${agent.id}`,
		kind: "ask",
		rest,
		sentence: `Ask ${rest}`,
		status: null,
		subject: null,
		target: { agentId: agent.id, kind: "start" },
		updatedAt: null,
		verb: "Ask",
	};
}

function takeThreadActions(
	snapshot: InterfaceSnapshot,
	sorted: InterfaceThread[],
	status: ThreadStatus,
	quota: number,
	actions: PanelsAction[],
	limit: number
): void {
	let taken = 0;
	for (const thread of sorted) {
		if (taken >= quota || actions.length >= limit) {
			return;
		}
		if (threadStatus(thread) !== status) {
			continue;
		}
		const action = threadAction(snapshot, thread, status);
		if (action) {
			actions.push(action);
			taken += 1;
		}
	}
}

/**
 * Up to four suggestions, most urgent first: retry failures, reply where an
 * agent answered, start a thread with an idle agent you have not talked to
 * yet, then check on an ask the agent has not answered.
 */
export function buildPanelsActions(
	snapshot: InterfaceSnapshot,
	limit: number = ACTION_LIMIT
): PanelsAction[] {
	const sorted = [...snapshot.threads].sort(
		(a, b) => Number(b.pinned) - Number(a.pinned) || byRecency(a, b)
	);
	const actions: PanelsAction[] = [];
	for (const [status, quota] of ACTION_QUOTA) {
		takeThreadActions(snapshot, sorted, status, quota, actions, limit);
	}
	const talkedTo = new Set(
		snapshot.threads.flatMap((thread) => thread.agentIds)
	);
	for (const agent of snapshot.agents) {
		if (actions.length >= limit) {
			break;
		}
		if (!talkedTo.has(agent.id) && agent.status === "idle") {
			actions.push(askAction(agent));
		}
	}
	takeThreadActions(snapshot, sorted, "waiting", WAITING_QUOTA, actions, limit);
	return actions.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Panels: working now, upcoming runs, agents, recent activity
// ---------------------------------------------------------------------------

export function workingThreads(snapshot: InterfaceSnapshot): InterfaceThread[] {
	return snapshot.threads.filter((thread) => thread.running).sort(byRecency);
}

export function upcomingRuns(
	snapshot: InterfaceSnapshot,
	now: number,
	limit = 4
): InterfaceEvent[] {
	return (snapshot.events ?? [])
		.filter(
			(event) => event.kind === "upcoming" && Date.parse(event.start) >= now
		)
		.sort((a, b) => a.start.localeCompare(b.start))
		.slice(0, limit);
}

export function lastRun(
	snapshot: InterfaceSnapshot,
	now: number
): InterfaceEvent | undefined {
	return (snapshot.events ?? [])
		.filter((event) => event.kind === "past" && Date.parse(event.start) <= now)
		.sort((a, b) => b.start.localeCompare(a.start))[0];
}

export interface PanelsAgentRow {
	agent: InterfaceAgent;
	/** What the row says beside the name: the agent's role. */
	line: string;
	/** The agent's state as the row shows it. */
	status: ThreadStatus | null;
	target: PanelsTarget;
	thread: InterfaceThread | undefined;
}

function agentRank(row: PanelsAgentRow): number {
	if (row.status === "working") {
		return 0;
	}
	return row.status === "attention" || row.status === "your-turn" ? 1 : 2;
}

/**
 * Working agents first (so a live run is never the row a short list drops),
 * then agents waiting on you, then by their latest conversation. Each row names the agent's role rather than a thread title,
 * since the panels around it already list the conversations.
 */
export function buildAgentRows(snapshot: InterfaceSnapshot): PanelsAgentRow[] {
	const live = workingThreads(snapshot);
	const rows = snapshot.agents.map((agent): PanelsAgentRow => {
		const working = live.find((thread) => thread.agentIds.includes(agent.id));
		const thread = working ?? latestThreadFor(snapshot, agent.id);
		let status: ThreadStatus | null = thread ? threadStatus(thread) : null;
		if (agent.status === "working") {
			status = "working";
		}
		return {
			agent,
			line: trimSentence(agent.description) || "No role set",
			status,
			target: thread
				? { kind: "open", threadId: thread.id }
				: { agentId: agent.id, kind: "start" },
			thread,
		};
	});
	return rows.sort((a, b) => {
		const rank = agentRank(a) - agentRank(b);
		if (rank !== 0) {
			return rank;
		}
		const aTime = a.thread?.updatedAt ?? "";
		const bTime = b.thread?.updatedAt ?? "";
		return (
			bTime.localeCompare(aTime) || a.agent.name.localeCompare(b.agent.name)
		);
	});
}

// ---------------------------------------------------------------------------
// Recent activity: what happened, as events rather than a thread list
// ---------------------------------------------------------------------------

export type PanelsActivityKind = "failed" | "finished" | "replied" | "wrote";

export interface PanelsActivity {
	/** Who or what acted, emphasised at the start of the line. */
	actor: string;
	agent: InterfaceAgent | undefined;
	/** RFC 3339 time it happened. */
	at: string;
	/** What it was about: the conversation or the run's agent. */
	context: string | null;
	id: string;
	kind: PanelsActivityKind;
	target: PanelsTarget | null;
	verb: string;
}

function threadActivity(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread
): PanelsActivity {
	const who = threadCounterpart(snapshot, thread);
	const fromYou = thread.lastMessageRole === "user";
	return {
		actor: fromYou ? "You" : (who ?? "An agent"),
		agent: threadAgents(snapshot, thread)[0],
		at: thread.updatedAt,
		context: trimSentence(thread.title),
		id: `thread:${thread.id}`,
		kind: fromYou ? "wrote" : "replied",
		target: { kind: "open", threadId: thread.id },
		verb: fromYou ? `wrote${who ? ` to ${who}` : ""}` : "replied",
	};
}

function runActivity(
	snapshot: InterfaceSnapshot,
	event: InterfaceEvent
): PanelsActivity {
	const agent = agentById(snapshot, event.agentId);
	const failed = event.outcome === "failure";
	return {
		actor: event.title,
		agent,
		at: event.end ?? event.start,
		context: agent?.name ?? null,
		id: `run:${event.id}`,
		kind: failed ? "failed" : "finished",
		target: runTarget(snapshot, event),
		verb: failed ? "failed" : "finished",
	};
}

/**
 * The newest things that happened, newest first: replies and your messages in
 * conversations that are not live (Working now lists those), and finished or
 * failed scheduled runs.
 */
export function activityItems(
	snapshot: InterfaceSnapshot,
	now: number,
	limit = 5
): PanelsActivity[] {
	const items: PanelsActivity[] = [];
	for (const thread of snapshot.threads) {
		if (!thread.running && thread.lastMessage?.trim()) {
			items.push(threadActivity(snapshot, thread));
		}
	}
	for (const event of snapshot.events ?? []) {
		if (event.kind === "past" && Date.parse(event.start) <= now) {
			items.push(runActivity(snapshot, event));
		}
	}
	return items
		.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
		.slice(0, limit);
}

/**
 * The conversation that is "with" an agent: its newest one-to-one thread, or
 * failing that the newest thread it is part of.
 */
export function agentThreadFor(
	snapshot: InterfaceSnapshot,
	agentId: string
): InterfaceThread | undefined {
	const own = [...snapshot.threads]
		.filter(
			(thread) => thread.agentIds.length === 1 && thread.agentIds[0] === agentId
		)
		.sort(byRecency)[0];
	return own ?? latestThreadFor(snapshot, agentId);
}

/** Where a scheduled run goes: its agent's own thread, or a new one. */
export function runTarget(
	snapshot: InterfaceSnapshot,
	event: InterfaceEvent
): PanelsTarget | null {
	if (!event.agentId) {
		return null;
	}
	const thread = agentThreadFor(snapshot, event.agentId);
	return thread
		? { kind: "open", threadId: thread.id }
		: { agentId: event.agentId, kind: "start" };
}

export interface PanelsSummary {
	needsYou: number;
	working: number;
}

export function panelsSummary(snapshot: InterfaceSnapshot): PanelsSummary {
	let needsYou = 0;
	let working = 0;
	for (const thread of snapshot.threads) {
		const status = threadStatus(thread);
		if (status === "attention" || status === "your-turn") {
			needsYou += 1;
		} else if (status === "working") {
			working += 1;
		}
	}
	return { needsYou, working };
}

const SPELLED = [
	"No",
	"One",
	"Two",
	"Three",
	"Four",
	"Five",
	"Six",
	"Seven",
	"Eight",
	"Nine",
];

function spell(count: number): string {
	return SPELLED[count] ?? String(count);
}

/** One calm sentence under the greeting. */
export function summarySentence(summary: PanelsSummary): string {
	const { needsYou, working } = summary;
	if (needsYou === 0 && working === 0) {
		return "Nothing needs you right now.";
	}
	const parts: string[] = [];
	if (needsYou > 0) {
		parts.push(
			`${spell(needsYou)} ${needsYou === 1 ? "conversation needs" : "conversations need"} you`
		);
	}
	if (working > 0) {
		const lead =
			parts.length > 0 ? spell(working).toLowerCase() : spell(working);
		parts.push(`${lead} ${working === 1 ? "agent is" : "agents are"} working`);
	}
	return `${parts.join(", and ")}.`;
}

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function clockTime(date: Date): string {
	return new Intl.DateTimeFormat(undefined, {
		hour: "numeric",
		minute: "2-digit",
	}).format(date);
}

function minutesUntil(delta: number): number {
	return Math.min(59, Math.max(1, Math.round(delta / MINUTE)));
}

/** A run's start split for a two-line time column: "3:30 PM" over "Today". */
export function runWhenParts(
	iso: string,
	now: number
): { day: string; time: string } {
	const start = Date.parse(iso);
	if (Number.isNaN(start)) {
		return { day: "", time: "" };
	}
	const date = new Date(start);
	const delta = start - now;
	const time = clockTime(date);
	if (delta >= 0 && delta < HOUR) {
		return { day: `in ${minutesUntil(delta)}m`, time };
	}
	if (localDayKey(date) === localDayKey(new Date(now))) {
		return { day: "Today", time };
	}
	if (localDayKey(date) === localDayKey(new Date(now + DAY))) {
		return { day: "Tomorrow", time };
	}
	const day =
		delta > 0 && delta < 6 * DAY
			? new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(date)
			: new Intl.DateTimeFormat(undefined, {
					day: "numeric",
					month: "short",
				}).format(date);
	return { day, time };
}

/** "in 40m", "Today, 3:30 PM", "Tomorrow, 9:00 AM", "Fri, 5:00 PM", "Oct 23". */
export function runWhen(iso: string, now: number): string {
	const start = Date.parse(iso);
	if (Number.isNaN(start)) {
		return "";
	}
	const delta = start - now;
	if (delta >= 0 && delta < HOUR) {
		return `in ${minutesUntil(delta)}m`;
	}
	const date = new Date(start);
	const today = localDayKey(new Date(now));
	if (localDayKey(date) === today) {
		return `Today, ${clockTime(date)}`;
	}
	if (localDayKey(date) === localDayKey(new Date(now + DAY))) {
		return `Tomorrow, ${clockTime(date)}`;
	}
	if (delta > 0 && delta < 6 * DAY) {
		const weekday = new Intl.DateTimeFormat(undefined, {
			weekday: "short",
		}).format(date);
		return `${weekday}, ${clockTime(date)}`;
	}
	return new Intl.DateTimeFormat(undefined, {
		day: "numeric",
		month: "short",
	}).format(date);
}

/** "Wednesday, October 14" for the Home header. */
export function longDate(date: Date): string {
	return new Intl.DateTimeFormat(undefined, {
		day: "numeric",
		month: "long",
		weekday: "long",
	}).format(date);
}

export function shortClock(date: Date): string {
	return clockTime(date);
}

// ---------------------------------------------------------------------------
// Projects: each project or team as a topic with its conversations
// ---------------------------------------------------------------------------

export interface PanelsTopic {
	group: InterfaceGroup | null;
	id: string;
	members: InterfaceAgent[];
	name: string;
	threads: InterfaceThread[];
}

/** Projects first, then teams, then everything filed under neither. */
export function buildTopics(snapshot: InterfaceSnapshot): PanelsTopic[] {
	const groups = [...snapshot.groups].sort(
		(a, b) =>
			Number(a.kind === "team") - Number(b.kind === "team") ||
			a.name.localeCompare(b.name)
	);
	const projectIds = new Set(
		groups.filter((group) => group.kind === "project").map((group) => group.id)
	);
	const order = (a: InterfaceThread, b: InterfaceThread) =>
		Number(b.pinned) - Number(a.pinned) || byRecency(a, b);
	const topics: PanelsTopic[] = groups.map((group) => ({
		group,
		id: group.id,
		members: group.memberAgentIds
			.map((id) => agentById(snapshot, id))
			.filter((agent): agent is InterfaceAgent => agent !== undefined),
		name: group.name,
		threads: snapshot.threads
			.filter((thread) =>
				group.kind === "project"
					? thread.projectId === group.id
					: thread.teamId === group.id &&
						!(thread.projectId && projectIds.has(thread.projectId))
			)
			.sort(order),
	}));
	const known = new Set(groups.map((group) => group.id));
	const loose = snapshot.threads
		.filter(
			(thread) =>
				!(
					(thread.projectId && known.has(thread.projectId)) ||
					(thread.teamId && known.has(thread.teamId))
				)
		)
		.sort(order);
	if (loose.length > 0) {
		topics.push({
			group: null,
			id: "other",
			members: [],
			name: "Other conversations",
			threads: loose,
		});
	}
	return topics;
}

// ---------------------------------------------------------------------------
// Panel header actions: one quiet link per panel, each to a different thread
// ---------------------------------------------------------------------------

/** A panel's header link: short visible text and a full accessible name. */
export interface PanelsHeaderAction {
	label: string;
	target: PanelsTarget;
	text: string;
}

export interface PanelsHeaderActions {
	activity: PanelsHeaderAction | null;
	agents: PanelsHeaderAction | null;
	upcoming: PanelsHeaderAction | null;
	working: PanelsHeaderAction | null;
}

function needsYou(
	thread: InterfaceThread | undefined
): thread is InterfaceThread {
	if (!thread) {
		return false;
	}
	const status = threadStatus(thread);
	return status === "attention" || status === "your-turn";
}

/** "Reply in <title>", or "Retry <title>" for a failed run. */
function replyIn(thread: InterfaceThread): PanelsHeaderAction {
	const title = trimSentence(thread.title);
	const text =
		threadStatus(thread) === "attention"
			? `Retry ${title}`
			: `Reply in ${title}`;
	return { label: text, target: { kind: "open", threadId: thread.id }, text };
}

/**
 * Each panel's header link, named by the thread it opens. Working now watches
 * its newest run; the others reply where a thread is waiting on you, and no
 * two panels point at the same thread. A panel with nothing waiting on you
 * shows no link rather than a reply to an agent that is busy or idle.
 */
export function panelHeaderActions(
	snapshot: InterfaceSnapshot,
	now: number
): PanelsHeaderActions {
	const used = new Set<string>();
	const claim = (
		thread: InterfaceThread | undefined
	): PanelsHeaderAction | null => {
		if (!needsYou(thread) || used.has(thread.id)) {
			return null;
		}
		used.add(thread.id);
		return replyIn(thread);
	};
	const firstClaim = (
		threads: Iterable<InterfaceThread | undefined>
	): PanelsHeaderAction | null => {
		for (const thread of threads) {
			const action = claim(thread);
			if (action) {
				return action;
			}
		}
		return null;
	};
	const live = workingThreads(snapshot)[0];
	const working: PanelsHeaderAction | null = live
		? {
				label: `Watch ${trimSentence(live.title)}`,
				target: { kind: "open", threadId: live.id },
				text: "Watch",
			}
		: null;
	const agents = firstClaim(buildAgentRows(snapshot).map((row) => row.thread));
	const replied: InterfaceThread[] = [];
	for (const item of activityItems(snapshot, now)) {
		const target = item.target;
		if (item.kind !== "replied" || target?.kind !== "open") {
			continue;
		}
		const thread = snapshot.threads.find(
			(candidate) => candidate.id === target.threadId
		);
		if (thread) {
			replied.push(thread);
		}
	}
	const activity = firstClaim(replied);
	const upcoming = firstClaim(
		upcomingRuns(snapshot, now).map((event) =>
			event.agentId ? agentThreadFor(snapshot, event.agentId) : undefined
		)
	);
	return { activity, agents, upcoming, working };
}
